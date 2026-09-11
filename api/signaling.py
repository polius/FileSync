import os
import re
import time
import json
import asyncio
import logging
import ipaddress
from typing import Dict, Optional
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

logger = logging.getLogger("filesync.signaling")


# =========================================================================================
# WebRTC signaling
#
# A thin WebSocket relay between peers. Each connected client claims a peer id and can ask
# the server to forward arbitrary "signal" payloads (SDP offers/answers, ICE candidates)
# to another peer by id. The server treats payloads as opaque JSON.
#
# Scope: single-worker, in-memory. Horizontal scaling would need cross-worker pub/sub (e.g.
# Redis) so a 'signal' message landing on worker A can find its target peer on worker B.
# The current FileSync Dockerfile starts a single uvicorn worker, so in-memory is sufficient.
# =========================================================================================

# id charset matches what /api/uuid produces (UUIDv4 with dashes) plus generic alphanumeric
# ids so manually-chosen ids also work. Length-bounded to make the registry cheap.
_PEER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Hard limits
_MAX_PAYLOAD_BYTES = 32 * 1024           # 32 KiB per incoming message
_MAX_MSG_PER_SECOND = 100                # per-connection rate limit (all message types)
_PAIR_WINDOW_SECONDS = 10.0              # sliding-window length for per-target rate limit
_PAIR_MAX_PER_WINDOW = 50                # max signal msgs from one source to one target per window
_REGISTER_TIMEOUT_SECONDS = 10.0         # first message must arrive within this window
_IDLE_TIMEOUT_SECONDS = 30.0             # close if no message at all (clients ping every 10s)
_MAX_CONNECTIONS = int(os.getenv("FILESYNC_MAX_WS", "10000"))

# Custom WebSocket close codes (1000-2999 reserved by RFC; 4000-4999 free for app use)
_CLOSE_INVALID_REGISTER = 4400
_CLOSE_UNAVAILABLE_ID   = 4409
_CLOSE_INVALID_MESSAGE  = 4401
_CLOSE_RATE_LIMITED     = 4429
_CLOSE_IDLE             = 4408
_CLOSE_OVERLOADED       = 4503


class _PeerRegistry:
    """In-memory map peer_id -> WebSocket. Single-worker only."""

    def __init__(self) -> None:
        self._peers: Dict[str, WebSocket] = {}
        self._lock = asyncio.Lock()

    async def register(self, peer_id: str, ws: WebSocket) -> Optional[WebSocket]:
        """Atomically claim a peer id. The new ws always wins — if an entry already
        exists, the displaced WebSocket is returned to the caller for cleanup.

        Rationale: this is a P2P file-sharing app, not an account system. The peer id is
        derived client-side from /api/uuid and isn't a long-lived credential. The common
        case for "id already taken" is a stale connection from the same client whose TCP
        close hasn't been detected by the server yet — typically after a mobile network
        switch or a brief blip. Without takeover, the client would have to wait for the
        idle timeout to expire (30 s) before they could reconnect. With takeover, the
        reconnect is immediate.

        Security note: a peer who knows another peer's id (i.e., is already in the same
        room) can kick them off the signaling socket by registering with that id. The
        attacker still cannot impersonate inside an established WebRTC connection (DTLS
        protects it). The room id stays the access boundary."""
        async with self._lock:
            displaced = self._peers.get(peer_id)
            self._peers[peer_id] = ws
            return displaced

    async def unregister(self, peer_id: str, ws: WebSocket) -> None:
        """Remove the entry only if it still points at this websocket. Safe under
        takeover: a displaced ws's later unregister becomes a no-op because the slot
        now points at the replacement."""
        async with self._lock:
            if self._peers.get(peer_id) is ws:
                del self._peers[peer_id]

    def lookup(self, peer_id: str) -> Optional[WebSocket]:
        return self._peers.get(peer_id)

    def size(self) -> int:
        return len(self._peers)


_REGISTRY = _PeerRegistry()


def _is_valid_peer_id(value) -> bool:
    return isinstance(value, str) and bool(_PEER_ID_RE.match(value))


async def _send_json_safe(ws: WebSocket, payload: dict) -> bool:
    """Send a JSON message, swallowing connection errors."""
    try:
        await ws.send_json(payload)
        return True
    except Exception:
        return False


async def _receive_text_with_timeout(ws: WebSocket, timeout: float) -> Optional[str]:
    try:
        return await asyncio.wait_for(ws.receive_text(), timeout=timeout)
    except asyncio.TimeoutError:
        return None
    except (WebSocketDisconnect, RuntimeError):
        return None


# =========================================================================================
# ICE candidate rewriting
#
# coturn runs in a Docker bridge network and so advertises its bridge IP (typically
# 172.x.x.x or 10.x.x.x) as the relay address in TURN allocation responses. Clients
# outside Docker cannot route to that IP, so any transfer that needs to fall back to
# TURN relay would silently fail.
#
# The fix lives at the signaling layer: when relaying a 'candidate' signal of type
# 'relay' whose address is a private/loopback IP, substitute the address that the
# *receiving* client used to reach this server. Because rewriting happens per-recipient,
# a LAN client and an Internet client connected to the same server will each see a
# relay candidate pointing at the IP that works for them — something a static
# --external-ip on coturn could never achieve.
#
# Only relay candidates with private/loopback addresses are touched. Host candidates
# (peer's local IP) and srflx candidates (STUN-reflexive public IP) are independently
# correct; we forward them verbatim. If coturn one day advertises a public IP directly
# (e.g. host networking, manual --external-ip), we don't second-guess it.
# =========================================================================================

# Strict parse of an SDP candidate line. Capture groups, in order:
#   1: foundation+component+protocol+priority (everything up to the address)
#   2: connection-address
#   3: port
#   4: candidate type
#   5: optional trailing attributes (may include raddr/rport which we also rewrite)
_CANDIDATE_RE = re.compile(
    r"^(candidate:\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(\d+)\s+typ\s+(\S+)\s*(.*)$"
)
_RADDR_RE = re.compile(r"\braddr\s+(\S+)")


def _is_private_or_loopback(addr: str) -> bool:
    """True if `addr` is an IPv4/IPv6 literal in a private, loopback, or link-local range
    that an external client cannot route to. mDNS .local hostnames also count — they're
    intentionally unresolvable across networks and only ever appear in host candidates,
    not relay candidates, so we treat them as 'not reachable from outside' just in case."""
    if not addr:
        return False
    if addr.endswith('.local'):
        return True
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified


def _client_host_hint(ws: WebSocket) -> Optional[str]:
    """Return the hostname/IP this client used to reach the server, derived from the
    Host header it sent on the WebSocket upgrade. This is the IP the client knows the
    server by — which by definition is the IP coturn-on-this-server should be reachable
    at from this client's vantage point.

    Strips port (we keep the relay port from coturn unchanged) and an optional IPv6
    bracket. Returns None on malformed input."""
    host = ws.headers.get('host') if ws and ws.headers else None
    if not host:
        return None
    # Strip [ipv6]:port or host:port -> hostname/IP only
    if host.startswith('['):
        end = host.find(']')
        if end < 0:
            return None
        inner = host[1:end]
        try:
            ipaddress.ip_address(inner)  # must be a bare IPv6 literal, reject '[:]' etc.
        except ValueError:
            return None
        return inner
    if ':' in host:
        host = host.split(':', 1)[0]
    return host or None


def _rewrite_candidate_line(line: str, new_addr: str) -> str:
    """Substitute the connection-address and any raddr in a candidate line."""
    m = _CANDIDATE_RE.match(line)
    if not m:
        return line  # unparseable — pass through unchanged
    prefix, _addr, port, ctype, tail = m.groups()
    tail = _RADDR_RE.sub(f'raddr {new_addr}', tail) if tail else tail
    rebuilt = f"{prefix} {new_addr} {port} typ {ctype}"
    if tail:
        rebuilt = f"{rebuilt} {tail}"
    return rebuilt


def _maybe_rewrite_signal_payload(payload, target_ws: WebSocket):
    """If payload is an ICE candidate of type 'relay' with a private/loopback address,
    return a shallow-copied payload with the address rewritten to the host the target
    client used. Otherwise return the original payload unchanged.

    Safety: if anything is shaped unexpectedly, return the original payload. This must
    never reject a signal — at worst it passes through with the original (broken) IP,
    same behavior as before this function existed."""
    if not isinstance(payload, dict):
        return payload
    if payload.get('kind') != 'candidate':
        return payload
    cand = payload.get('candidate')
    if not isinstance(cand, dict):
        return payload
    line = cand.get('candidate')
    if not isinstance(line, str) or 'typ relay' not in line:
        return payload

    m = _CANDIDATE_RE.match(line)
    if not m:
        return payload
    current_addr = m.group(2)
    if not _is_private_or_loopback(current_addr):
        return payload  # already a routable address; trust it

    new_host = _client_host_hint(target_ws)
    if not new_host or new_host == current_addr:
        return payload

    rewritten_line = _rewrite_candidate_line(line, new_host)
    if rewritten_line == line:
        return payload

    # Shallow-clone the payload so we don't mutate the sender's view. The cand object
    # itself we clone too because both senders and other receivers of this signal could
    # still hold references (none do today, but cheap insurance).
    new_cand = dict(cand)
    new_cand['candidate'] = rewritten_line
    if isinstance(new_cand.get('address'), str) and _is_private_or_loopback(new_cand['address']):
        new_cand['address'] = new_host
    new_payload = dict(payload)
    new_payload['candidate'] = new_cand
    return new_payload


router = APIRouter()


@router.websocket("/ws")
async def signaling(websocket: WebSocket):
    # Capacity check before accept — refuse early under overload.
    if _REGISTRY.size() >= _MAX_CONNECTIONS:
        await websocket.close(code=_CLOSE_OVERLOADED, reason="Server at capacity.")
        return

    await websocket.accept()

    peer_id: Optional[str] = None
    # Global per-connection rate limit: timestamps of recent messages (any type).
    msg_timestamps: list[float] = []
    # Per-target rate limit: target_peer_id -> recent signal timestamps. Bounds how fast
    # one source can send signals to any single target, mitigating offer-spam DoS where
    # an attacker burns the target's WebRTC/TURN resources by repeatedly initiating
    # connections. Lives on the per-connection state so it dies with the source ws.
    pair_timestamps: Dict[str, list[float]] = {}

    try:
        # ---- Phase 1: register -----------------------------------------------------------
        raw = await _receive_text_with_timeout(websocket, _REGISTER_TIMEOUT_SECONDS)
        if raw is None:
            await websocket.close(code=_CLOSE_INVALID_REGISTER, reason="Register timeout.")
            return
        if len(raw) > _MAX_PAYLOAD_BYTES:
            await websocket.close(code=_CLOSE_INVALID_REGISTER, reason="Register too large.")
            return
        try:
            first = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            await _send_json_safe(websocket, {"type": "error", "code": "invalid-message", "message": "Malformed JSON."})
            await websocket.close(code=_CLOSE_INVALID_REGISTER)
            return
        if not isinstance(first, dict) or first.get("type") != "register":
            await _send_json_safe(websocket, {"type": "error", "code": "invalid-message", "message": "First message must be 'register'."})
            await websocket.close(code=_CLOSE_INVALID_REGISTER)
            return
        candidate_id = first.get("id")
        if not _is_valid_peer_id(candidate_id):
            await _send_json_safe(websocket, {"type": "error", "code": "invalid-id", "message": "Peer id format is invalid."})
            await websocket.close(code=_CLOSE_INVALID_REGISTER)
            return
        displaced = await _REGISTRY.register(candidate_id, websocket)
        if displaced is not None:
            # Same id already registered — kick the old one. See _PeerRegistry.register
            # for the rationale.
            try:
                await displaced.close(code=_CLOSE_UNAVAILABLE_ID, reason="Replaced by a new registration.")
            except Exception:
                pass
        peer_id = candidate_id
        await _send_json_safe(websocket, {"type": "registered", "id": peer_id})

        # ---- Phase 2: relay loop ---------------------------------------------------------
        while True:
            raw = await _receive_text_with_timeout(websocket, _IDLE_TIMEOUT_SECONDS)
            if raw is None:
                # Idle — clean shutdown
                try:
                    await websocket.close(code=_CLOSE_IDLE, reason="Idle timeout.")
                except Exception:
                    pass
                return
            # Rate limit. Counted before the size check so oversize frames can't be
            # streamed indefinitely without ever tripping the limiter. (The transport
            # itself caps frame size via uvicorn's --ws-max-size, so a single frame
            # can never buffer more than that.)
            now = time.monotonic()
            msg_timestamps.append(now)
            window_start = now - 1.0
            msg_timestamps[:] = [t for t in msg_timestamps if t >= window_start]
            if len(msg_timestamps) > _MAX_MSG_PER_SECOND:
                await _send_json_safe(websocket, {"type": "error", "code": "rate-limited", "message": "Too many messages."})
                await websocket.close(code=_CLOSE_RATE_LIMITED)
                return

            if len(raw) > _MAX_PAYLOAD_BYTES:
                await _send_json_safe(websocket, {"type": "error", "code": "invalid-message", "message": "Message too large."})
                continue

            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                await _send_json_safe(websocket, {"type": "error", "code": "invalid-message", "message": "Malformed JSON."})
                continue
            if not isinstance(msg, dict):
                await _send_json_safe(websocket, {"type": "error", "code": "invalid-message", "message": "Message must be an object."})
                continue

            mtype = msg.get("type")
            if mtype == "signal":
                target_id = msg.get("to")
                payload = msg.get("payload")
                if not _is_valid_peer_id(target_id):
                    await _send_json_safe(websocket, {"type": "error", "code": "invalid-message", "message": "'to' must be a valid peer id."})
                    continue

                # Per-(source, target) sliding-window rate limit. Drops abusive offer
                # spam without affecting legitimate connection setup (a single SDP
                # exchange + ICE candidates is well under the cap).
                pair_window_start = now - _PAIR_WINDOW_SECONDS
                pair_recent = pair_timestamps.setdefault(target_id, [])
                pair_recent[:] = [t for t in pair_recent if t >= pair_window_start]
                if len(pair_recent) >= _PAIR_MAX_PER_WINDOW:
                    await _send_json_safe(websocket, {"type": "error", "code": "rate-limited", "message": f"Too many signals to peer {target_id!r}."})
                    continue
                pair_recent.append(now)
                # Opportunistic cleanup: prune empty buckets so the map doesn't grow.
                if len(pair_timestamps) > 256:
                    pair_timestamps = {k: v for k, v in pair_timestamps.items() if v}

                target_ws = _REGISTRY.lookup(target_id)
                if target_ws is None:
                    await _send_json_safe(websocket, {"type": "peer-unavailable", "id": target_id})
                    continue
                # The only non-opaque inspection we do on payloads: ICE relay candidates
                # from coturn carry the container's Docker-internal IP, which the target
                # client can't route to. Rewrite that address (and only that address) to
                # match the IP the target used to reach us. See the dedicated section
                # above for the rationale.
                outbound_payload = _maybe_rewrite_signal_payload(payload, target_ws)
                await _send_json_safe(target_ws, {"type": "signal", "from": peer_id, "payload": outbound_payload})
            elif mtype == "ping":
                await _send_json_safe(websocket, {"type": "pong"})
            else:
                await _send_json_safe(websocket, {"type": "error", "code": "invalid-message", "message": f"Unknown type: {mtype!r}."})

    except WebSocketDisconnect:
        pass
    except Exception:
        # Defensive: never let the handler crash silently.
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR, reason="Server error.")
        except Exception:
            pass
        # Log with traceback; uvicorn captures it.
        logger.exception("signaling: unhandled error for peer %r", peer_id)
    finally:
        if peer_id is not None:
            await _REGISTRY.unregister(peer_id, websocket)

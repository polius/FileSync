import os
import re
import hmac
import time
import json
import base64
import socket
import asyncio
import hashlib
import logging
import ipaddress
from dataclasses import dataclass
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
# Ownership: a peer id is claimed with a client-generated secret token (see
# _PeerRegistry.register). The room id *is* the host's peer id and travels in the share
# link, so knowing an id must not be enough to take it over.
#
# Scope: single-worker, in-memory. Horizontal scaling would need cross-worker pub/sub (e.g.
# Redis) so a 'signal' message landing on worker A can find its target peer on worker B.
# The current FileSync Dockerfile starts a single uvicorn worker, so in-memory is sufficient.
# =========================================================================================

# id charset matches what crypto.randomUUID() produces (UUIDv4 with dashes) plus generic
# alphanumeric ids so manually-chosen ids also work. Length-bounded to make the registry
# cheap. Matched with fullmatch(): a bare `$` would also accept a trailing newline.
_PEER_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
# Claim token: a client-generated random secret. The lower bound keeps it unguessable;
# the upper bound keeps hashing it cheap.
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{16,128}")

# Hard limits
_MAX_PAYLOAD_BYTES = 32 * 1024           # 32 KiB per incoming message
_MAX_MSG_PER_SECOND = 100                # per-connection rate limit (all message types)
_PAIR_WINDOW_SECONDS = 10.0              # sliding-window length for per-target rate limit
_PAIR_MAX_PER_WINDOW = 50                # max signal msgs from one source to one target per window
_REGISTER_TIMEOUT_SECONDS = 10.0         # first message must arrive within this window
# Coarse backstop; real liveness is uvicorn's WS ping/pong (see the Dockerfile CMD).
_IDLE_TIMEOUT_SECONDS = 300.0            # 5 min: tolerate 1-wake/min hidden-tab throttling
_MAX_CONNECTIONS = int(os.getenv("FILESYNC_MAX_WS", "10000"))
# How long a disconnected owner keeps its id reserved: long enough to survive a network
# blip or a page refresh, short enough that an abandoned id frees up soon.
_CLAIM_GRACE_SECONDS = float(os.getenv("FILESYNC_CLAIM_GRACE_SECONDS", "120"))
# Claims outlive their sockets by the grace period, so they need their own bound. Live
# claims never exceed _MAX_CONNECTIONS; the headroom is for ids waiting out their grace.
_MAX_CLAIMS_PER_CONNECTION = 2
# Room-existence oracle: a 'peer-unavailable' reply tells the sender an id is offline.
# Bound how many of those one connection can collect; a real client misses a handful of
# times at most (a host that left, a stale link), never dozens per minute.
_UNAVAILABLE_WINDOW_SECONDS = 60.0
_UNAVAILABLE_MAX_PER_WINDOW = 30
# Targets a connection already reached stay reachable once its lookup budget runs out;
# this caps that per-connection set (a real client talks to a few peers, not hundreds).
_MAX_REACHED_TARGETS = 256

# Host-header cache for ICE relay rewriting; bounded (attacker-controlled key).
_HOST_CACHE_MAX = 1024
_HOST_CACHE_TTL_SECONDS = 600.0

# Custom WebSocket close codes (1000-2999 reserved by RFC; 4000-4999 free for app use)
_CLOSE_INVALID_REGISTER = 4400
_CLOSE_UNAVAILABLE_ID   = 4409   # newcomer rejected: another session owns this id
_CLOSE_REPLACED         = 4410   # owner displaced by its own newer session (same token)
_CLOSE_INVALID_MESSAGE  = 4401
_CLOSE_RATE_LIMITED     = 4429
_CLOSE_IDLE             = 4408
_CLOSE_OVERLOADED       = 4503


# Outcomes of _PeerRegistry.register
_REGISTER_OK = "ok"
_REGISTER_TAKEN = "taken"
_REGISTER_FULL = "full"


@dataclass
class _Claim:
    """Ownership of one peer id. `ws` is the live socket, or None while the owner is
    disconnected; `expires` (monotonic) only matters in that disconnected state."""
    token_hash: str
    ws: Optional[WebSocket]
    expires: float = 0.0

    def is_held(self, now: float) -> bool:
        return self.ws is not None or now < self.expires


def _hash_token(token: str) -> str:
    # Only the digest is kept, so a memory dump of the registry can't be replayed.
    return hashlib.sha256(token.encode()).hexdigest()


class _PeerRegistry:
    """In-memory map peer_id -> claim (token hash + live WebSocket). Single-worker only."""

    def __init__(self) -> None:
        self._claims: Dict[str, _Claim] = {}
        # Every accepted socket, registered or not.
        self._connections = 0
        self._lock = asyncio.Lock()

    async def acquire(self) -> bool:
        """Reserve a connection slot. Returns False when at capacity."""
        async with self._lock:
            if self._connections >= _MAX_CONNECTIONS:
                return False
            self._connections += 1
            return True

    async def release(self) -> None:
        async with self._lock:
            if self._connections > 0:
                self._connections -= 1

    def _max_claims(self) -> int:
        return _MAX_CLAIMS_PER_CONNECTION * _MAX_CONNECTIONS

    def _purge_expired(self, now: float) -> None:
        for key in [k for k, c in self._claims.items() if not c.is_held(now)]:
            del self._claims[key]

    async def register(self, peer_id: str, token: str,
                       ws: WebSocket) -> tuple[str, Optional[WebSocket]]:
        """Atomically claim a peer id with a secret token. Returns (outcome, displaced):

        - _REGISTER_OK: the id is now owned by `ws`. `displaced` is the owner's previous
          live socket when the same token reconnects; the caller closes it.
        - _REGISTER_TAKEN: another token holds the id (connected, or disconnected but
          still inside its grace period). The newcomer loses; the owner is untouched.
        - _REGISTER_FULL: the claim table is at capacity even after purging expired
          claims, and this id has no claim to reuse.

        Rationale: the room id is the host's peer id and is public (it's in the share
        link), so "first to register wins, same token may reconnect" is what keeps
        a link holder from hijacking the room. The same-token takeover keeps the fast
        reconnect the previous last-writer-wins design existed for: after a mobile
        network switch or a brief blip, the server may not have noticed the old TCP
        connection die yet, and the real owner must not wait for the idle timeout
        (up to _IDLE_TIMEOUT_SECONDS) to get its id back.

        Security note: the token never leaves the owner's browser except on this
        socket, and only its sha256 is kept. Someone who knows only the id cannot
        displace the owner, and cannot grab the id while the owner is briefly offline
        either (the claim survives _CLAIM_GRACE_SECONDS after disconnect). DTLS still
        protects established WebRTC connections independently of signaling."""
        token_hash = _hash_token(token)
        async with self._lock:
            now = time.monotonic()
            claim = self._claims.get(peer_id)
            if claim is not None and claim.is_held(now):
                # Constant-time compare: the digest is not secret per se, but there's no
                # reason to hand out a timing side channel on it.
                if not hmac.compare_digest(claim.token_hash, token_hash):
                    return _REGISTER_TAKEN, None
                displaced = claim.ws
                claim.ws = ws
                return _REGISTER_OK, displaced
            if claim is None and len(self._claims) >= self._max_claims():
                self._purge_expired(now)
                if len(self._claims) >= self._max_claims():
                    return _REGISTER_FULL, None
            self._claims[peer_id] = _Claim(token_hash=token_hash, ws=ws)
            return _REGISTER_OK, None

    async def unregister(self, peer_id: str, ws: WebSocket) -> None:
        """Start the claim's grace period, but only if this websocket still owns it.
        Safe under takeover: a displaced ws's later unregister becomes a no-op because
        the claim now points at the replacement."""
        async with self._lock:
            claim = self._claims.get(peer_id)
            if claim is not None and claim.ws is ws:
                claim.ws = None
                claim.expires = time.monotonic() + _CLAIM_GRACE_SECONDS

    def lookup(self, peer_id: str) -> Optional[WebSocket]:
        claim = self._claims.get(peer_id)
        return claim.ws if claim is not None else None

    def size(self) -> int:
        """Connected peers (claims with a live socket)."""
        return sum(1 for c in self._claims.values() if c.ws is not None)

    def claims(self) -> int:
        """All claims, including ids reserved for a disconnected owner."""
        return len(self._claims)

    def connections(self) -> int:
        return self._connections


_REGISTRY = _PeerRegistry()


def registry_stats() -> Dict[str, int]:
    """Snapshot of signaling capacity, surfaced by the /health endpoint."""
    return {
        "registered_peers": _REGISTRY.size(),
        "claims": _REGISTRY.claims(),
        "connections": _REGISTRY.connections(),
        "max_connections": _MAX_CONNECTIONS,
    }


def _is_valid_peer_id(value) -> bool:
    return isinstance(value, str) and bool(_PEER_ID_RE.fullmatch(value))


def _is_valid_token(value) -> bool:
    return isinstance(value, str) and bool(_TOKEN_RE.fullmatch(value))


def _is_too_large(raw: str) -> bool:
    # The limit is on bytes on the wire; a str counts code points, and a multi-byte
    # payload could otherwise be up to 4x the intended size.
    return len(raw.encode()) > _MAX_PAYLOAD_BYTES


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
# Server configuration and TURN credentials
#
# ICE servers travel over the signaling socket: in the 'registered' reply, and on demand
# via an 'ice' message for long-lived sessions whose credentials are about to expire.
# This replaces the old /api/credentials JWT endpoint, saving a round trip, and binds
# the credentials to the peer id that just proved ownership of its claim.
#
# Credentials follow coturn's REST scheme (--use-auth-secret): username is
# "<unix expiry>:<peer id>" and the password is base64(HMAC-SHA1(secret, username)).
# coturn recomputes the HMAC with the shared secret and rejects expired usernames, so
# there's no state to share between this process and coturn beyond the key.
# =========================================================================================

def _env_port(name: str, default: Optional[int]) -> Optional[int]:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        port = int(raw)
    except ValueError:
        port = 0
    if not 1 <= port <= 65535:
        raise RuntimeError(f"{name}={raw!r} is not a valid port.")
    return port


def _env_ip(name: str) -> Optional[str]:
    raw = os.getenv(name)
    if not raw:
        return None
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        raise RuntimeError(f"{name}={raw!r} is not an IP address literal.") from None


# Read once at import: a typo should stop the server at startup, not surface later as
# broken TURN for every client.
_TURN_TTL_SECONDS = int(os.getenv("FILESYNC_TURN_TTL_SECONDS", "3600"))
_TURN_HOST = os.getenv("TURN_HOST") or None   # default: the host the client connected to
_TURN_PORT = _env_port("TURN_PORT", 3478)
# Public IP for relay candidates; overrides the per-recipient Host-header address.
_TURN_EXTERNAL_IP = _env_ip("TURN_EXTERNAL_IP")

# Injected by api.main via configure(): the secret lives with the app's startup checks
# (load_secret), and tests can configure the router without importing main.
_SECRET_KEY: Optional[str] = None
_APP_VERSION = "dev"


def configure(secret_key: str, version: str) -> None:
    """Set the TURN signing secret and the version string sent in 'registered'."""
    global _SECRET_KEY, _APP_VERSION
    _SECRET_KEY = secret_key
    _APP_VERSION = version


def _turn_credentials(peer_id: str, ttl: int) -> tuple[str, str]:
    if not _SECRET_KEY:
        # Fail loudly (the handler turns this into a 1011 close) rather than hand out
        # credentials coturn will reject.
        raise RuntimeError("signaling.configure() was not called: no TURN secret.")
    username = f"{int(time.time()) + ttl}:{peer_id}"
    digest = hmac.new(_SECRET_KEY.encode(), username.encode(), hashlib.sha1).digest()
    return username, base64.b64encode(digest).decode()


def _url_host(host: str) -> str:
    """Bracket IPv6 literals so 'turn:H:P' stays parseable."""
    try:
        if ipaddress.ip_address(host).version == 6:
            return f"[{host}]"
    except ValueError:
        pass
    return host


def _ice_config(ws: WebSocket, peer_id: str) -> dict:
    """iceServers + ttl for this client. The TURN host defaults to whatever hostname the
    client used to reach us: coturn shares this server's address, and that name is by
    definition one the client can resolve and route to."""
    ttl = _TURN_TTL_SECONDS
    host = _TURN_HOST or _client_host_hint(ws)
    if not host:
        # No Host header (non-browser client): nothing sensible to point at. The client
        # can still connect directly or over its own STUN servers.
        return {"iceServers": [], "ttl": ttl}
    h = _url_host(host)
    username, credential = _turn_credentials(peer_id, ttl)
    turn_urls = [f"turn:{h}:{_TURN_PORT}", f"turn:{h}:{_TURN_PORT}?transport=tcp"]
    return {
        "iceServers": [
            {"urls": f"stun:{h}:{_TURN_PORT}"},
            {"urls": turn_urls, "username": username, "credential": credential},
        ],
        "ttl": ttl,
    }


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
#
# Override: when TURN_EXTERNAL_IP is set, private relay addresses are rewritten to that
# IP for every recipient instead. The Host-header guess is wrong whenever clients reach
# the web app through something coturn doesn't share an address with (a CDN, a tunnel,
# a load balancer on another IP); the operator then states the public IP explicitly.
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


# Hostname -> (monotonic timestamp, IPv4); age- and size-bounded (attacker-controlled key).
_host_resolutions: Dict[str, tuple] = {}


async def _resolve_host(host: str) -> Optional[str]:
    """Resolve a hostname to an IPv4 literal; uses loop.getaddrinfo (never blocks)."""
    now = time.monotonic()
    cached = _host_resolutions.get(host)
    if cached is not None and now - cached[0] < _HOST_CACHE_TTL_SECONDS:
        return cached[1]
    result: Optional[str] = None
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(
            host, None, family=socket.AF_INET, type=socket.SOCK_DGRAM
        )
        if infos:
            result = infos[0][4][0]
    except OSError:
        result = None
    if len(_host_resolutions) >= _HOST_CACHE_MAX:
        cutoff = now - _HOST_CACHE_TTL_SECONDS
        for key in [k for k, (ts, _) in _host_resolutions.items() if ts < cutoff]:
            del _host_resolutions[key]
        if len(_host_resolutions) >= _HOST_CACHE_MAX:
            _host_resolutions.clear()
    _host_resolutions[host] = (now, result)
    return result


async def _candidate_target_address(ws: WebSocket) -> Optional[str]:
    """The relay address the target client can route to: the IP it used to reach this
    server. Chrome rejects ICE candidates whose connection-address is a hostname, so
    the Host header must be resolved to a literal before substitution."""
    host = _client_host_hint(ws)
    if not host:
        return None
    try:
        ipaddress.ip_address(host)
        return host  # already an IP literal
    except ValueError:
        return await _resolve_host(host)


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


async def _maybe_rewrite_signal_payload(payload, target_ws: WebSocket):
    """If payload is an ICE candidate of type 'relay' with a private/loopback address,
    return a shallow-copied payload with the address rewritten to TURN_EXTERNAL_IP if
    set, else to the host the target client used. Otherwise return the original payload
    unchanged.

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

    new_host = _TURN_EXTERNAL_IP or await _candidate_target_address(target_ws)
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
    # Reserve a slot before accept to refuse early under overload.
    if not await _REGISTRY.acquire():
        await websocket.close(code=_CLOSE_OVERLOADED, reason="Server at capacity.")
        return

    peer_id: Optional[str] = None
    # Global per-connection rate limit: timestamps of recent messages (any type).
    msg_timestamps: list[float] = []
    # Per-target rate limit: target_peer_id -> recent signal timestamps. Bounds how fast
    # one source can send signals to any single target, mitigating offer-spam DoS where
    # an attacker burns the target's WebRTC/TURN resources by repeatedly initiating
    # connections. Lives on the per-connection state so it dies with the source ws.
    pair_timestamps: Dict[str, list[float]] = {}
    # Room-existence oracle budget: timestamps of recent 'peer-unavailable' replies, and
    # the targets this connection has actually reached (see the 'signal' branch).
    unavailable_timestamps: list[float] = []
    reached_targets: set[str] = set()

    try:
        await websocket.accept()

        # ---- Phase 1: register -----------------------------------------------------------
        raw = await _receive_text_with_timeout(websocket, _REGISTER_TIMEOUT_SECONDS)
        if raw is None:
            await websocket.close(code=_CLOSE_INVALID_REGISTER, reason="Register timeout.")
            return
        if _is_too_large(raw):
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
        token = first.get("token")
        if not _is_valid_token(token):
            await _send_json_safe(websocket, {"type": "error", "code": "invalid-token", "message": "Claim token is missing or malformed."})
            await websocket.close(code=_CLOSE_INVALID_REGISTER)
            return
        outcome, displaced = await _REGISTRY.register(candidate_id, token, websocket)
        if outcome == _REGISTER_TAKEN:
            # Someone else owns this id. Reject the newcomer, never the owner: see
            # _PeerRegistry.register for the rationale.
            await _send_json_safe(websocket, {"type": "error", "code": "unavailable-id", "message": "This id is in use."})
            await websocket.close(code=_CLOSE_UNAVAILABLE_ID)
            return
        if outcome == _REGISTER_FULL:
            await websocket.close(code=_CLOSE_OVERLOADED, reason="Server at capacity.")
            return
        # From here on the finally block owns the claim's cleanup.
        peer_id = candidate_id
        if displaced is not None:
            # Same token, older socket: the owner reconnected (or opened the app in a
            # second tab). A distinct code lets that older tab say "opened elsewhere"
            # instead of retrying into a takeover loop.
            try:
                await displaced.close(code=_CLOSE_REPLACED, reason="Replaced by a newer session.")
            except Exception:
                pass
        await _send_json_safe(websocket, {
            "type": "registered",
            "id": peer_id,
            "version": _APP_VERSION,
            "ice": _ice_config(websocket, peer_id),
        })

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

            if _is_too_large(raw):
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

                # Room-existence oracle: once this connection has used up its budget of
                # 'peer-unavailable' replies, a signal to any target it hasn't already
                # reached gets 'rate-limited' whether or not the target exists. Answering
                # only the misses would still leak existence (miss = error, hit = silence).
                unavailable_window_start = now - _UNAVAILABLE_WINDOW_SECONDS
                unavailable_timestamps[:] = [t for t in unavailable_timestamps if t >= unavailable_window_start]
                if (len(unavailable_timestamps) >= _UNAVAILABLE_MAX_PER_WINDOW
                        and target_id not in reached_targets):
                    await _send_json_safe(websocket, {"type": "error", "code": "rate-limited", "message": "Too many lookups."})
                    continue

                target_ws = _REGISTRY.lookup(target_id)
                if target_ws is None:
                    unavailable_timestamps.append(now)
                    await _send_json_safe(websocket, {"type": "peer-unavailable", "id": target_id})
                    continue
                if len(reached_targets) < _MAX_REACHED_TARGETS:
                    reached_targets.add(target_id)
                # The only non-opaque inspection we do on payloads: ICE relay candidates
                # from coturn carry the container's Docker-internal IP, which the target
                # client can't route to. Rewrite that address (and only that address) to
                # match the IP the target used to reach us. See the dedicated section
                # above for the rationale.
                outbound_payload = await _maybe_rewrite_signal_payload(payload, target_ws)
                await _send_json_safe(target_ws, {"type": "signal", "from": peer_id, "payload": outbound_payload})
            elif mtype == "ice":
                # Fresh TURN credentials for a session outliving its ttl. Throttled by the
                # per-connection limiter above like every other message.
                await _send_json_safe(websocket, {"type": "ice", **_ice_config(websocket, peer_id)})
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
        await _REGISTRY.release()

"""End-to-end tests for the /ws signaling handler, driven through Starlette's TestClient.

Every test gets a fresh registry and a freshly imported api.main (so env-driven startup
config is re-read). The TestClient is entered as a context manager so all sockets share
one event loop, like they would under uvicorn.
"""
import base64
import hashlib
import hmac
import importlib
import json
import time

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from api import signaling

SECRET = "test-secret-key"
TOKEN_A = "a" * 32
TOKEN_B = "b" * 32
TOKEN_C = "c" * 32

RELAY_PRIVATE = "candidate:1 1 udp 16777215 172.18.0.2 50000 typ relay raddr 172.18.0.2 rport 50000"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("SECRET_KEY", SECRET)
    monkeypatch.delenv("APP_VERSION", raising=False)
    monkeypatch.setattr(signaling, "_REGISTRY", signaling._PeerRegistry())
    import api.main
    main = importlib.reload(api.main)
    with TestClient(main.app) as c:
        yield c


def _register(c, peer_id, token=TOKEN_A, **kwargs):
    """Open a socket, register, and return (ws_context, registered_message). The caller
    must close the context; use as `with _connected(...) as (ws, msg):` instead where
    possible."""
    ws = c.websocket_connect("/ws", **kwargs).__enter__()
    ws.send_json({"type": "register", "id": peer_id, "token": token})
    return ws, ws.receive_json()


class _connected:
    """Context manager: a registered socket. Yields (ws, registered_message)."""

    def __init__(self, c, peer_id, token=TOKEN_A, **kwargs):
        self._args = (c, peer_id, token)
        self._kwargs = kwargs

    def __enter__(self):
        self.ws, msg = _register(*self._args, **self._kwargs)
        assert msg["type"] == "registered", msg
        return self.ws, msg

    def __exit__(self, *exc):
        self.ws.__exit__(*exc)


def _expect_close(ws, code):
    with pytest.raises(WebSocketDisconnect) as info:
        ws.receive_json()
    assert info.value.code == code
    return info.value


def _wait_for(cond, timeout=2.0):
    """Server-side cleanup runs on the portal thread; poll instead of sleeping blind."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return
        time.sleep(0.005)
    raise AssertionError("condition not met in time")


def _sync(ws):
    """Round-trip a ping so every earlier message on this socket has been processed."""
    ws.send_json({"type": "ping"})
    assert ws.receive_json() == {"type": "pong"}


def _signal(ws, to, payload=None):
    ws.send_json({"type": "signal", "to": to, "payload": payload if payload is not None else {"kind": "offer"}})


def _expected_credential(username):
    return base64.b64encode(hmac.new(SECRET.encode(), username.encode(), hashlib.sha1).digest()).decode()


# =========================================================================================
# Registration
# =========================================================================================

class TestRegisterHappyPath:
    def test_registered_payload_shape(self, client):
        with _connected(client, "peer-1") as (_ws, msg):
            assert set(msg) == {"type", "id", "version", "ice"}
            assert msg["id"] == "peer-1"
            assert msg["version"] == client.app.version
            assert set(msg["ice"]) == {"iceServers", "ttl"}
            assert msg["ice"]["ttl"] == signaling._TURN_TTL_SECONDS

    def test_ice_servers_default_to_client_host(self, client):
        with _connected(client, "peer-1") as (_ws, msg):
            stun, turn = msg["ice"]["iceServers"]
            assert stun == {"urls": "stun:testserver:3478"}
            assert turn["urls"] == ["turn:testserver:3478", "turn:testserver:3478?transport=tcp"]

    def test_turn_credentials_are_valid_coturn_rest_creds(self, client):
        before = int(time.time())
        with _connected(client, "peer-1") as (_ws, msg):
            turn = msg["ice"]["iceServers"][1]
            expiry, bound_id = turn["username"].split(":", 1)
            assert bound_id == "peer-1", "credentials must be bound to the registered id"
            ttl = msg["ice"]["ttl"]
            assert before + ttl <= int(expiry) <= int(time.time()) + ttl
            assert turn["credential"] == _expected_credential(turn["username"])

    def test_turn_host_and_port_override(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_TURN_HOST", "turn.example.com")
        monkeypatch.setattr(signaling, "_TURN_PORT", 3479)
        with _connected(client, "peer-1") as (_ws, msg):
            stun, turn = msg["ice"]["iceServers"]
            assert stun["urls"] == "stun:turn.example.com:3479"
            assert turn["urls"][0] == "turn:turn.example.com:3479"

    def test_ipv6_host_is_bracketed(self, client):
        with _connected(client, "peer-1", headers={"host": "[2001:db8::1]:8443"}) as (_ws, msg):
            stun, turn = msg["ice"]["iceServers"]
            assert stun["urls"] == "stun:[2001:db8::1]:3478"
            assert turn["urls"][1] == "turn:[2001:db8::1]:3478?transport=tcp"

    def test_ipv6_turn_host_override_is_bracketed(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_TURN_HOST", "2001:db8::2")
        with _connected(client, "peer-1") as (_ws, msg):
            assert msg["ice"]["iceServers"][0]["urls"] == "stun:[2001:db8::2]:3478"

    def test_registry_tracks_peer_and_cleans_up(self, client):
        with _connected(client, "peer-1"):
            assert signaling._REGISTRY.lookup("peer-1") is not None
            assert signaling.registry_stats()["registered_peers"] == 1
        _wait_for(lambda: signaling._REGISTRY.lookup("peer-1") is None)
        _wait_for(lambda: signaling._REGISTRY.connections() == 0)
        # The claim outlives the socket (grace period).
        assert signaling.registry_stats()["claims"] == 1

    def test_unconfigured_secret_fails_closed(self, client, monkeypatch):
        # No secret -> no credentials coturn would reject; the socket closes with 1011.
        monkeypatch.setattr(signaling, "_SECRET_KEY", None)
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "register", "id": "peer-1", "token": TOKEN_A})
            _expect_close(ws, 1011)


class TestRegisterRejections:
    def _first_message(self, client, text):
        ws = client.websocket_connect("/ws").__enter__()
        ws.send_text(text)
        return ws

    @pytest.mark.parametrize("message,code", [
        ({"type": "register", "id": "bad id", "token": TOKEN_A}, "invalid-id"),
        ({"type": "register", "id": "x" * 65, "token": TOKEN_A}, "invalid-id"),
        ({"type": "register", "id": "peer\n", "token": TOKEN_A}, "invalid-id"),
        ({"type": "register", "id": "peer-1"}, "invalid-token"),
        ({"type": "register", "id": "peer-1", "token": "short"}, "invalid-token"),
        ({"type": "register", "id": "peer-1", "token": "a" * 129}, "invalid-token"),
        ({"type": "register", "id": "peer-1", "token": "a" * 31 + "!"}, "invalid-token"),
        ({"type": "register", "id": "peer-1", "token": "a" * 32 + "\n"}, "invalid-token"),
        ({"type": "register", "id": "peer-1", "token": 12345678901234567890}, "invalid-token"),
        ({"type": "signal", "to": "x"}, "invalid-message"),
        (["register"], "invalid-message"),
    ])
    def test_invalid_first_message(self, client, message, code):
        ws = self._first_message(client, json.dumps(message))
        try:
            assert ws.receive_json()["code"] == code
            _expect_close(ws, 4400)
        finally:
            ws.__exit__(None, None, None)
        assert signaling._REGISTRY.claims() == 0

    def test_malformed_json(self, client):
        with client.websocket_connect("/ws") as ws:
            ws.send_text("{not json")
            assert ws.receive_json() == {"type": "error", "code": "invalid-message", "message": "Malformed JSON."}
            _expect_close(ws, 4400)

    def test_oversized_register_is_measured_in_bytes(self, client):
        # 20k two-byte characters: under the limit in characters, over it in bytes.
        text = json.dumps({"type": "register", "id": "peer-1", "token": TOKEN_A, "pad": "é" * 20000},
                          ensure_ascii=False)
        assert len(text) < signaling._MAX_PAYLOAD_BYTES < len(text.encode())
        with client.websocket_connect("/ws") as ws:
            ws.send_text(text)
            assert _expect_close(ws, 4400).reason == "Register too large."

    def test_register_timeout(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_REGISTER_TIMEOUT_SECONDS", 0.05)
        with client.websocket_connect("/ws") as ws:
            assert _expect_close(ws, 4400).reason == "Register timeout."

    def test_connection_capacity(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_MAX_CONNECTIONS", 1)
        with _connected(client, "peer-1"):
            with pytest.raises(WebSocketDisconnect) as info:
                client.websocket_connect("/ws").__enter__()
            assert info.value.code == 4503


# =========================================================================================
# Claims: takeover, rejection, grace period, capacity
# =========================================================================================

class TestClaims:
    def test_same_token_takes_over_and_old_socket_gets_4410(self, client):
        old, _ = _register(client, "room", TOKEN_A)
        try:
            with _connected(client, "room", TOKEN_A) as (new, _msg):
                exc = _expect_close(old, 4410)
                assert exc.reason == "Replaced by a newer session."
                # Traffic for the id now reaches the newer session.
                with _connected(client, "guest", TOKEN_B) as (guest, _):
                    _signal(guest, "room", {"kind": "offer", "n": 1})
                    assert new.receive_json() == {"type": "signal", "from": "guest", "payload": {"kind": "offer", "n": 1}}
        finally:
            old.__exit__(None, None, None)

    def test_displaced_socket_cleanup_does_not_release_the_claim(self, client):
        old, _ = _register(client, "room", TOKEN_A)
        with _connected(client, "room", TOKEN_A) as (new, _msg):
            _expect_close(old, 4410)
            old.__exit__(None, None, None)
            _sync(new)
            assert signaling._REGISTRY.lookup("room") is not None

    def test_different_token_is_rejected_and_owner_keeps_working(self, client):
        with _connected(client, "room", TOKEN_A) as (owner, _):
            intruder, msg = _register(client, "room", TOKEN_B)
            try:
                assert msg == {"type": "error", "code": "unavailable-id", "message": "This id is in use."}
                _expect_close(intruder, 4409)
            finally:
                intruder.__exit__(None, None, None)
            with _connected(client, "guest", TOKEN_C) as (guest, _):
                _signal(guest, "room")
                assert owner.receive_json() == {"type": "signal", "from": "guest", "payload": {"kind": "offer"}}

    def test_grace_period_reserves_id_then_frees_it(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_CLAIM_GRACE_SECONDS", 0.3)
        with _connected(client, "room", TOKEN_A):
            pass
        _wait_for(lambda: signaling._REGISTRY.lookup("room") is None)

        # Inside the grace period: a different token is turned away...
        intruder, msg = _register(client, "room", TOKEN_B)
        intruder.__exit__(None, None, None)
        assert msg["code"] == "unavailable-id"
        # ...while the owner's token gets straight back in.
        with _connected(client, "room", TOKEN_A):
            pass
        _wait_for(lambda: signaling._REGISTRY.lookup("room") is None)

        time.sleep(0.35)
        with _connected(client, "room", TOKEN_B) as (_ws, msg):
            assert msg["id"] == "room"

    def test_expired_claim_is_replaced_in_place(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_CLAIM_GRACE_SECONDS", 0.0)
        with _connected(client, "room", TOKEN_A):
            pass
        _wait_for(lambda: signaling._REGISTRY.lookup("room") is None)
        with _connected(client, "room", TOKEN_B):
            assert signaling._REGISTRY.claims() == 1

    def test_claim_cap(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_MAX_CONNECTIONS", 1)  # cap = 2 claims
        for pid in ("a1", "a2"):
            with _connected(client, pid):
                pass
            _wait_for(lambda: signaling._REGISTRY.connections() == 0)
        assert signaling._REGISTRY.claims() == 2

        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "register", "id": "a3", "token": TOKEN_A})
            assert _expect_close(ws, 4503).reason == "Server at capacity."
        _wait_for(lambda: signaling._REGISTRY.connections() == 0)

        # An existing claim can still reconnect when the table is full.
        with _connected(client, "a1"):
            pass
        _wait_for(lambda: signaling._REGISTRY.connections() == 0)

        # Expired claims are purged to make room.
        signaling._REGISTRY._claims["a2"].expires = 0.0
        with _connected(client, "a3"):
            assert set(signaling._REGISTRY._claims) == {"a1", "a3"}

    def test_token_is_stored_hashed(self, client):
        with _connected(client, "room", TOKEN_A):
            claim = signaling._REGISTRY._claims["room"]
            assert claim.token_hash == hashlib.sha256(TOKEN_A.encode()).hexdigest()
            assert TOKEN_A not in repr(claim)


# =========================================================================================
# Relay loop
# =========================================================================================

class TestRelay:
    def test_signal_relay(self, client):
        with _connected(client, "alice", TOKEN_A) as (alice, _), _connected(client, "bob", TOKEN_B) as (bob, _):
            _signal(alice, "bob", {"kind": "answer", "sdp": "v=0"})
            assert bob.receive_json() == {"type": "signal", "from": "alice", "payload": {"kind": "answer", "sdp": "v=0"}}

    def test_peer_unavailable(self, client):
        with _connected(client, "alice") as (alice, _):
            _signal(alice, "nobody")
            assert alice.receive_json() == {"type": "peer-unavailable", "id": "nobody"}

    def test_invalid_target(self, client):
        with _connected(client, "alice") as (alice, _):
            _signal(alice, "bad id")
            assert alice.receive_json()["code"] == "invalid-message"

    def test_ping_pong(self, client):
        with _connected(client, "alice") as (alice, _):
            _sync(alice)

    def test_unknown_type(self, client):
        with _connected(client, "alice") as (alice, _):
            alice.send_json({"type": "bogus"})
            msg = alice.receive_json()
            assert msg["code"] == "invalid-message"
            assert "bogus" in msg["message"]

    def test_malformed_and_non_object_messages_keep_socket_open(self, client):
        with _connected(client, "alice") as (alice, _):
            alice.send_text("{nope")
            assert alice.receive_json()["message"] == "Malformed JSON."
            alice.send_text("[1, 2]")
            assert alice.receive_json()["message"] == "Message must be an object."
            _sync(alice)

    def test_oversized_message_is_measured_in_bytes(self, client):
        with _connected(client, "alice") as (alice, _):
            text = json.dumps({"type": "ping", "pad": "é" * 20000}, ensure_ascii=False)
            assert len(text) < signaling._MAX_PAYLOAD_BYTES
            alice.send_text(text)
            assert alice.receive_json()["message"] == "Message too large."
            _sync(alice)

    def test_ice_refresh(self, client):
        with _connected(client, "alice") as (alice, _):
            alice.send_json({"type": "ice"})
            msg = alice.receive_json()
            assert msg["type"] == "ice"
            assert set(msg) == {"type", "iceServers", "ttl"}
            turn = msg["iceServers"][1]
            assert turn["username"].endswith(":alice")
            assert turn["credential"] == _expected_credential(turn["username"])

    def test_idle_timeout(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_IDLE_TIMEOUT_SECONDS", 0.05)
        with _connected(client, "alice") as (alice, _):
            assert _expect_close(alice, 4408).reason == "Idle timeout."


class TestRateLimits:
    def test_global_rate_limit_closes_4429(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_MAX_MSG_PER_SECOND", 5)
        with _connected(client, "alice") as (alice, _):
            for _ in range(6):
                alice.send_json({"type": "ping"})
            for _ in range(5):
                assert alice.receive_json() == {"type": "pong"}
            assert alice.receive_json() == {"type": "error", "code": "rate-limited", "message": "Too many messages."}
            _expect_close(alice, 4429)

    def test_ice_refresh_is_rate_limited(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_MAX_MSG_PER_SECOND", 3)
        with _connected(client, "alice") as (alice, _):
            for _ in range(4):
                alice.send_json({"type": "ice"})
            for _ in range(3):
                assert alice.receive_json()["type"] == "ice"
            assert alice.receive_json()["code"] == "rate-limited"
            _expect_close(alice, 4429)

    def test_per_pair_rate_limit(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_PAIR_MAX_PER_WINDOW", 3)
        with _connected(client, "alice", TOKEN_A) as (alice, _), _connected(client, "bob", TOKEN_B) as (bob, _):
            for i in range(4):
                _signal(alice, "bob", {"n": i})
            msg = alice.receive_json()
            assert msg["code"] == "rate-limited"
            assert "bob" in msg["message"]
            for i in range(3):
                assert bob.receive_json()["payload"] == {"n": i}
            # Other targets are unaffected.
            _signal(alice, "carol")
            assert alice.receive_json()["type"] == "peer-unavailable"

    def test_pair_bucket_map_is_pruned(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_PAIR_WINDOW_SECONDS", 0.0)
        monkeypatch.setattr(signaling, "_UNAVAILABLE_MAX_PER_WINDOW", 10_000)
        monkeypatch.setattr(signaling, "_MAX_MSG_PER_SECOND", 10_000)
        with _connected(client, "alice") as (alice, _):
            for i in range(300):
                _signal(alice, f"t{i}")
            for i in range(300):
                assert alice.receive_json()["type"] == "peer-unavailable"

    def test_peer_unavailable_budget(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_UNAVAILABLE_MAX_PER_WINDOW", 3)
        monkeypatch.setattr(signaling, "_UNAVAILABLE_WINDOW_SECONDS", 0.3)
        with (_connected(client, "alice", TOKEN_A) as (alice, _),
              _connected(client, "bob", TOKEN_B) as (bob, _),
              _connected(client, "carol", TOKEN_C) as (carol, _)):
            # Reach bob before the budget runs out.
            _signal(alice, "bob")
            assert bob.receive_json()["from"] == "alice"
            for i in range(3):
                _signal(alice, f"missing{i}")
                assert alice.receive_json()["type"] == "peer-unavailable"

            limited = {"type": "error", "code": "rate-limited", "message": "Too many lookups."}
            _signal(alice, "missing-more")
            assert alice.receive_json() == limited
            # An existing but not-yet-reached peer gets the same answer: no oracle.
            _signal(alice, "carol")
            assert alice.receive_json() == limited
            # Peers already reached keep working; the socket stays open.
            _signal(alice, "bob")
            assert bob.receive_json()["from"] == "alice"
            _sync(alice)

            # The window rolls over.
            time.sleep(0.35)
            _signal(alice, "carol")
            assert carol.receive_json()["from"] == "alice"


class TestRelayCandidateRewrite:
    def _relay(self, client, payload):
        with _connected(client, "alice", TOKEN_A) as (alice, _), _connected(client, "bob", TOKEN_B) as (bob, _):
            _signal(alice, "bob", payload)
            return bob.receive_json()["payload"]

    def test_external_ip_override(self, client, monkeypatch):
        monkeypatch.setattr(signaling, "_TURN_EXTERNAL_IP", "198.51.100.7")

        async def _never(_host):
            raise AssertionError("Host-header resolution must be skipped when overridden")
        monkeypatch.setattr(signaling, "_resolve_host", _never)
        out = self._relay(client, {"kind": "candidate", "candidate": {"candidate": RELAY_PRIVATE, "address": "172.18.0.2"}})
        assert out["candidate"]["candidate"].startswith("candidate:1 1 udp 16777215 198.51.100.7 50000 typ relay")
        assert out["candidate"]["address"] == "198.51.100.7"

    def test_default_uses_recipient_host(self, client, monkeypatch):
        async def _resolve(host):
            assert host == "testserver"
            return "203.0.113.9"
        monkeypatch.setattr(signaling, "_resolve_host", _resolve)
        out = self._relay(client, {"kind": "candidate", "candidate": {"candidate": RELAY_PRIVATE}})
        assert " 203.0.113.9 50000 typ relay" in out["candidate"]["candidate"]


# =========================================================================================
# Startup config helpers
# =========================================================================================

class TestEnvParsing:
    def test_env_ip(self, monkeypatch):
        monkeypatch.delenv("X_IP", raising=False)
        assert signaling._env_ip("X_IP") is None
        monkeypatch.setenv("X_IP", "203.0.113.5")
        assert signaling._env_ip("X_IP") == "203.0.113.5"
        monkeypatch.setenv("X_IP", "2001:DB8::1")
        assert signaling._env_ip("X_IP") == "2001:db8::1"

    @pytest.mark.parametrize("value", ["example.com", "1.2.3", "300.1.1.1"])
    def test_env_ip_rejects_non_literals(self, monkeypatch, value):
        monkeypatch.setenv("X_IP", value)
        with pytest.raises(RuntimeError, match="X_IP"):
            signaling._env_ip("X_IP")

    def test_env_port(self, monkeypatch):
        monkeypatch.delenv("X_PORT", raising=False)
        assert signaling._env_port("X_PORT", 3478) == 3478
        assert signaling._env_port("X_PORT", None) is None
        monkeypatch.setenv("X_PORT", "5349")
        assert signaling._env_port("X_PORT", None) == 5349

    @pytest.mark.parametrize("value", ["abc", "0", "65536", "-1"])
    def test_env_port_rejects_garbage(self, monkeypatch, value):
        monkeypatch.setenv("X_PORT", value)
        with pytest.raises(RuntimeError, match="X_PORT"):
            signaling._env_port("X_PORT", 3478)

    def test_no_host_header_yields_no_ice_servers(self):
        class _NoHost:
            headers = {}
        assert signaling._ice_config(_NoHost(), "peer-1") == {"iceServers": [], "ttl": signaling._TURN_TTL_SECONDS}

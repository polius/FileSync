import asyncio
import socket
import time

import pytest

from api import signaling
from api.signaling import (
    _client_host_hint,
    _is_private_or_loopback,
    _is_valid_peer_id,
    _maybe_rewrite_signal_payload,
    _rewrite_candidate_line,
)


def _run(coro):
    """Drive a coroutine from a sync test — avoids adding an async pytest plugin."""
    return asyncio.run(coro)


def _async_return(value):
    async def _resolver(_host):
        return value
    return _resolver


class _FakeWS:
    """Minimal stand-in exposing just the headers surface signaling.py uses."""

    def __init__(self, host=None):
        self.headers = {} if host is None else {"host": host}


RELAY_PRIVATE = "candidate:1 1 udp 16777215 172.18.0.2 50000 typ relay raddr 172.18.0.2 rport 50000"
RELAY_PUBLIC = "candidate:1 1 udp 16777215 93.184.216.34 50000 typ relay"
HOST_MDNS = "candidate:1 1 udp 2122260223 6f8e2a1b.local 55555 typ host"


class TestPeerIdValidation:
    @pytest.mark.parametrize("value", [
        "5061c45a-9c36-4c55-ac61-88199c13a417",
        "abc-def-ghi",
        "A9-_",
        "x" * 64,
    ])
    def test_accepts_valid_ids(self, value):
        assert _is_valid_peer_id(value)

    @pytest.mark.parametrize("value", [
        None, 123, "", "x" * 65, "bad id", "id!", "ünïcode",
    ])
    def test_rejects_invalid_ids(self, value):
        assert not _is_valid_peer_id(value)

    def test_underscore_ids_are_accepted_by_charset(self):
        # The charset deliberately allows generic alphanumeric ids (incl. '__proto__').
        # Client-side maps are null-prototype, so such an id cannot reach
        # Object.prototype members — that defense lives in the JS, not here.
        assert _is_valid_peer_id("__proto__")


class TestPrivateLoopback:
    @pytest.mark.parametrize("addr", [
        "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.5",
        "127.0.0.1", "169.254.1.1", "0.0.0.0",
        "::1", "fe80::1", "fd00::1",
        "host.local",
    ])
    def test_unroutable_addresses(self, addr):
        assert _is_private_or_loopback(addr)

    @pytest.mark.parametrize("addr", [
        "8.8.8.8", "172.32.0.1", "93.184.216.34", "filesync.example.com",
        "host.example", "",
    ])
    def test_routable_or_non_ip_addresses(self, addr):
        assert not _is_private_or_loopback(addr)


class TestClientHostHint:
    @pytest.mark.parametrize("header,expected", [
        ("filesync.example.com:443", "filesync.example.com"),
        ("10.1.2.3:8080", "10.1.2.3"),
        ("10.1.2.3", "10.1.2.3"),
        ("[2001:db8::1]:443", "2001:db8::1"),
        ("localhost", "localhost"),
    ])
    def test_strips_port(self, header, expected):
        assert _client_host_hint(_FakeWS(header)) == expected

    @pytest.mark.parametrize("header", [None, "", "[broken", "[:]"])
    def test_malformed_headers(self, header):
        assert _client_host_hint(_FakeWS(header)) is None

    def test_missing_socket(self):
        assert _client_host_hint(None) is None


class TestRewriteCandidateLine:
    def test_rewrites_address_and_raddr(self):
        out = _rewrite_candidate_line(RELAY_PRIVATE, "filesync.example.com")
        assert out == ("candidate:1 1 udp 16777215 filesync.example.com 50000 "
                       "typ relay raddr filesync.example.com rport 50000")

    def test_preserves_port_and_type(self):
        out = _rewrite_candidate_line(RELAY_PRIVATE, "203.0.113.9")
        assert " 50000 typ relay" in out

    def test_unparseable_line_passthrough(self):
        assert _rewrite_candidate_line("not a candidate", "1.2.3.4") == "not a candidate"


class TestMaybeRewriteSignalPayload:
    def test_rewrites_private_relay_candidate(self, monkeypatch):
        # Hostnames must be resolved to a literal: Chrome rejects ICE candidates whose
        # connection-address is an FQDN.
        monkeypatch.setattr(signaling, "_resolve_host", _async_return("203.0.113.9"))
        payload = {"kind": "candidate", "candidate": {"candidate": RELAY_PRIVATE, "address": "172.18.0.2"}}
        out = _run(_maybe_rewrite_signal_payload(payload, _FakeWS("filesync.example.com:443")))
        assert out is not payload  # cloned, sender's view untouched
        assert "203.0.113.9 50000" in out["candidate"]["candidate"]
        assert out["candidate"]["address"] == "203.0.113.9"

    def test_leaves_candidate_alone_when_hostname_unresolvable(self, monkeypatch):
        monkeypatch.setattr(signaling, "_resolve_host", _async_return(None))
        payload = {"kind": "candidate", "candidate": {"candidate": RELAY_PRIVATE, "address": "172.18.0.2"}}
        assert _run(_maybe_rewrite_signal_payload(payload, _FakeWS("filesync.example.com:443"))) is payload

    def test_leaves_public_relay_candidate_alone(self):
        payload = {"kind": "candidate", "candidate": {"candidate": RELAY_PUBLIC, "address": "93.184.216.34"}}
        assert _run(_maybe_rewrite_signal_payload(payload, _FakeWS("filesync.example.com"))) is payload

    def test_leaves_non_relay_candidates_alone(self):
        payload = {"kind": "candidate", "candidate": {"candidate": HOST_MDNS, "address": "6f8e2a1b.local"}}
        assert _run(_maybe_rewrite_signal_payload(payload, _FakeWS("filesync.example.com"))) is payload

    def test_leaves_non_candidate_payloads_alone(self):
        payload = {"kind": "offer", "sdp": "v=0..."}
        assert _run(_maybe_rewrite_signal_payload(payload, _FakeWS("filesync.example.com"))) is payload

    def test_leaves_malformed_payloads_alone(self):
        for payload in [None, "string", 42, {"kind": "candidate"}, {"kind": "candidate", "candidate": "nope"}]:
            assert _run(_maybe_rewrite_signal_payload(payload, _FakeWS("filesync.example.com"))) is payload

    def test_no_host_header_passthrough(self):
        payload = {"kind": "candidate", "candidate": {"candidate": RELAY_PRIVATE}}
        assert _run(_maybe_rewrite_signal_payload(payload, _FakeWS(None))) is payload

    def test_same_address_passthrough(self):
        payload = {"kind": "candidate", "candidate": {"candidate": RELAY_PRIVATE}}
        out = _run(_maybe_rewrite_signal_payload(payload, _FakeWS("172.18.0.2:80")))
        assert out is payload


class TestResolveHost:
    """The resolver must be async (never block the loop) and its cache must be bounded."""

    def _fake_loop_getaddrinfo(self, monkeypatch, calls, answer="203.0.113.9"):
        # Bound-method signature: the patched callable is looked up on the loop instance.
        async def _gai(_self, host, *args, **kwargs):
            calls.append(host)
            return [(2, 1, 17, "", (answer, 0))]
        monkeypatch.setattr(asyncio.BaseEventLoop, "getaddrinfo", _gai, raising=True)

    def test_async_and_cached(self, monkeypatch):
        signaling._host_resolutions.clear()
        calls = []
        self._fake_loop_getaddrinfo(monkeypatch, calls)
        assert _run(signaling._resolve_host("a.example")) == "203.0.113.9"
        assert _run(signaling._resolve_host("a.example")) == "203.0.113.9"
        assert calls == ["a.example"], "second lookup must be served from cache"

    def test_cache_is_size_bounded(self, monkeypatch):
        signaling._host_resolutions.clear()
        monkeypatch.setattr(signaling, "_HOST_CACHE_MAX", 8)
        calls = []
        self._fake_loop_getaddrinfo(monkeypatch, calls)
        for i in range(50):
            _run(signaling._resolve_host(f"host{i}.example"))
        assert len(signaling._host_resolutions) <= 8, "cache must not grow past the cap"

    def test_cache_expires(self, monkeypatch):
        signaling._host_resolutions.clear()
        calls = []
        self._fake_loop_getaddrinfo(monkeypatch, calls)
        _run(signaling._resolve_host("b.example"))
        # Age the entry past the TTL and confirm it is re-resolved.
        ts, val = signaling._host_resolutions["b.example"]
        signaling._host_resolutions["b.example"] = (ts - signaling._HOST_CACHE_TTL_SECONDS - 1, val)
        _run(signaling._resolve_host("b.example"))
        assert calls == ["b.example", "b.example"], "expired entry must be re-resolved"

    def test_resolution_does_not_block_the_event_loop(self, monkeypatch):
        """A1 guard: a slow lookup must not block the event loop."""
        signaling._host_resolutions.clear()
        real_getaddrinfo = socket.getaddrinfo

        def _slow_getaddrinfo(*args, **kwargs):
            time.sleep(0.5)  # stands in for a slow / black-holed resolver
            return real_getaddrinfo("127.0.0.1", None, family=socket.AF_INET, type=socket.SOCK_DGRAM)

        monkeypatch.setattr(socket, "getaddrinfo", _slow_getaddrinfo)

        async def _scenario():
            ticks = 0

            async def _ticker():
                nonlocal ticks
                while True:
                    await asyncio.sleep(0.01)
                    ticks += 1

            task = asyncio.create_task(_ticker())
            resolved = await signaling._resolve_host("slow.example")
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            return resolved, ticks

        resolved, ticks = _run(_scenario())
        assert resolved == "127.0.0.1"
        assert ticks >= 10, f"event loop was blocked during DNS resolution (ticks={ticks})"


class TestConnectionCapacity:
    """Capacity must count accepted sockets, not just registered peers."""

    def test_acquire_counts_unregistered_and_releases(self, monkeypatch):
        monkeypatch.setattr(signaling, "_MAX_CONNECTIONS", 2)
        reg = signaling._PeerRegistry()
        assert _run(reg.acquire()) is True
        assert _run(reg.acquire()) is True
        # Two accepted-but-unregistered sockets already fill capacity.
        assert _run(reg.acquire()) is False
        assert reg.size() == 0, "no peer has registered yet"
        assert reg.connections() == 2
        _run(reg.release())
        assert _run(reg.acquire()) is True

    def test_release_never_goes_negative(self):
        reg = signaling._PeerRegistry()
        _run(reg.release())
        assert reg.connections() == 0

    def test_registry_stats_shape(self):
        stats = signaling.registry_stats()
        assert set(stats) == {"registered_peers", "connections", "max_connections"}


class TestIdleTimeoutTolerance:
    """Idle timeout is a backstop; real liveness is uvicorn's WS ping/pong (see Dockerfile)."""

    def test_idle_timeout_outlasts_background_tab_throttling(self):
        # Firefox can delay a background timer by up to 60 s, so the backstop sits above that.
        assert signaling._IDLE_TIMEOUT_SECONDS >= 120

    def test_idle_timeout_is_longer_than_register_timeout(self):
        assert signaling._IDLE_TIMEOUT_SECONDS > signaling._REGISTER_TIMEOUT_SECONDS

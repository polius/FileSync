import pytest

from api.signaling import (
    _client_host_hint,
    _is_private_or_loopback,
    _is_valid_peer_id,
    _maybe_rewrite_signal_payload,
    _rewrite_candidate_line,
)


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
    def test_rewrites_private_relay_candidate(self):
        payload = {"kind": "candidate", "candidate": {"candidate": RELAY_PRIVATE, "address": "172.18.0.2"}}
        out = _maybe_rewrite_signal_payload(payload, _FakeWS("filesync.example.com:443"))
        assert out is not payload  # cloned, sender's view untouched
        assert "filesync.example.com 50000" in out["candidate"]["candidate"]
        assert out["candidate"]["address"] == "filesync.example.com"

    def test_leaves_public_relay_candidate_alone(self):
        payload = {"kind": "candidate", "candidate": {"candidate": RELAY_PUBLIC, "address": "93.184.216.34"}}
        assert _maybe_rewrite_signal_payload(payload, _FakeWS("filesync.example.com")) is payload

    def test_leaves_non_relay_candidates_alone(self):
        payload = {"kind": "candidate", "candidate": {"candidate": HOST_MDNS, "address": "6f8e2a1b.local"}}
        assert _maybe_rewrite_signal_payload(payload, _FakeWS("filesync.example.com")) is payload

    def test_leaves_non_candidate_payloads_alone(self):
        payload = {"kind": "offer", "sdp": "v=0..."}
        assert _maybe_rewrite_signal_payload(payload, _FakeWS("filesync.example.com")) is payload

    def test_leaves_malformed_payloads_alone(self):
        for payload in [None, "string", 42, {"kind": "candidate"}, {"kind": "candidate", "candidate": "nope"}]:
            assert _maybe_rewrite_signal_payload(payload, _FakeWS("filesync.example.com")) is payload

    def test_no_host_header_passthrough(self):
        payload = {"kind": "candidate", "candidate": {"candidate": RELAY_PRIVATE}}
        assert _maybe_rewrite_signal_payload(payload, _FakeWS(None)) is payload

    def test_same_address_passthrough(self):
        payload = {"kind": "candidate", "candidate": {"candidate": RELAY_PRIVATE}}
        out = _maybe_rewrite_signal_payload(payload, _FakeWS("172.18.0.2:80"))
        assert out is payload

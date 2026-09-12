import asyncio

import pytest
from fastapi.testclient import TestClient

import api.main as main
from api.main import app, credentials


class _FakeClient:
    """Minimal stand-in for Starlette's Request.client (same convention as _FakeWS
    in tests/test_signaling.py)."""

    def __init__(self, host):
        self.host = host


class _FakeRequest:
    """Exposes just the `.client.host` surface `credentials()` reads."""

    def __init__(self, host):
        self.client = _FakeClient(host)


class _FakeClock:
    """Controllable stand-in for time.monotonic, so tests never depend on real
    wall-clock timing."""

    def __init__(self, start=1_000_000.0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def fake_clock(monkeypatch):
    clock = _FakeClock()
    monkeypatch.setattr(main.time, "monotonic", clock)
    return clock


@pytest.fixture(autouse=True)
def _reset_credentials_state():
    """Rate-limit state is module-level and persists across tests in the same
    process; give every test a clean slate."""
    main._credentials_requests.clear()
    yield
    main._credentials_requests.clear()


client = TestClient(app)


class TestCredentialsRateLimit:
    def test_requests_under_limit_succeed(self, fake_clock):
        for _ in range(main._CREDENTIALS_RATE_LIMIT):
            resp = client.get("/credentials")
            assert resp.status_code == 200
            assert "token" in resp.json()

    def test_request_over_limit_is_rejected(self, fake_clock):
        for _ in range(main._CREDENTIALS_RATE_LIMIT):
            assert client.get("/credentials").status_code == 200
        resp = client.get("/credentials")
        assert resp.status_code == 429

    def test_limit_resets_after_window_elapses(self, fake_clock):
        for _ in range(main._CREDENTIALS_RATE_LIMIT):
            assert client.get("/credentials").status_code == 200
        assert client.get("/credentials").status_code == 429

        fake_clock.advance(main._CREDENTIALS_RATE_WINDOW + 1)
        assert client.get("/credentials").status_code == 200


class TestCredentialsMapGrowthBound:
    def test_stale_ip_entries_are_evicted_once_cap_exceeded(self, fake_clock):
        # TestClient always presents the same source IP for every request, so simulating
        # thousands of distinct source IPs isn't practical via HTTP calls. Seed the
        # module's internal dict directly instead, and invoke the (undecorated, still
        # plain-async) route function directly.
        stale_cutoff = fake_clock.now - main._CREDENTIALS_RATE_WINDOW - 1
        num_stale = main._CREDENTIALS_MAX_TRACKED_IPS + 10
        main._credentials_requests.update(
            {f"203.0.113.{i}": [stale_cutoff] for i in range(num_stale)}
        )
        main._credentials_requests["198.51.100.1"] = [fake_clock.now]  # fresh, must survive

        result = asyncio.run(credentials(_FakeRequest("192.0.2.1")))

        assert "token" in result
        assert len(main._credentials_requests) == 2  # fresh entry + this new caller
        assert "198.51.100.1" in main._credentials_requests
        assert "192.0.2.1" in main._credentials_requests
        for i in range(num_stale):
            assert f"203.0.113.{i}" not in main._credentials_requests

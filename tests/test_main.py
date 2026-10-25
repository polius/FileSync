"""HTTP surface and startup config of api.main, plus the init_secret provisioner."""
import importlib
import os
import runpy
import stat
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from api import signaling

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_main(monkeypatch, **env):
    """(Re)import api.main under a controlled environment; startup config is read at import."""
    monkeypatch.setenv("SECRET_KEY", "test-secret-key")
    for name in ("APP_VERSION", "FILESYNC_EXPOSE_STATS", "CORS_ORIGINS", "SECRET_FILE"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    import api.main
    return importlib.reload(api.main)


@pytest.fixture
def main(monkeypatch):
    return _load_main(monkeypatch)


class TestHealth:
    def test_health_is_minimal_by_default(self, main):
        r = TestClient(main.app).get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}

    def test_health_stats_are_opt_in(self, monkeypatch):
        main = _load_main(monkeypatch, FILESYNC_EXPOSE_STATS="1")
        body = TestClient(main.app).get("/health").json()
        assert body["status"] == "ok"
        assert set(body) == {"status", "registered_peers", "claims", "connections", "max_connections"}

    def test_other_values_do_not_expose_stats(self, monkeypatch):
        main = _load_main(monkeypatch, FILESYNC_EXPOSE_STATS="true")
        assert TestClient(main.app).get("/health").json() == {"status": "ok"}


class TestRemovedSurface:
    @pytest.mark.parametrize("path", ["/", "/uuid", "/credentials"])
    def test_removed_routes_404(self, main, path):
        assert TestClient(main.app).get(path).status_code == 404

    @pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"])
    def test_docs_disabled(self, main, path):
        assert TestClient(main.app).get(path).status_code == 404

    def test_pyjwt_dropped_from_requirements(self):
        reqs = (REPO_ROOT / "api" / "requirements.txt").read_text().lower()
        assert "pyjwt" not in reqs


class TestVersion:
    def test_version_from_env(self, monkeypatch):
        main = _load_main(monkeypatch, APP_VERSION="9.9.9-test")
        assert main.app.version == "9.9.9-test"
        assert signaling._APP_VERSION == "9.9.9-test", "version must reach the 'registered' reply"

    def test_version_defaults_to_dev(self, main, monkeypatch):
        monkeypatch.delenv("APP_VERSION", raising=False)
        assert main.load_version() == "dev"
        monkeypatch.setenv("APP_VERSION", "  ")
        assert main.load_version() == "dev", "a blank env var means no version"


class TestLoadSecret:
    def test_env_secret(self, main, monkeypatch):
        monkeypatch.setenv("SECRET_KEY", "abc")
        assert main.load_secret() == "abc"

    def test_placeholder_rejected(self, main, monkeypatch):
        monkeypatch.setenv("SECRET_KEY", "<SECRET_KEY>")
        with pytest.raises(RuntimeError, match="placeholder"):
            main.load_secret()

    def test_secret_file(self, main, monkeypatch, tmp_path):
        monkeypatch.delenv("SECRET_KEY")
        path = tmp_path / "secret"
        path.write_text("from-file\n")
        monkeypatch.setenv("SECRET_FILE", str(path))
        assert main.load_secret() == "from-file"

    def test_empty_secret_file(self, main, monkeypatch, tmp_path):
        monkeypatch.delenv("SECRET_KEY")
        path = tmp_path / "secret"
        path.write_text("  \n")
        monkeypatch.setenv("SECRET_FILE", str(path))
        with pytest.raises(RuntimeError, match="empty"):
            main.load_secret()

    def test_no_secret(self, main, monkeypatch):
        monkeypatch.delenv("SECRET_KEY")
        with pytest.raises(RuntimeError, match="No signing secret"):
            main.load_secret()

    def test_startup_configures_signaling(self, main):
        assert signaling._SECRET_KEY == "test-secret-key"


class TestCors:
    def test_cors_off_by_default(self, main):
        r = TestClient(main.app).get("/health", headers={"Origin": "http://localhost:5173"})
        assert "access-control-allow-origin" not in r.headers

    def test_cors_origins(self, monkeypatch):
        main = _load_main(monkeypatch, CORS_ORIGINS="http://localhost:5173, ")
        r = TestClient(main.app).get("/health", headers={"Origin": "http://localhost:5173"})
        assert r.headers["access-control-allow-origin"] == "http://localhost:5173"


class TestInitSecret:
    def _run(self, monkeypatch, path):
        monkeypatch.setenv("SECRET_FILE", str(path))
        runpy.run_module("api.init_secret", run_name="__main__")

    def test_generates_once_and_is_idempotent(self, monkeypatch, tmp_path):
        path = tmp_path / "secret"
        self._run(monkeypatch, path)
        key = path.read_text()
        assert len(key) == 64 and int(key, 16) >= 0
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o644
        self._run(monkeypatch, path)
        assert path.read_text() == key, "an existing key must never be rotated"

    def test_heals_permissions(self, monkeypatch, tmp_path):
        path = tmp_path / "secret"
        path.write_text("k" * 64)
        os.chmod(path, 0o600)
        self._run(monkeypatch, path)
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o644

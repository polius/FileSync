import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import signaling
from api.signaling import router as signaling_router, registry_stats

# SECRET_KEY signs the TURN HMAC credentials handed out over the signaling socket. The
# env var wins (docker run, CI, dev); the compose files instead set SECRET_FILE, pointing
# at the key the init service generates into the shared volume. Refuse to start without
# either rather than failing later at request time.
def load_secret() -> str:
    key = os.getenv("SECRET_KEY")
    if key:
        if key == "<SECRET_KEY>":
            # Publicly known value: running with it would let anyone mint TURN credentials.
            raise RuntimeError("SECRET_KEY is the <SECRET_KEY> placeholder — this compose file is outdated. Download the current deploy/docker-compose.yml (which generates the key automatically), or set a real SECRET_KEY.")
        return key
    path = os.getenv("SECRET_FILE")
    if not path:
        raise RuntimeError("No signing secret: set SECRET_KEY, or start via docker compose (which provisions SECRET_FILE).")
    with open(path) as f:
        key = f.read().strip()
    if not key:
        raise RuntimeError(f"Secret file {path} is empty — delete the keys volume and restart the stack.")
    return key

# Release images get the version from the git tag at build time (APP_VERSION); "dev" marks
# anything else.
def load_version() -> str:
    return os.getenv("APP_VERSION", "").strip() or "dev"

SECRET_KEY = load_secret()

# Registry stats (peer and connection counts) are operational detail, not something to
# hand every visitor; opt in for monitoring.
_EXPOSE_STATS = os.getenv("FILESYNC_EXPOSE_STATS") == "1"

# Init FastAPI. The interactive docs and OpenAPI schema are off: the HTTP surface is just
# /api/health, and the schema would only map the attack surface for a scanner.
# nginx forwards /api/ unchanged, so routes carry the prefix themselves (FastAPI's
# root_path parameter is deprecated).
app = FastAPI(title='FileSync API', version=load_version(),
              docs_url=None, redoc_url=None, openapi_url=None)

# The signaling socket signs TURN credentials and reports the version on 'registered'.
signaling.configure(secret_key=SECRET_KEY, version=app.version)

# CORS is only needed when the frontend is served from a different origin than the API
# (i.e. local development). In production everything is same-origin behind the reverse
# proxy, so this stays off unless CORS_ORIGINS is explicitly set (comma-separated).
_cors_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Add health check route: liveness, plus signaling capacity when FILESYNC_EXPOSE_STATS=1.
@app.get("/api/health")
async def health_check():
    if _EXPOSE_STATS:
        return {"status": "ok", **registry_stats()}
    return {"status": "ok"}

# Mount WebRTC signaling routes (/ws). Implementation lives in api/signaling.py.
# TURN credentials and the app version travel over that socket (see 'registered').
app.include_router(signaling_router)

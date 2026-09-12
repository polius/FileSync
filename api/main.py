import os
import time
import hmac
import hashlib
import base64
import uuid
import jwt
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from api.signaling import router as signaling_router

# Get environment variables. SECRET_KEY signs both the TURN HMAC credentials and the JWT,
# so refuse to start without it rather than failing later at request time.
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY or SECRET_KEY == "<SECRET_KEY>":
    # Also reject the compose files' literal placeholder — it is a publicly known
    # value, so running with it would silently let anyone mint TURN credentials.
    raise RuntimeError("SECRET_KEY environment variable is required (replace the <SECRET_KEY> placeholder with a real secret).")

# Init FastAPI
app = FastAPI(title='FileSync API', version='4.1.0', root_path="/api")

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

# Add root route
@app.get("/")
async def root():
    return {"message": "Welcome to FileSync API!", "version": app.version}

# Add health check route
@app.get("/health")
async def health_check():
    return {"message": "FileSync API is running!"}

# Add uuid route
@app.get("/uuid")
async def uuid_check():
    return {"uuid": str(uuid.uuid4())}

# /credentials issues TURN relay credentials to anyone who can reach the API, since this
# app is deliberately account-less (see README: "No installs, no accounts") — there is no
# login/session system to gate this endpoint behind, and none is needed: TURN credentials
# are short-lived (5 min TTL below) and only useful for relaying WebRTC media, not for
# accessing any other resource.
#
# Primary protection against credential-minting floods is the reverse proxy: the supplied
# nginx.conf rate-limits `location = /api/credentials` (zone "credentials", 20r/s,
# burst=40 nodelay) before requests reach this process at all. The limiter below is a
# defense-in-depth backstop for deployments that bypass or don't use that config (FastAPI
# exposed directly, or fronted by a different reverse proxy) — it is not the primary
# control, and its numbers are intentionally generous relative to nginx's, since a
# legitimate client only needs one request roughly every 5 minutes (it caches the
# credential for the TTL below).
_CREDENTIALS_RATE_LIMIT = 10          # max requests per window per IP
_CREDENTIALS_RATE_WINDOW = 60         # seconds
_credentials_requests: dict[str, list[float]] = {}

# Cap on distinct IPs tracked at once. This map is keyed by arbitrary source IPs (unlike
# signaling.py's pair_timestamps, naturally bounded by currently-connected peers) — without
# a cap it could grow without bound for the life of the process. Each entry is tiny, so
# even this cap is a trivial amount of memory; sized well above realistic concurrent
# source-IP counts for a self-hosted instance.
_CREDENTIALS_MAX_TRACKED_IPS = 4096

# Add credentials route
@app.get("/credentials")
async def credentials(request: Request):
    # Enforce per-IP rate limit before issuing new credentials (see comment above the
    # constants for why this exists alongside nginx's rate limiting).
    client_ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    window_start = now - _CREDENTIALS_RATE_WINDOW
    recent = [t for t in _credentials_requests.get(client_ip, []) if t >= window_start]
    if len(recent) >= _CREDENTIALS_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many requests.")
    recent.append(now)
    _credentials_requests[client_ip] = recent

    # Opportunistic cleanup (same idea as pair_timestamps in signaling.py): once the map
    # exceeds the cap, evict IPs with no timestamps left in the current window — including
    # IPs that made one request and never returned, not just ones still calling in.
    if len(_credentials_requests) > _CREDENTIALS_MAX_TRACKED_IPS:
        stale_ips = [
            ip for ip, timestamps in _credentials_requests.items()
            if not any(t >= window_start for t in timestamps)
        ]
        for ip in stale_ips:
            del _credentials_requests[ip]

    # Define TTL (5 minutes)
    ttl = 300

    # Generate temporary credentials
    username, credential = generate_turn_credentials(ttl)

    # Generate token
    expiration = datetime.now(tz=timezone.utc) + timedelta(seconds=ttl)
    payload = {'username': username, 'credential': credential, 'exp': int(expiration.timestamp())}
    token = jwt.encode(payload, SECRET_KEY, algorithm='HS256')

    # Return token
    return { "token": token }

def generate_turn_credentials(ttl):
    timestamp = int(time.time()) + ttl
    username = f"{timestamp}:{uuid.uuid4().hex}"
    dig = hmac.new(SECRET_KEY.encode(), username.encode(), hashlib.sha1).digest()
    password = base64.b64encode(dig).decode()
    return username, password

# Mount WebRTC signaling routes (/ws). Implementation lives in api/signaling.py.
app.include_router(signaling_router)

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
# app has no login/session system. Rate-limit per source IP so an unauthenticated attacker
# can't mint unlimited credentials to abuse the TURN server as an open relay.
_CREDENTIALS_RATE_LIMIT = 10       # max requests per window per IP
_CREDENTIALS_RATE_WINDOW = 60      # seconds
_credentials_requests: dict[str, list[float]] = {}

# Add credentials route
@app.get("/credentials")
async def credentials(request: Request):
    # Enforce per-IP rate limit before issuing new credentials.
    client_ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    window_start = now - _CREDENTIALS_RATE_WINDOW
    recent = [t for t in _credentials_requests.get(client_ip, []) if t >= window_start]
    if len(recent) >= _CREDENTIALS_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many requests.")
    recent.append(now)
    _credentials_requests[client_ip] = recent

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

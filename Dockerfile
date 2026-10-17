# Development
# docker build --no-cache -t filesync --load .
# docker build --no-cache --platform linux/amd64 -t filesync --output=type=docker,dest=filesync.tar .

# ==============================
# Stage 1: Build Python dependencies
# ==============================
FROM python:3.14-alpine AS builder

# Install build dependencies
RUN apk add --no-cache --virtual .build-deps build-base libffi-dev musl-dev python3-dev

WORKDIR /filesync

# Copy requirements
COPY api/requirements.txt .

# Install Python dependencies to a separate location
RUN pip install --no-cache-dir --prefer-binary --upgrade pip setuptools wheel \
    && pip install --no-cache-dir --prefix=/install -r requirements.txt

# Optional: remove tests and unnecessary files from site-packages
RUN find /install/lib/ -path "*/site-packages/tests" -type d -exec rm -rf {} + \
    && find /install/lib/ -name "*.pyc" -delete \
    && find /install/lib/ -name "*.pyo" -delete \
    && find /install/lib/ -name "*.so" -exec strip --strip-unneeded {} +

# ==============================
# Stage 2: Runtime image
# ==============================
FROM python:3.14-alpine

# Nginx, bash (for `wait -n`), su-exec (run the backend unprivileged).
RUN apk add --no-cache nginx bash su-exec

WORKDIR /filesync

# Never write .pyc at runtime.
ENV PYTHONDONTWRITEBYTECODE=1

# Copy Python dependencies from builder
COPY --from=builder /install /usr/local

# Copy app code
COPY api /filesync/api
COPY --chown=nginx:nginx web /filesync/web

# Copy Nginx config
COPY nginx.conf /etc/nginx/http.d/default.conf

# Health check: verify nginx (/) and backend (/health) are both responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO /dev/null http://127.0.0.1/ && wget -qO /dev/null http://127.0.0.1:8000/health

# Expose ports
EXPOSE 80

# Start FastAPI and nginx; `wait -n` stops the container if either dies.
CMD ["bash", "-c", "su-exec nginx python3 -m uvicorn api.main:app --host 0.0.0.0 --port 8000 --ws-max-size 65536 & nginx -g 'daemon off;' & wait -n"]

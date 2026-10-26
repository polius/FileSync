# Development
# docker build --no-cache -t filesync --load .
# docker build --no-cache --platform linux/amd64 -t filesync --output=type=docker,dest=filesync.tar .
# Releases pass the version: docker build --build-arg VERSION=4.5.0 -t filesync .

# ==============================
# Stage 1: Build Python dependencies
# ==============================
# Python version: keep in step with .python-version (CI checks it).
FROM python:3.15-alpine AS builder

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
FROM python:3.15-alpine

# Nginx, tini (PID 1: forwards signals and reaps zombies), su-exec (run the backend
# unprivileged), bash (the entrypoint's `wait -n`: busybox ash's never returns for a child
# killed by a signal, so a crashed process would go unnoticed).
RUN apk add --no-cache nginx tini su-exec bash

WORKDIR /filesync

# Never write .pyc at runtime.
ENV PYTHONDONTWRITEBYTECODE=1

# Copy Python dependencies from builder
COPY --from=builder /install /usr/local

# Copy Nginx config and the process supervisor script
COPY nginx.conf /etc/nginx/http.d/default.conf
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# Copy app code
COPY api /filesync/api
COPY --chown=nginx:nginx web /filesync/web

# Declared late so a version bump only invalidates the layers below.
ARG VERSION=dev
ENV APP_VERSION=$VERSION

# Stamp the cache-busting token into the HTML/service worker (assets are served immutable
# when requested with ?v=). A "dev" build gets a hash of web/ instead, so local rebuilds
# with changed assets still bust the browser cache. Files without the token are left alone.
RUN token="$VERSION"; \
    if [ "$token" = dev ]; then token="dev-$(find web -type f | sort | tr "\n" "\0" | xargs -0 cat | sha256sum | cut -c1-8)"; fi; \
    for f in web/index.html web/sw.js; do \
        [ -f "$f" ] && sed -i "s|__APP_VERSION__|$token|g" "$f"; \
    done; true

# One request through nginx to the backend proves both processes are serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO /dev/null http://127.0.0.1/healthz || exit 1

# Expose ports
EXPOSE 80

# tini -g signals the whole process group, so `docker stop` reaches uvicorn and nginx at once.
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]

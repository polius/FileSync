#!/bin/bash
# Runs under `tini -g`, which delivers SIGTERM/SIGINT to this whole process group: uvicorn
# and nginx receive the signal directly, so this script only has to wait for them to exit.
set -u

# Backend: unprivileged, loopback only (nginx is the sole entry point), no per-request log
# (nginx already logs every request). The graceful-shutdown cap keeps open WebSockets from
# holding `docker stop` past its 10 s SIGKILL deadline.
su-exec nginx python3 -m uvicorn api.main:app \
    --host 127.0.0.1 --port 8000 \
    --ws-max-size 65536 \
    --no-access-log \
    --timeout-graceful-shutdown 5 &
api=$!

# nginx treats SIGTERM as a fast shutdown, so long-lived /ws proxies don't stall the stop.
nginx -g 'daemon off;' &
web=$!

# The signal already reached the children; just note it and fall through to the cleanup.
stopping=0
trap 'stopping=1' TERM INT

# Returns when either process exits, or when a trapped signal interrupts the wait.
wait -n
status=$?

# Whichever is still running goes down too (a lone survivor would look healthy-ish to
# Docker and never restart), then reap both so neither is killed mid-shutdown.
kill -TERM "$api" "$web" 2>/dev/null
wait

# A requested stop is a clean exit; an unexpected death keeps its failure status.
[ "$stopping" = 1 ] && exit 0
exit "$status"

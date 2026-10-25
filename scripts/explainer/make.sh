#!/usr/bin/env bash
# Build the explainer end to end (see build.py for the stages and flags).
#
#   ./make.sh                       # full build -> filesync-video.mp4
#   ./make.sh --skip-capture        # re-encode from frames/ on disk
#   ./make.sh --skip-narration      # keep audio/ + timeline.json
#   ./make.sh --poster 6.6          # just write the README thumbnail
#   ./make.sh --workers 4 --crf 16
set -euo pipefail
cd "$(dirname "$0")"

[ -x .venv/bin/python ] || { echo "no .venv — run ./setup.sh --models first"; exit 1; }
exec .venv/bin/python build.py "$@"

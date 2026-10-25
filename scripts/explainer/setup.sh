#!/usr/bin/env bash
# One-time setup for the video pipeline.
#
#   ./setup.sh          # venv + python deps
#   ./setup.sh --models # also fetch the Kokoro voice weights (~340 MB)
#
# Everything lives inside this folder (.venv/, models/) and is git-ignored, so
# the pipeline never touches the rest of the repo. Needs Python 3.10+ and ffmpeg.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON=${PYTHON:-python3}
VENV=.venv
MODELS=models
KOKORO_BASE=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0

command -v ffmpeg >/dev/null || { echo "ffmpeg not found on PATH"; exit 1; }

if [ ! -d "$VENV" ]; then
  echo "==> venv ($PYTHON)"
  "$PYTHON" -m venv "$VENV"
fi

echo "==> python deps"
"$VENV/bin/python" -m pip install -q -U pip
"$VENV/bin/pip" install -q -r requirements.txt

echo "==> headless chromium (frame capture)"
"$VENV/bin/python" -m playwright install chromium

if [ "${1:-}" = "--models" ]; then
  if [ -f "$MODELS/kokoro-v1.0.onnx" ] && [ -f "$MODELS/voices-v1.0.bin" ]; then
    echo "==> Kokoro weights already present"
  else
    echo "==> Kokoro voice weights (~340 MB, one time)"
    mkdir -p "$MODELS"
    curl -L --fail --progress-bar -o "$MODELS/kokoro-v1.0.onnx" "$KOKORO_BASE/kokoro-v1.0.onnx"
    curl -L --fail --progress-bar -o "$MODELS/voices-v1.0.bin"  "$KOKORO_BASE/voices-v1.0.bin"
  fi
fi

cat <<'EOF'

setup done.
  ./make.sh            build the video
  ./make.sh --preview  quick stills while you iterate on visuals
EOF

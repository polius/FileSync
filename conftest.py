# Root conftest puts the repo root on sys.path so `import api.signaling` works
# when pytest is invoked from anywhere.
import os

# api/main.py reads SECRET_KEY from the environment at import time and refuses to start
# without it. Set a throwaway value here, before any test file imports api.main, so
# `pytest tests` works without a real secret — mirrors the value CI's import smoke test uses.
os.environ.setdefault("SECRET_KEY", "test-not-a-real-secret")

"""
Celery worker entry point — start from backend/ directory.

Usage (from backend/):
    .venv\Scripts\celery -A celery_worker worker --loglevel=info --pool=solo

This script ensures the project root is on sys.path before Celery loads
worker.celery_app, so that both `app.*` and `shared.*` packages are importable.

Why this file exists:
    - worker/ lives at the project root, not inside backend/.
    - Starting Celery from backend/ with `-A worker.celery_app` fails if the
      project root isn't on sys.path when the module is first loaded.
    - This entry point adds the project root to sys.path first, then imports
      and re-exports the Celery application.
"""
import sys
from pathlib import Path

# backend/celery_worker.py → parents[0]=backend/, parents[1]=project root
_project_root = Path(__file__).resolve().parent.parent
_backend_root = Path(__file__).resolve().parent

for _p in (str(_project_root), str(_backend_root)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Now import the real Celery app. This also loads all task modules.
from worker.celery_app import celery_app as app  # noqa: F401, E402

# Celery discovers `app` by looking for the `app` attribute on this module.

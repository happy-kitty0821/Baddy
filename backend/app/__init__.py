"""
App package bootstrap.

Ensures the project root is on sys.path so that `shared.*` imports work
regardless of the current working directory.  This is the first thing
imported when uvicorn loads `app.main`, so it runs before any model or
service module that depends on `shared`.

Why this is needed:
  - `shared/` lives at the project root (one level above `backend/`).
  - uvicorn is started from `backend/`, so the project root is not on
    sys.path by default.
  - Without this, `from shared.enums import ...` raises ModuleNotFoundError.

This is the same pattern used in `alembic/env.py` and `worker/celery_app.py`.
"""

import sys
from pathlib import Path

# app/__init__.py → parents[0] = app/, parents[1] = backend/, parents[2] = project root
_project_root = str(Path(__file__).resolve().parents[2])
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

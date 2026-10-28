"""
Celery application configuration.

The worker is a separate process from the FastAPI server.  It connects to:
  - Redis: as the task broker and result backend.
  - PostgreSQL / SQLite: directly, using the same DATABASE_URL as the API.
  - Filesystem storage: using the same STORAGE_ROOT as the API.

Starting the worker (development):
    celery -A worker.celery_app worker --loglevel=info --pool=solo

    Note: --pool=solo is recommended on Windows for development because
    the default prefork pool requires a spawn-safe entry point.  On Linux
    production, use the default prefork pool or gevent.

Redis requirement:
    The worker requires Redis to be running.  During Phase 1 development
    without Docker, start Redis manually or via WSL.
    If Redis is unavailable, tasks remain QUEUED in the database but are
    not processed.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure the project root is on sys.path so that `shared` and `backend`
# packages are importable from worker tasks.
_project_root = Path(__file__).resolve().parents[1]
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))
_backend_root = _project_root / "backend"
if str(_backend_root) not in sys.path:
    sys.path.insert(0, str(_backend_root))

from celery import Celery  # noqa: E402

from app.config import settings  # noqa: E402

celery_app = Celery(
    "badminton_ai",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "worker.tasks.ingestion",
        "worker.tasks.vision",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    # Keep task results for 24 hours (ephemeral — DB is the source of truth).
    result_expires=86400,
    # Retry tasks on unexpected worker termination.
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    # Limit each task to one retry by default (tasks handle their own retry
    # logic and update the DB accordingly).
    task_max_retries=1,
    # On Windows development: solo pool avoids fork issues.
    worker_pool="solo" if sys.platform == "win32" else "prefork",
)

"""
Job service: create analysis runs and dispatch Celery tasks.

The Celery broker (Redis) is optional during development — if Redis is
not running, the worker won't process tasks, but the API will still record
the analysis run in the database.  Tasks can be triggered manually or
run synchronously in tests.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.analysis_run import AnalysisRun
from shared.constants import PIPELINE_VERSION
from shared.enums import AnalysisStatus


def create_analysis_run(
    db: Session,
    match_id: str,
    pipeline_config: dict | None = None,
) -> AnalysisRun:
    """Create a new analysis run record and return it (without dispatching)."""
    run = AnalysisRun(
        id=str(uuid.uuid4()),
        match_id=match_id,
        status=AnalysisStatus.QUEUED.value,
        analysis_version=PIPELINE_VERSION,
        pipeline_config=json.dumps(pipeline_config or {}),
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def dispatch_ingestion(run_id: str, match_id: str) -> str | None:
    """
    Dispatch the ingestion Celery task for *run_id*.

    Returns the Celery task ID, or None if the broker is unavailable.
    The caller is responsible for persisting the task ID.
    """
    try:
        from worker.tasks.ingestion import run_ingestion  # noqa: PLC0415
        result = run_ingestion.delay(run_id=run_id, match_id=match_id)
        return result.id
    except Exception:
        # Broker not running (e.g. Redis unavailable during dev).
        # Log and continue — the run stays QUEUED in the database.
        import logging
        logging.getLogger(__name__).warning(
            "Could not dispatch ingestion task for run %s — broker unavailable.",
            run_id,
        )
        return None


def get_run(db: Session, run_id: str) -> AnalysisRun | None:
    return db.get(AnalysisRun, run_id)


def get_latest_run(db: Session, match_id: str) -> AnalysisRun | None:
    return (
        db.query(AnalysisRun)
        .filter(AnalysisRun.match_id == match_id)
        .order_by(AnalysisRun.created_at.desc())
        .first()
    )


def mark_run_started(db: Session, run: AnalysisRun, stage: str) -> None:
    run.status = AnalysisStatus.INGESTING.value
    run.started_at = datetime.now(timezone.utc)
    run.current_stage = stage
    run.progress_pct = 0
    db.commit()


def mark_vision_started(db: Session, run: AnalysisRun, stage: str) -> None:
    """Mark a run as actively processing the Phase 2 vision pipeline.

    Additive helper (does not touch the ingestion path).  Sets the run to
    PROCESSING, records the start time and current vision stage, and resets
    progress so the frontend poller shows fresh vision progress.
    """
    run.status = AnalysisStatus.PROCESSING.value
    run.started_at = datetime.now(timezone.utc)
    run.current_stage = stage
    run.progress_pct = 0
    db.commit()


def update_run_progress(
    db: Session, run: AnalysisRun, pct: int, stage: str
) -> None:
    run.progress_pct = min(max(pct, 0), 100)
    run.current_stage = stage
    db.commit()


def mark_run_completed(db: Session, run: AnalysisRun) -> None:
    run.status = AnalysisStatus.COMPLETED.value
    run.progress_pct = 100
    run.current_stage = None
    run.completed_at = datetime.now(timezone.utc)
    db.commit()


def mark_run_failed(
    db: Session,
    run: AnalysisRun,
    error_code: str,
    error_message: str,
) -> None:
    run.status = AnalysisStatus.FAILED.value
    run.error_code = error_code
    run.error_message = error_message
    run.completed_at = datetime.now(timezone.utc)
    db.commit()

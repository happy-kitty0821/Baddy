"""
Vision service: Phase 2 database read/write helpers and Celery dispatch.

Pure-DB functions (get_tracks, get_track, update_player_identity, query_poses,
save_correction) mirror the match_service style.  ``dispatch_vision`` lazily
imports the worker task inside a try/except so the API works before the
worker task exists (broker-tolerant, same shape as dispatch_ingestion).
"""

from __future__ import annotations

import json

from sqlalchemy.orm import Session

from app.models.player_track import PlayerTrack
from app.models.pose_frame import PoseFrame
from app.models.user_correction import UserCorrection
from app.schemas.vision import CorrectionCreate, PlayerIdentityUpdate

# Hard cap on the number of pose frames returned per request.
_MAX_POSE_LIMIT = 1000


def get_tracks(db: Session, run_id: str) -> list[PlayerTrack]:
    """Return all player tracks for an analysis run, ordered by track_id."""
    return (
        db.query(PlayerTrack)
        .filter(PlayerTrack.analysis_run_id == run_id)
        .order_by(PlayerTrack.track_id.asc())
        .all()
    )


def get_track(db: Session, track_id: str) -> PlayerTrack | None:
    return db.get(PlayerTrack, track_id)


def update_player_identity(
    db: Session, track: PlayerTrack, data: PlayerIdentityUpdate
) -> PlayerTrack:
    """Apply only the set fields from *data*, then commit and refresh."""
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(track, field, value)
    db.commit()
    db.refresh(track)
    return track


def query_poses(
    db: Session,
    run_id: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    track_id: str | None = None,
    limit: int = 500,
    offset: int = 0,
) -> tuple[list[PoseFrame], int]:
    """
    Query pose frames for a run, ordered by ``timestamp_ms``.

    Returns ``(items, total)`` where *total* is the count of rows matching the
    filters (ignoring pagination).  *limit* is clamped to the range [1, 1000].
    """
    limit = max(1, min(limit, _MAX_POSE_LIMIT))
    offset = max(0, offset)

    query = db.query(PoseFrame).filter(PoseFrame.analysis_run_id == run_id)
    if start_ms is not None:
        query = query.filter(PoseFrame.timestamp_ms >= start_ms)
    if end_ms is not None:
        query = query.filter(PoseFrame.timestamp_ms <= end_ms)
    if track_id is not None:
        query = query.filter(PoseFrame.player_track_id == track_id)

    total = query.count()
    items = (
        query.order_by(PoseFrame.timestamp_ms.asc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return items, total


def save_correction(
    db: Session, run_id: str, data: CorrectionCreate
) -> UserCorrection:
    """Persist a user correction (append-only audit row) for a run."""
    correction = UserCorrection(
        analysis_run_id=run_id,
        entity_type=data.entity_type,
        entity_id=data.entity_id,
        correction_data=json.dumps(data.correction_data),
    )
    db.add(correction)
    db.commit()
    db.refresh(correction)
    return correction


def dispatch_vision(run_id: str, match_id: str) -> str | None:
    """
    Dispatch the Phase 2 vision Celery task for *run_id*.

    Returns the Celery task ID, or None if the broker/worker is unavailable
    (e.g. Redis not running during development).  The task is imported lazily
    inside a try/except so this module imports cleanly before the worker task
    exists (FEAT-002) and so broker failures degrade gracefully.
    """
    try:
        from worker.tasks.vision import run_vision  # noqa: PLC0415
        result = run_vision.delay(run_id=run_id, match_id=match_id)
        return result.id
    except Exception:
        import logging
        logging.getLogger(__name__).warning(
            "Could not dispatch vision task for run %s — broker unavailable.",
            run_id,
        )
        return None

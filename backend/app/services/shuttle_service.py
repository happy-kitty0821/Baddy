"""Service layer for shuttle observation queries.

Mirrors vision_service.query_poses exactly in structure and conventions.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.shuttle_observation import ShuttleObservation

_MAX_SHUTTLE_LIMIT = 5000


def query_shuttle(
    db: Session,
    run_id: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    limit: int = 5000,
    offset: int = 0,
) -> tuple[list[ShuttleObservation], int]:
    """Return a paginated list of shuttle observations for a run.

    Returns (items, total) where total ignores pagination (same contract as
    query_poses).  Limit is clamped to [1, _MAX_SHUTTLE_LIMIT].
    """
    limit = max(1, min(limit, _MAX_SHUTTLE_LIMIT))
    offset = max(0, offset)

    q = db.query(ShuttleObservation).filter(
        ShuttleObservation.analysis_run_id == run_id
    )
    if start_ms is not None:
        q = q.filter(ShuttleObservation.timestamp_ms >= start_ms)
    if end_ms is not None:
        q = q.filter(ShuttleObservation.timestamp_ms <= end_ms)

    total = q.count()
    items = (
        q.order_by(ShuttleObservation.timestamp_ms.asc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return items, total

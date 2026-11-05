"""Service layer for court calibration queries."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.court_calibration import CourtCalibration


def get_calibrations(db: Session, run_id: str) -> list[CourtCalibration]:
    """Return all court calibration rows for a run, ordered by timestamp_ms ascending."""
    return (
        db.query(CourtCalibration)
        .filter(CourtCalibration.analysis_run_id == run_id)
        .order_by(CourtCalibration.timestamp_ms.asc())
        .all()
    )

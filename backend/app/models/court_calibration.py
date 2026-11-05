"""ORM model for the `court_calibrations` table.

One row per sampled frame interval per analysis run.  Stores the 4 detected
court corner positions in source pixels plus the 3×3 homography matrix that
maps source pixels → normalised court coordinates [0,1]×[0,1].

Used by:
  - The worker pipeline to filter out-of-court detections.
  - The frontend CourtHeatmap for pixel-accurate court mapping.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class CourtCalibration(Base):
    __tablename__ = "court_calibrations"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    analysis_run_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Timing
    timestamp_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    frame_index: Mapped[int] = mapped_column(Integer, nullable=False)

    # JSON [[x,y],[x,y],[x,y],[x,y]] in source pixels
    # Order: top-left, top-right, bottom-right, bottom-left
    corners_json: Mapped[str] = mapped_column(Text, nullable=False)

    # JSON 3×3 matrix [[row],[row],[row]] mapping source px → normalised court [0,1]×[0,1]
    homography_json: Mapped[str] = mapped_column(Text, nullable=False)

    # RMS pixel drift from the previous calibration row; None for the first row.
    drift_px: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Fraction of expected intersections found (0–1).
    confidence: Mapped[float] = mapped_column(Float, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    analysis_run: Mapped["AnalysisRun"] = relationship(  # noqa: F821
        "AnalysisRun", back_populates="court_calibrations"
    )

    def __repr__(self) -> str:
        return (
            f"<CourtCalibration id={self.id!r} run={self.analysis_run_id!r} "
            f"frame={self.frame_index!r} confidence={self.confidence!r}>"
        )

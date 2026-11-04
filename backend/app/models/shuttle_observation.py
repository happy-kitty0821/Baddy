"""ORM model for the `shuttle_observations` table.

One row per source frame per analysis run.  Stores the shuttlecock centroid
in source video pixels so the frontend can apply letterbox mapping itself.

`observation_status` is one of "detected" | "interpolated" | "unavailable"
(stored as a plain String, matching the convention of the rest of the codebase
which stores enum .value strings rather than SQLAlchemy Enum columns).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ShuttleObservation(Base):
    __tablename__ = "shuttle_observations"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    analysis_run_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Timing (both stored: timestamp_ms for overlay lookup, frame_index for
    # resume/idempotency).
    timestamp_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    frame_index: Mapped[int] = mapped_column(Integer, nullable=False)

    # Shuttle centroid in source pixels; None when observation_status is "unavailable".
    x: Mapped[float | None] = mapped_column(Float, nullable=True)
    y: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Max heatmap value inside the detected blob (0–1); None when unavailable/interpolated.
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)

    # "detected" | "interpolated" | "unavailable"
    observation_status: Mapped[str] = mapped_column(String(16), nullable=False)

    # Source video dimensions at analysis time (pixels).
    source_width: Mapped[int] = mapped_column(Integer, nullable=False)
    source_height: Mapped[int] = mapped_column(Integer, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    analysis_run: Mapped["AnalysisRun"] = relationship(  # noqa: F821
        "AnalysisRun", back_populates="shuttle_observations"
    )

    def __repr__(self) -> str:
        return (
            f"<ShuttleObservation id={self.id!r} run={self.analysis_run_id!r} "
            f"frame={self.frame_index!r} status={self.observation_status!r}>"
        )

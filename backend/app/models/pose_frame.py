"""ORM model for the `pose_frames` table.

Each row stores the per-frame pose result for a single tracked player:
the bounding box, the 17 COCO keypoints (serialised as JSON-in-TEXT), the
source video dimensions, and timing.  Coordinates are stored in source
video pixels; the frontend scales them to the canvas display size.

`keypoints_json` holds `[[x, y, conf], ...]` (17 entries) in source pixels.
Both `timestamp_ms` and `frame_index` are stored so frames can be looked up
by wall-clock time (for the overlay) or by index (for resume/idempotency).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class PoseFrame(Base):
    __tablename__ = "pose_frames"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    analysis_run_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    player_track_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("player_tracks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Timing (both stored: timestamp_ms for overlay lookup, frame_index for
    # resume/idempotency).
    timestamp_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    frame_index: Mapped[int] = mapped_column(Integer, nullable=False)

    # Bounding box (x, y, w, h in source pixels) and its confidence.
    bbox_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    bbox_y: Mapped[float | None] = mapped_column(Float, nullable=True)
    bbox_w: Mapped[float | None] = mapped_column(Float, nullable=True)
    bbox_h: Mapped[float | None] = mapped_column(Float, nullable=True)
    bbox_conf: Mapped[float | None] = mapped_column(Float, nullable=True)

    # 17 COCO keypoints as JSON-in-TEXT: [[x, y, conf], ...] in source pixels.
    keypoints_json: Mapped[str] = mapped_column(Text, nullable=False)
    overall_conf: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Source video dimensions at analysis time (pixels).
    source_width: Mapped[int] = mapped_column(Integer, nullable=False)
    source_height: Mapped[int] = mapped_column(Integer, nullable=False)

    # Model identifier (e.g. "yolo11n-pose") for reproducibility.
    model_id: Mapped[str | None] = mapped_column(String(128), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    analysis_run: Mapped["AnalysisRun"] = relationship(  # noqa: F821
        "AnalysisRun", back_populates="pose_frames"
    )
    player_track: Mapped["PlayerTrack"] = relationship(  # noqa: F821
        "PlayerTrack", back_populates="pose_frames"
    )

    def __repr__(self) -> str:
        return (
            f"<PoseFrame id={self.id!r} run={self.analysis_run_id!r} "
            f"track={self.player_track_id!r} frame={self.frame_index!r}>"
        )

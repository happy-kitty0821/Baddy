"""ORM model for the `player_tracks` table.

A player track is a single tracked person across the frames of an analysis
run.  The pose worker creates one row per detected+tracked person (keyed by
the tracker's `track_id`) and assigns a human-readable `track_label` in
first-seen order.  The user can flag one track as the player of interest
(`is_selected_player`) and add a free-text identity note.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class PlayerTrack(Base):
    __tablename__ = "player_tracks"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    analysis_run_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Stable id assigned by the multi-object tracker (e.g. ByteTrack).
    track_id: Mapped[int] = mapped_column(Integer, nullable=False)
    # Human-readable label, e.g. "player_1" (assigned by first-seen order).
    track_label: Mapped[str] = mapped_column(String(32), nullable=False)
    # Whether the user marked this track as the player of interest.
    is_selected_player: Mapped[bool] = mapped_column(Boolean, default=False)
    identity_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    identity_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    analysis_run: Mapped["AnalysisRun"] = relationship(  # noqa: F821
        "AnalysisRun", back_populates="player_tracks"
    )
    pose_frames: Mapped[list["PoseFrame"]] = relationship(  # noqa: F821
        "PoseFrame", back_populates="player_track", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return (
            f"<PlayerTrack id={self.id!r} run={self.analysis_run_id!r} "
            f"track_id={self.track_id!r} label={self.track_label!r}>"
        )

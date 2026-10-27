"""ORM model for the `analysis_runs` table.

Each analysis run represents one execution of the processing pipeline
against a match.  Multiple runs can exist for the same match (e.g. after
a retry or a reprocessing request).

Status lifecycle:
    QUEUED → INGESTING → PROCESSING → COMPLETED
                                    ↘ FAILED

Rules:
  - A run is immutable after COMPLETED, except for user corrections.
  - Reprocessing creates a new run; it never mutates a completed one.
  - FAILED runs can be retried, creating a new run record.
  - Processing status in PostgreSQL/SQLite is the source of truth;
    Redis result-backend entries are treated as ephemeral.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from shared.enums import AnalysisStatus


class AnalysisRun(Base):
    __tablename__ = "analysis_runs"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    match_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("matches.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default=AnalysisStatus.QUEUED.value, index=True
    )

    # Pipeline configuration snapshot (JSON string) — records which
    # model versions and settings were used, for reproducibility.
    pipeline_config: Mapped[str | None] = mapped_column(Text, nullable=True)
    analysis_version: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # Celery task ID for this run — allows status lookup via broker.
    celery_task_id: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # Progress tracking (0–100)
    progress_pct: Mapped[int] = mapped_column(default=0)
    current_stage: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Timing
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Error information
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    match: Mapped["Match"] = relationship("Match", back_populates="analysis_runs")  # noqa: F821
    # Phase 2 vision results (player tracks, pose frames, user corrections).
    # ORM-level cascade mirrors the DB ondelete="CASCADE" so delete_match
    # removes these alongside the analysis run.
    player_tracks: Mapped[list["PlayerTrack"]] = relationship(  # noqa: F821
        "PlayerTrack", back_populates="analysis_run", cascade="all, delete-orphan"
    )
    pose_frames: Mapped[list["PoseFrame"]] = relationship(  # noqa: F821
        "PoseFrame", back_populates="analysis_run", cascade="all, delete-orphan"
    )
    user_corrections: Mapped[list["UserCorrection"]] = relationship(  # noqa: F821
        "UserCorrection", back_populates="analysis_run", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return (
            f"<AnalysisRun id={self.id!r} match={self.match_id!r} "
            f"status={self.status!r}>"
        )

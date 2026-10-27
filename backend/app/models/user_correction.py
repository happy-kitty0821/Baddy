"""ORM model for the `user_corrections` table.

A user correction records a manual edit a user made to an analysis result
(e.g. fixing a mislabelled player track).  The `entity_type` names what was
corrected (e.g. "player_track"), `entity_id` is the affected row, and
`correction_data` is a free-form JSON string describing the change.  These
rows are append-only audit entries; they never mutate the analysis itself.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class UserCorrection(Base):
    __tablename__ = "user_corrections"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    analysis_run_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # What was corrected, e.g. "player_track".
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    # The id of the affected row.
    entity_id: Mapped[str] = mapped_column(String(36), nullable=False)
    # Free-form JSON string describing the correction.
    correction_data: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    analysis_run: Mapped["AnalysisRun"] = relationship(  # noqa: F821
        "AnalysisRun", back_populates="user_corrections"
    )

    def __repr__(self) -> str:
        return (
            f"<UserCorrection id={self.id!r} run={self.analysis_run_id!r} "
            f"entity={self.entity_type!r}:{self.entity_id!r}>"
        )

"""Phase 4: shuttle_observations table

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-01

Notes:
  - Additive migration: creates the shuttle_observations table for Phase 4
    shuttlecock tracking.
  - Written to be compatible with both SQLite and PostgreSQL (no
    dialect-specific types; created_at uses sa.text("(CURRENT_TIMESTAMP)")).
  - Foreign key uses ondelete="CASCADE" so deleting a run cascades to
    shuttle rows (mirrors pose_frames behaviour).
  - Two indexes: single FK index and composite (run_id, timestamp_ms) for
    the overlay's time-windowed query (mirrors ix_pose_frames_run_time).
  - render_as_batch=True stays on in env.py (SQLite ALTER support).
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "shuttle_observations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "analysis_run_id",
            sa.String(36),
            sa.ForeignKey("analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("timestamp_ms", sa.Integer, nullable=False),
        sa.Column("frame_index", sa.Integer, nullable=False),
        sa.Column("x", sa.Float, nullable=True),
        sa.Column("y", sa.Float, nullable=True),
        sa.Column("confidence", sa.Float, nullable=True),
        sa.Column("observation_status", sa.String(16), nullable=False),
        sa.Column("source_width", sa.Integer, nullable=False),
        sa.Column("source_height", sa.Integer, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
    )
    # Single-column FK lookup index
    op.create_index(
        "ix_shuttle_observations_analysis_run_id",
        "shuttle_observations",
        ["analysis_run_id"],
    )
    # Composite index: observations for a run ordered by time (overlay lookup).
    op.create_index(
        "ix_shuttle_observations_run_time",
        "shuttle_observations",
        ["analysis_run_id", "timestamp_ms"],
    )


def downgrade() -> None:
    op.drop_table("shuttle_observations")

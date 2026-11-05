"""Phase 3: court_calibrations table

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-01

Notes:
  - Additive migration: creates the court_calibrations table for Phase 3
    court keypoint anchoring / calibration.
  - Written to be compatible with both SQLite and PostgreSQL (no
    dialect-specific types; created_at uses sa.text("(CURRENT_TIMESTAMP)")).
  - Foreign key uses ondelete="CASCADE" so deleting a run cascades to
    calibration rows (mirrors pose_frames and shuttle_observations behaviour).
  - Two indexes: single FK index and composite (run_id, timestamp_ms) for
    time-windowed queries (mirrors ix_shuttle_observations_run_time).
  - render_as_batch=True stays on in env.py (SQLite ALTER support).
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "court_calibrations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "analysis_run_id",
            sa.String(36),
            sa.ForeignKey("analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("timestamp_ms", sa.Integer, nullable=False),
        sa.Column("frame_index", sa.Integer, nullable=False),
        sa.Column("corners_json", sa.Text, nullable=False),
        sa.Column("homography_json", sa.Text, nullable=False),
        sa.Column("drift_px", sa.Float, nullable=True),
        sa.Column("confidence", sa.Float, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
    )
    # Single-column FK lookup index
    op.create_index(
        "ix_court_calibrations_analysis_run_id",
        "court_calibrations",
        ["analysis_run_id"],
    )
    # Composite index: calibrations for a run ordered by time (time-windowed lookup).
    op.create_index(
        "ix_court_calibrations_run_time",
        "court_calibrations",
        ["analysis_run_id", "timestamp_ms"],
    )


def downgrade() -> None:
    op.drop_table("court_calibrations")

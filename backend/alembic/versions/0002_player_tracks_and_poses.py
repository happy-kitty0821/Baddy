"""Phase 2 vision tables: player_tracks, pose_frames, user_corrections

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-27

Notes:
  - Additive migration: creates three new tables for the Phase 2 vision
    pipeline (player detection, pose estimation, user corrections).
  - Written to be compatible with both SQLite and PostgreSQL (no
    dialect-specific types; created_at uses sa.text("(CURRENT_TIMESTAMP)")).
  - Foreign keys use ondelete="CASCADE" so deleting a match/run/track
    cascades to the dependent rows.
  - Composite indexes support the two common query paths: poses by run
    ordered by time (overlay lookup) and poses by track ordered by frame
    (resume/idempotency).
  - render_as_batch=True stays on in env.py (SQLite ALTER support).
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── player_tracks ──────────────────────────────────────────────────────
    op.create_table(
        "player_tracks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "analysis_run_id",
            sa.String(36),
            sa.ForeignKey("analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("track_id", sa.Integer, nullable=False),
        sa.Column("track_label", sa.String(32), nullable=False),
        sa.Column(
            "is_selected_player",
            sa.Boolean,
            nullable=False,
            server_default="0",
        ),
        sa.Column("identity_note", sa.Text, nullable=True),
        sa.Column("identity_confidence", sa.Float, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
    )
    op.create_index("ix_player_tracks_analysis_run_id", "player_tracks", ["analysis_run_id"])

    # ── pose_frames ────────────────────────────────────────────────────────
    op.create_table(
        "pose_frames",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "analysis_run_id",
            sa.String(36),
            sa.ForeignKey("analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "player_track_id",
            sa.String(36),
            sa.ForeignKey("player_tracks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("timestamp_ms", sa.Integer, nullable=False),
        sa.Column("frame_index", sa.Integer, nullable=False),
        sa.Column("bbox_x", sa.Float, nullable=True),
        sa.Column("bbox_y", sa.Float, nullable=True),
        sa.Column("bbox_w", sa.Float, nullable=True),
        sa.Column("bbox_h", sa.Float, nullable=True),
        sa.Column("bbox_conf", sa.Float, nullable=True),
        sa.Column("keypoints_json", sa.Text, nullable=False),
        sa.Column("overall_conf", sa.Float, nullable=True),
        sa.Column("source_width", sa.Integer, nullable=False),
        sa.Column("source_height", sa.Integer, nullable=False),
        sa.Column("model_id", sa.String(128), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
    )
    op.create_index("ix_pose_frames_analysis_run_id", "pose_frames", ["analysis_run_id"])
    op.create_index("ix_pose_frames_player_track_id", "pose_frames", ["player_track_id"])
    # Composite: poses for a run ordered by time (overlay lookup).
    op.create_index(
        "ix_pose_frames_run_time", "pose_frames", ["analysis_run_id", "timestamp_ms"]
    )
    # Composite: poses for a track ordered by frame (resume/idempotency).
    op.create_index(
        "ix_pose_frames_track_frame", "pose_frames", ["player_track_id", "frame_index"]
    )

    # ── user_corrections ───────────────────────────────────────────────────
    op.create_table(
        "user_corrections",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "analysis_run_id",
            sa.String(36),
            sa.ForeignKey("analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("entity_type", sa.String(32), nullable=False),
        sa.Column("entity_id", sa.String(36), nullable=False),
        sa.Column("correction_data", sa.Text, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
    )
    op.create_index("ix_user_corrections_analysis_run_id", "user_corrections", ["analysis_run_id"])


def downgrade() -> None:
    # Drop in FK-dependency order: pose_frames (→player_tracks, analysis_runs)
    # before player_tracks (→analysis_runs); user_corrections only depends on
    # analysis_runs.
    op.drop_table("pose_frames")
    op.drop_table("player_tracks")
    op.drop_table("user_corrections")

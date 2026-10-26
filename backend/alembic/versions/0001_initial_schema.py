"""Initial schema: matches, assets, analysis_runs

Revision ID: 0001
Revises:
Create Date: 2026-10-26

Notes:
  - Written to be compatible with both SQLite and PostgreSQL.
  - No dialect-specific types are used (e.g. no PostgreSQL UUID column type;
    UUIDs are stored as VARCHAR(36) strings).
  - `render_as_batch=True` is set in env.py, enabling ALTER TABLE support
    on SQLite via table rewrites.
  - PostgreSQL compatibility has NOT been verified by integration tests yet.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "matches",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "uploaded_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("duration_ms", sa.Integer, nullable=True),
        sa.Column("width", sa.Integer, nullable=True),
        sa.Column("height", sa.Integer, nullable=True),
        sa.Column("fps_num", sa.Integer, nullable=True),
        sa.Column("fps_den", sa.Integer, nullable=True),
        sa.Column("codec", sa.String(64), nullable=True),
        sa.Column("file_size_bytes", sa.Integer, nullable=True),
        sa.Column("checksum", sa.String(64), nullable=True),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column("opponent_label", sa.String(255), nullable=True),
        sa.Column("session_type", sa.String(64), nullable=True),
        sa.Column("tags", sa.Text, nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
    )
    op.create_index("ix_matches_status", "matches", ["status"])
    op.create_index("ix_matches_uploaded_at", "matches", ["uploaded_at"])

    op.create_table(
        "assets",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "match_id",
            sa.String(36),
            sa.ForeignKey("matches.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("asset_type", sa.String(32), nullable=False),
        sa.Column("storage_key", sa.String(512), nullable=False, unique=True),
        sa.Column("mime_type", sa.String(128), nullable=True),
        sa.Column("size_bytes", sa.Integer, nullable=True),
        sa.Column("checksum", sa.String(64), nullable=True),
        sa.Column("original_filename", sa.String(512), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
    )
    op.create_index("ix_assets_match_id", "assets", ["match_id"])

    op.create_table(
        "analysis_runs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "match_id",
            sa.String(36),
            sa.ForeignKey("matches.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.String(32), nullable=False, server_default="queued"),
        sa.Column("pipeline_config", sa.Text, nullable=True),
        sa.Column("analysis_version", sa.String(32), nullable=True),
        sa.Column("celery_task_id", sa.String(128), nullable=True),
        sa.Column("progress_pct", sa.Integer, nullable=False, server_default="0"),
        sa.Column("current_stage", sa.String(64), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
    )
    op.create_index("ix_analysis_runs_match_id", "analysis_runs", ["match_id"])
    op.create_index("ix_analysis_runs_status", "analysis_runs", ["status"])


def downgrade() -> None:
    op.drop_table("analysis_runs")
    op.drop_table("assets")
    op.drop_table("matches")

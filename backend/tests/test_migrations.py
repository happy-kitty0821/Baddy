"""
Migration tests — Fix 4: Alembic env.py must import shared without PYTHONPATH.

These tests run `alembic upgrade head` and `alembic downgrade base` on a
DISPOSABLE database.  They never touch the real development database.

The test is parametrised to run from two different working directories to
confirm the CWD-independent path fix works.
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

# Locate the backend directory and the alembic executable.
_BACKEND_DIR = Path(__file__).resolve().parents[1]
_PROJECT_ROOT = _BACKEND_DIR.parent
_ALEMBIC = _BACKEND_DIR / ".venv" / "Scripts" / "alembic.exe"
if not _ALEMBIC.exists():
    # Linux/macOS path
    _ALEMBIC = _BACKEND_DIR / ".venv" / "bin" / "alembic"


def _run_alembic(cmd: str, db_url: str, cwd: Path) -> subprocess.CompletedProcess:
    """Run an alembic command with the given DATABASE_URL and working directory."""
    env = {**os.environ, "DATABASE_URL": db_url}
    return subprocess.run(
        [str(_ALEMBIC)] + cmd.split(),
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
    )


@pytest.fixture()
def disposable_db(tmp_path) -> tuple[Path, str]:
    """Return a (db_path, database_url) pair for a throw-away SQLite database."""
    db_path = tmp_path / "migration_test.db"
    db_url = f"sqlite:///{db_path}"
    return db_path, db_url


@pytest.mark.skipif(not _ALEMBIC.exists(), reason="alembic executable not found in venv")
class TestAlembicMigrations:

    def test_upgrade_from_backend_dir(self, disposable_db):
        """alembic upgrade head works when CWD is backend/ (documented workflow)."""
        db_path, db_url = disposable_db
        result = _run_alembic("upgrade head", db_url, cwd=_BACKEND_DIR)
        assert result.returncode == 0, (
            f"alembic upgrade failed from backend/:\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
        _assert_schema(db_path)

    def test_downgrade_cleans_up(self, disposable_db):
        """alembic downgrade base removes all application tables."""
        db_path, db_url = disposable_db
        _run_alembic("upgrade head", db_url, cwd=_BACKEND_DIR)
        result = _run_alembic("downgrade base", db_url, cwd=_BACKEND_DIR)
        assert result.returncode == 0, (
            f"alembic downgrade failed:\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = {r[0] for r in cur.fetchall()}
        conn.close()
        # Only alembic_version should remain; application tables must be gone.
        assert "matches" not in tables
        assert "assets" not in tables
        assert "analysis_runs" not in tables

    def test_revision_is_0002(self, disposable_db):
        """After upgrade head, alembic_version must be 0002."""
        db_path, db_url = disposable_db
        _run_alembic("upgrade head", db_url, cwd=_BACKEND_DIR)
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT version_num FROM alembic_version")
        row = cur.fetchone()
        conn.close()
        assert row is not None
        assert row[0] == "0002"

    def test_shared_importable_without_pythonpath(self, disposable_db):
        """
        The alembic env.py fix must NOT require PYTHONPATH to be set.
        Run upgrade with a clean environment (no PYTHONPATH override).
        """
        db_path, db_url = disposable_db
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        env["DATABASE_URL"] = db_url
        result = subprocess.run(
            [str(_ALEMBIC), "upgrade", "head"],
            cwd=str(_BACKEND_DIR),
            env=env,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, (
            f"alembic failed without PYTHONPATH:\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}\n"
            "This means alembic/env.py still does not add the project root to sys.path."
        )


def _assert_schema(db_path: Path) -> None:
    """Assert that the expected tables and indexes exist in the SQLite database."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    tables = {r[0] for r in cur.fetchall()}
    assert "matches" in tables, f"matches table missing; tables: {tables}"
    assert "assets" in tables, f"assets table missing"
    assert "analysis_runs" in tables, f"analysis_runs table missing"
    # Phase 2 vision tables.
    assert "player_tracks" in tables, f"player_tracks table missing; tables: {tables}"
    assert "pose_frames" in tables, f"pose_frames table missing; tables: {tables}"
    assert "user_corrections" in tables, f"user_corrections table missing; tables: {tables}"

    cur.execute("SELECT name FROM sqlite_master WHERE type='index'")
    indexes = {r[0] for r in cur.fetchall()}
    assert "ix_matches_status" in indexes
    assert "ix_assets_match_id" in indexes
    assert "ix_analysis_runs_match_id" in indexes
    # Phase 2 single-column indexes.
    assert "ix_player_tracks_analysis_run_id" in indexes
    assert "ix_pose_frames_analysis_run_id" in indexes
    assert "ix_pose_frames_player_track_id" in indexes
    # Phase 2 composite indexes.
    assert "ix_pose_frames_run_time" in indexes, (
        f"composite index ix_pose_frames_run_time missing; indexes: {indexes}"
    )
    assert "ix_pose_frames_track_frame" in indexes, (
        f"composite index ix_pose_frames_track_frame missing; indexes: {indexes}"
    )
    conn.close()

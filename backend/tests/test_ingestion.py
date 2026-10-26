"""
Tests for the ingestion pipeline (Stage 1).

These tests call run_ingestion_sync() directly, without a Celery broker.
A real FFmpeg/ffprobe must be on PATH for metadata extraction tests.
"""

from __future__ import annotations

import io
import shutil

import pytest

from app.models.analysis_run import AnalysisRun
from app.models.asset import Asset
from app.models.match import Match
from app.services.asset_service import store_upload
from app.services.job_service import create_analysis_run
from app.services.match_service import create_match
from app.schemas.match import MatchCreate
from shared.enums import AnalysisStatus, AssetType, MatchStatus
from worker.tasks.ingestion import run_ingestion_sync


@pytest.fixture()
def match_with_asset(db_session, test_storage, small_video):
    """Create a match with a real stored video asset."""
    match = create_match(
        db_session,
        MatchCreate(title="Ingestion Test Match"),
    )
    with open(small_video, "rb") as f:
        store_upload(
            db=db_session,
            storage=test_storage,
            match_id=match.id,
            source=f,
            original_filename="test.mp4",
            asset_type=AssetType.VIDEO_ORIGINAL,
        )
    db_session.commit()
    return match


def test_ingestion_completes(db_session, test_storage, match_with_asset):
    """Ingestion task marks the run COMPLETED and populates match metadata."""
    if not shutil.which("ffprobe"):
        pytest.skip("ffprobe not on PATH — skipping metadata extraction test")

    run = create_analysis_run(db_session, match_with_asset.id)
    db_session.commit()

    # Patch SessionLocal so the task uses the test session.
    import app.database as db_mod
    original_session_local = db_mod.SessionLocal

    class _FixedSession:
        """Returns the existing test session instead of a new one."""
        def __call__(self):
            return _NoCloseSession(db_session)

    class _NoCloseSession:
        """Wraps the test session and suppresses close() calls."""
        def __init__(self, s):
            self._s = s
        def __getattr__(self, name):
            return getattr(self._s, name)
        def close(self):
            pass  # Don't close the test session

    db_mod.SessionLocal = _FixedSession()
    try:
        run_ingestion_sync(run_id=run.id, match_id=match_with_asset.id, storage=test_storage)
    finally:
        db_mod.SessionLocal = original_session_local

    db_session.expire_all()
    updated_run = db_session.get(AnalysisRun, run.id)
    match = db_session.get(Match, match_with_asset.id)

    assert updated_run.status == AnalysisStatus.COMPLETED.value
    assert updated_run.progress_pct == 100
    assert match.status == MatchStatus.READY.value
    assert match.duration_ms is not None
    assert match.width is not None
    assert match.codec is not None


def test_ingestion_idempotent(db_session, test_storage, match_with_asset):
    """Running ingestion twice for the same run does not corrupt the record."""
    if not shutil.which("ffprobe"):
        pytest.skip("ffprobe not on PATH")

    run = create_analysis_run(db_session, match_with_asset.id)
    db_session.commit()

    import app.database as db_mod
    original_session_local = db_mod.SessionLocal

    class _FixedSession:
        def __call__(self):
            return _NoCloseSession(db_session)

    class _NoCloseSession:
        def __init__(self, s): self._s = s
        def __getattr__(self, n): return getattr(self._s, n)
        def close(self): pass

    db_mod.SessionLocal = _FixedSession()
    try:
        run_ingestion_sync(run_id=run.id, match_id=match_with_asset.id, storage=test_storage)
        # Second call — must not raise or change status.
        run_ingestion_sync(run_id=run.id, match_id=match_with_asset.id, storage=test_storage)
    finally:
        db_mod.SessionLocal = original_session_local

    db_session.expire_all()
    updated_run = db_session.get(AnalysisRun, run.id)
    assert updated_run.status == AnalysisStatus.COMPLETED.value


def test_ingestion_missing_asset(db_session, test_storage):
    """Ingestion fails gracefully when no source asset exists."""
    match = create_match(db_session, MatchCreate(title="No Asset Match"))
    run = create_analysis_run(db_session, match.id)
    db_session.commit()

    import app.database as db_mod
    original = db_mod.SessionLocal

    class _FixedSession:
        def __call__(self):
            return _NoClose(db_session)

    class _NoClose:
        def __init__(self, s): self._s = s
        def __getattr__(self, n): return getattr(self._s, n)
        def close(self): pass

    db_mod.SessionLocal = _FixedSession()
    try:
        run_ingestion_sync(run_id=run.id, match_id=match.id, storage=test_storage)
    finally:
        db_mod.SessionLocal = original

    db_session.expire_all()
    updated_run = db_session.get(AnalysisRun, run.id)
    assert updated_run.status == AnalysisStatus.FAILED.value
    assert updated_run.error_code == "NO_SOURCE_ASSET"
    # The match record itself is preserved.
    assert db_session.get(Match, match.id) is not None


def test_ingestion_run_not_found(db_session, test_storage):
    """Ingestion exits quietly when the run ID does not exist."""
    import app.database as db_mod
    original = db_mod.SessionLocal

    class _FixedSession:
        def __call__(self):
            return _NoClose(db_session)

    class _NoClose:
        def __init__(self, s): self._s = s
        def __getattr__(self, n): return getattr(self._s, n)
        def close(self): pass

    db_mod.SessionLocal = _FixedSession()
    try:
        # Should not raise.
        run_ingestion_sync(run_id="nonexistent-run", match_id="nonexistent-match", storage=test_storage)
    finally:
        db_mod.SessionLocal = original

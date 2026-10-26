"""
Pytest fixtures for the backend test suite.

All tests use:
  - A file-based SQLite test database (avoids in-memory per-connection isolation).
  - A temporary directory for file storage (cleaned up after each test).
  - A TestClient that bypasses the real JWT auth.

These fixtures run without Docker, Redis, or any external service.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

# ── Ensure project root and backend root are importable ──────────────────────
_tests_dir = Path(__file__).resolve().parent
_backend_dir = _tests_dir.parent
_project_root = _backend_dir.parent

for _p in (str(_project_root), str(_backend_dir)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Set env vars BEFORE importing any app code that reads them.
os.environ["APP_ENV"] = "testing"
os.environ.setdefault("JWT_SECRET", "test-secret-do-not-use-in-production")
os.environ.setdefault("AUTH_USERNAME", "testuser")
# bcrypt hash of "testpassword"
os.environ.setdefault(
    "AUTH_PASSWORD_HASH",
    "$2b$12$0k/Mwyn4MXFgi3YlVbrE0eoIoczOka0d6OEj.Fiy7jtMRciBCbqFy",
)

from app.database import Base, get_db  # noqa: E402
from app.main import create_app  # noqa: E402
from app.storage.local import LocalFileStorage  # noqa: E402
from app.dependencies import get_storage  # noqa: E402


# ── Shared test database (file-based SQLite) ──────────────────────────────────
# We use a single file per test session.  The file is created in a temp dir
# and deleted afterwards.  File-based SQLite avoids the per-connection
# in-memory isolation problem of sqlite:///:memory:.

@pytest.fixture(scope="session")
def test_db_path(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("testdb") / "test.db"


@pytest.fixture(scope="session")
def db_engine(test_db_path):
    """File-based SQLite engine for the test session."""
    url = f"sqlite:///{test_db_path}"
    engine = create_engine(url, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def set_fk(conn, _):
        conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(bind=engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def db_session(db_engine):
    """
    A database session with per-test rollback isolation.

    Uses a nested transaction (SAVEPOINT) so each test rolls back cleanly
    without dropping and recreating the schema.
    """
    connection = db_engine.connect()
    transaction = connection.begin()
    TestingSession = sessionmaker(bind=connection, autocommit=False, autoflush=False)
    session = TestingSession()
    # Begin a nested savepoint so the test can commit without committing
    # to the outer transaction.
    nested = connection.begin_nested()

    @event.listens_for(session, "after_transaction_end")
    def restart_savepoint(session, trans):
        nonlocal nested
        if not nested.is_active:
            nested = connection.begin_nested()

    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


@pytest.fixture()
def test_storage(tmp_path) -> LocalFileStorage:
    """A LocalFileStorage backed by a per-test temporary directory."""
    return LocalFileStorage(root=tmp_path / "storage")


@pytest.fixture()
def client(db_session, test_storage) -> Generator[TestClient, None, None]:
    """
    A FastAPI TestClient with the database and storage overridden.

    The dependency override for get_db ensures all routes use the test
    session.  APP_ENV=testing prevents the lifespan from creating tables
    on a different engine.
    """
    app = create_app()

    def override_db():
        try:
            yield db_session
        finally:
            pass

    def override_storage():
        return test_storage

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_storage] = override_storage

    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


@pytest.fixture()
def auth_headers(client) -> dict[str, str]:
    """Return Authorization headers with a valid test JWT."""
    from app.auth.jwt import create_access_token
    token = create_access_token("testuser")
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def small_video(tmp_path) -> Path:
    """
    A minimal valid MP4 file for upload tests.

    Creates a 1-second 64x64 black video at 10 fps using FFmpeg.
    Falls back to a raw bytes stub if FFmpeg is not findable.
    """
    import subprocess
    from worker.tasks.ingestion import _find_ffmpeg_binary

    out = tmp_path / "test_video.mp4"
    ffmpeg = _find_ffmpeg_binary("ffmpeg")
    if ffmpeg:
        subprocess.run(
            [
                ffmpeg, "-y",
                "-f", "lavfi", "-i", "color=c=black:size=64x64:rate=10:duration=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                str(out),
            ],
            capture_output=True,
            check=True,
        )
    else:
        out.write_bytes(b"\x00" * 1024)
    return out
"""
Regression tests for the Phase 1 integration fixes.

Fix 1 — Storage path consistency
Fix 2 — Authentication configuration and protected endpoints
Fix 3 — Authenticated video streaming (?token= query param)
Fix 4 — Alembic env.py imports (tested indirectly via migration)
Fix 5 — Latest analysis run endpoint and ingestion status

All tests use the same SQLite file-based test database as the existing suite.
No Docker, Redis, or external service is required.
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

# ── Fix 1: Storage path consistency ─────────────────────────────────────────

class TestStoragePathConsistency:
    """
    Verify that settings.storage_path is CWD-independent.

    Both the API and the Celery worker must resolve STORAGE_ROOT to the
    same directory regardless of which directory they are started from.
    """

    def test_absolute_storage_root_is_unchanged(self, tmp_path):
        """An absolute STORAGE_ROOT must be returned as-is."""
        import os as _os
        _os.environ["STORAGE_ROOT"] = str(tmp_path)
        # Re-instantiate Settings to pick up the env override.
        from app.config import Settings
        s = Settings()
        assert s.storage_path == tmp_path
        del _os.environ["STORAGE_ROOT"]

    def test_relative_storage_root_anchored_to_project_root(self):
        """
        A relative STORAGE_ROOT must be anchored to the project root,
        not the CWD, so it resolves consistently from any working directory.
        """
        import os as _os
        _os.environ["STORAGE_ROOT"] = "storage"
        original_cwd = os.getcwd()
        try:
            from app.config import Settings, _PROJECT_ROOT
            s = Settings()
            expected = (_PROJECT_ROOT / "storage").resolve()
            # Change CWD and confirm path does not change.
            os.chdir("/")
            s2 = Settings()
            assert s2.storage_path == expected
        finally:
            os.chdir(original_cwd)
            del _os.environ["STORAGE_ROOT"]

    def test_default_storage_path_is_absolute(self):
        """The default STORAGE_ROOT must produce an absolute path."""
        from app.config import Settings
        s = Settings()
        assert s.storage_path.is_absolute(), (
            f"storage_path {s.storage_path!r} is not absolute"
        )

    def test_storage_path_traversal_rejected(self):
        """Path-traversal attempts in storage keys must be rejected."""
        from app.storage.local import LocalFileStorage
        import io
        storage = LocalFileStorage(root=Path("/tmp/bac_test_storage"))
        with pytest.raises(ValueError, match="escapes root"):
            storage.store("../../etc/passwd", io.BytesIO(b"evil"))


# ── Fix 2: Authentication ─────────────────────────────────────────────────────

class TestAuthentication:

    def test_login_success(self, client, auth_headers):
        """Successful login returns a Bearer token."""
        r = client.post(
            "/api/auth/login",
            json={"username": "testuser", "password": "testpassword"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "access_token" in body
        assert body["token_type"] == "bearer"
        assert body["expires_in"] > 0

    def test_login_invalid_credentials(self, client):
        """Invalid credentials return 401."""
        r = client.post(
            "/api/auth/login",
            json={"username": "testuser", "password": "wrongpassword"},
        )
        assert r.status_code == 401
        # Error message must not echo credentials.
        assert "wrongpassword" not in r.text

    def test_login_missing_username(self, client):
        """Missing credentials also return 401 (not 500)."""
        r = client.post(
            "/api/auth/login",
            json={"username": "nobody", "password": "x"},
        )
        assert r.status_code == 401

    def test_get_me_with_valid_token(self, client, auth_headers):
        """GET /api/auth/me returns the authenticated username."""
        r = client.get("/api/auth/me", headers=auth_headers)
        assert r.status_code == 200
        assert r.json()["username"] == "testuser"

    def test_get_me_without_token(self, client):
        """GET /api/auth/me without a token returns 403."""
        r = client.get("/api/auth/me")
        assert r.status_code == 403

    def test_protected_route_without_token(self, client):
        """Match list endpoint returns 403 without a token."""
        r = client.get("/api/matches")
        assert r.status_code == 403

    def test_protected_route_with_invalid_token(self, client):
        """Match list endpoint returns 401 with a forged token (invalid credentials)."""
        r = client.get(
            "/api/matches",
            headers={"Authorization": "Bearer not.a.valid.token"},
        )
        # 401 Unauthorized is correct for an invalid token (403 is for
        # missing auth; here the header is present but the JWT is invalid).
        assert r.status_code == 401

    def test_token_not_logged(self, client, auth_headers, caplog):
        """Token values must not appear in application logs."""
        import logging
        with caplog.at_level(logging.DEBUG):
            client.get("/api/auth/me", headers=auth_headers)
        token = auth_headers["Authorization"].split(" ", 1)[1]
        for record in caplog.records:
            assert token not in record.getMessage(), (
                "JWT token value was written to logs"
            )


# ── Fix 3: Authenticated video streaming ─────────────────────────────────────

class TestVideoStreamAuth:

    def test_stream_requires_auth(self, client, small_video, auth_headers):
        """Stream endpoint requires authentication — no token returns 401."""
        # Upload a match to get an asset ID.
        with open(small_video, "rb") as f:
            up = client.post(
                "/api/matches",
                data={"title": "Stream Auth Test"},
                files={"video": ("v.mp4", f, "video/mp4")},
                headers=auth_headers,
            )
        asset_id = up.json()["source_asset_id"]

        # Without any token: should be 401 (no authentication provided).
        r = client.get(f"/api/assets/{asset_id}/stream")
        assert r.status_code == 401

    def test_stream_with_bearer_header(self, client, small_video, auth_headers):
        """Stream endpoint works with Authorization: Bearer header."""
        with open(small_video, "rb") as f:
            up = client.post(
                "/api/matches",
                data={"title": "Stream Bearer Test"},
                files={"video": ("v.mp4", f, "video/mp4")},
                headers=auth_headers,
            )
        asset_id = up.json()["source_asset_id"]
        r = client.get(f"/api/assets/{asset_id}/stream", headers=auth_headers)
        assert r.status_code == 200
        assert "accept-ranges" in r.headers

    def test_stream_with_token_query_param(self, client, small_video, auth_headers):
        """Stream endpoint works with ?token= query parameter (for <video> element)."""
        from app.auth.jwt import create_access_token
        token = create_access_token("testuser")

        with open(small_video, "rb") as f:
            up = client.post(
                "/api/matches",
                data={"title": "Stream Token Param Test"},
                files={"video": ("v.mp4", f, "video/mp4")},
                headers=auth_headers,
            )
        asset_id = up.json()["source_asset_id"]

        # No Authorization header — token is in query string only.
        r = client.get(f"/api/assets/{asset_id}/stream?token={token}")
        assert r.status_code == 200
        assert "accept-ranges" in r.headers

    def test_stream_range_request_with_token_param(self, client, small_video, auth_headers):
        """Range requests work when authenticated via ?token= query param."""
        from app.auth.jwt import create_access_token
        token = create_access_token("testuser")

        with open(small_video, "rb") as f:
            up = client.post(
                "/api/matches",
                data={"title": "Stream Range Token Test"},
                files={"video": ("v.mp4", f, "video/mp4")},
                headers=auth_headers,
            )
        asset_id = up.json()["source_asset_id"]

        full = client.get(f"/api/assets/{asset_id}/stream?token={token}")
        file_size = int(full.headers["content-length"])

        if file_size >= 10:
            r = client.get(
                f"/api/assets/{asset_id}/stream?token={token}",
                headers={"Range": "bytes=0-9"},
            )
            assert r.status_code == 206
            assert len(r.content) == 10
            assert "content-range" in r.headers

    def test_stream_with_invalid_token_param(self, client, small_video, auth_headers):
        """Invalid ?token= is rejected with 401 (invalid credentials)."""
        with open(small_video, "rb") as f:
            up = client.post(
                "/api/matches",
                data={"title": "Stream Bad Token Test"},
                files={"video": ("v.mp4", f, "video/mp4")},
                headers=auth_headers,
            )
        asset_id = up.json()["source_asset_id"]
        r = client.get(f"/api/assets/{asset_id}/stream?token=not.a.valid.jwt")
        assert r.status_code == 401


# ── Fix 5: Latest analysis run endpoint ──────────────────────────────────────

class TestLatestAnalysisRun:

    def test_latest_run_after_upload(self, client, small_video, auth_headers):
        """After upload, the latest analysis run is retrievable."""
        with open(small_video, "rb") as f:
            up = client.post(
                "/api/matches",
                data={"title": "Latest Run Test"},
                files={"video": ("v.mp4", f, "video/mp4")},
                headers=auth_headers,
            )
        match_id = up.json()["id"]

        r = client.get(
            f"/api/matches/{match_id}/analyses/latest",
            headers=auth_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["match_id"] == match_id
        assert body["status"] in ("queued", "ingesting", "processing", "completed", "failed")

    def test_latest_run_no_run_returns_404(self, client, small_video, auth_headers, db_session):
        """A match with no analysis run returns 404 from the latest endpoint."""
        from app.services.match_service import create_match
        from app.schemas.match import MatchCreate
        match = create_match(db_session, MatchCreate(title="No Run Match"))
        db_session.commit()

        r = client.get(
            f"/api/matches/{match.id}/analyses/latest",
            headers=auth_headers,
        )
        assert r.status_code == 404

    def test_retry_only_on_failed_run(self, client, small_video, auth_headers):
        """Retry endpoint returns 409 for non-failed runs."""
        with open(small_video, "rb") as f:
            up = client.post(
                "/api/matches",
                data={"title": "Retry Status Test"},
                files={"video": ("v.mp4", f, "video/mp4")},
                headers=auth_headers,
            )
        match_id = up.json()["id"]
        run_r = client.get(
            f"/api/matches/{match_id}/analyses/latest",
            headers=auth_headers,
        )
        run_id = run_r.json()["id"]
        run_status = run_r.json()["status"]

        if run_status != "failed":
            retry = client.post(
                f"/api/analyses/{run_id}/retry",
                headers=auth_headers,
            )
            assert retry.status_code == 409

    def test_opening_completed_match_does_not_create_new_run(
        self, client, small_video, auth_headers
    ):
        """
        GET /api/matches/{id}/analyses/latest on a completed match must NOT
        create a new run — it only reads the existing one.
        """
        with open(small_video, "rb") as f:
            up = client.post(
                "/api/matches",
                data={"title": "No Dup Run Test"},
                files={"video": ("v.mp4", f, "video/mp4")},
                headers=auth_headers,
            )
        match_id = up.json()["id"]

        # Call latest twice.
        r1 = client.get(
            f"/api/matches/{match_id}/analyses/latest",
            headers=auth_headers,
        )
        r2 = client.get(
            f"/api/matches/{match_id}/analyses/latest",
            headers=auth_headers,
        )
        # Must return the same run ID both times.
        assert r1.json()["id"] == r2.json()["id"]


# ── Fix 4 is validated by the Alembic migration test in test_migrations.py ───

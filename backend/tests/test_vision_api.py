"""
Tests for the Phase 2 vision API endpoints.

These tests use the ``client`` + ``auth_headers`` fixtures from conftest.
A completed-ingestion run is produced by uploading a match through the API
and running ``run_ingestion_sync`` with the patched-SessionLocal pattern
(from test_ingestion.py).  Track and pose rows are then injected directly
into the test session to exercise the read/update endpoints.  The Celery
dispatch is mocked implicitly — ``dispatch_vision`` returns None because
the worker task does not exist yet (FEAT-002), so no Redis is required.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from app.models.analysis_run import AnalysisRun
from app.models.player_track import PlayerTrack
from app.models.pose_frame import PoseFrame
from shared.enums import AnalysisStatus
from worker.tasks.ingestion import _find_ffmpeg_binary, run_ingestion_sync

_FFPROBE_AVAILABLE = _find_ffmpeg_binary("ffprobe") is not None


# ── SessionLocal patching helpers (mirror test_ingestion.py) ──────────────
class _FixedSession:
    """Returns the existing test session instead of a new one."""

    def __init__(self, session):
        self._session = session

    def __call__(self):
        return _NoCloseSession(self._session)


class _NoCloseSession:
    """Wraps the test session and suppresses close() calls."""

    def __init__(self, s):
        self._s = s

    def __getattr__(self, name):
        return getattr(self._s, name)

    def close(self):
        pass  # Don't close the test session.


def _complete_ingestion(db_session, run_id, match_id, test_storage) -> None:
    """Run real ingestion if ffprobe is available, else mark the run COMPLETED.

    Both paths leave the run COMPLETED so vision can start.  Real ingestion is
    preferred (it exercises the Phase 1 path the API reuses); the fallback
    keeps the vision tests green on machines without ffmpeg.
    """
    if _FFPROBE_AVAILABLE:
        import app.database as db_mod
        original = db_mod.SessionLocal
        db_mod.SessionLocal = _FixedSession(db_session)
        try:
            run_ingestion_sync(run_id=run_id, match_id=match_id, storage=test_storage)
        finally:
            db_mod.SessionLocal = original
    else:
        run = db_session.get(AnalysisRun, run_id)
        run.status = AnalysisStatus.COMPLETED.value
        run.progress_pct = 100
        run.completed_at = datetime.now(timezone.utc)
        db_session.commit()
    # Force the identity map to reload from the DB on the next access.
    db_session.expire_all()


def _upload_match(client, auth_headers, small_video, title="Vision Test Match") -> str:
    """Upload a match via the API and return its match id."""
    with open(small_video, "rb") as f:
        upload = client.post(
            "/api/matches",
            data={"title": title},
            files={"video": ("test.mp4", f, "video/mp4")},
            headers=auth_headers,
        )
    assert upload.status_code == 201, upload.text
    return upload.json()["id"]


def _latest_run_id(client, auth_headers, match_id) -> str:
    """Return the id of the latest analysis run for a match."""
    latest = client.get(
        f"/api/matches/{match_id}/analyses/latest", headers=auth_headers
    )
    assert latest.status_code == 200, latest.text
    return latest.json()["id"]


def _inject_track(
    db_session, run_id: str, track_id: int = 1, label: str = "player_1"
) -> PlayerTrack:
    track = PlayerTrack(
        analysis_run_id=run_id,
        track_id=track_id,
        track_label=label,
        is_selected_player=False,
    )
    db_session.add(track)
    db_session.commit()
    db_session.refresh(track)
    return track


def _inject_pose(
    db_session,
    run_id: str,
    track: PlayerTrack,
    timestamp_ms: int,
    frame_index: int,
    keypoints=None,
) -> PoseFrame:
    if keypoints is None:
        keypoints = [[float(i), float(i), 0.9] for i in range(17)]
    pose = PoseFrame(
        analysis_run_id=run_id,
        player_track_id=track.id,
        timestamp_ms=timestamp_ms,
        frame_index=frame_index,
        keypoints_json=json.dumps(keypoints),
        source_width=1920,
        source_height=1080,
    )
    db_session.add(pose)
    db_session.commit()
    return pose


# ── Fixtures ──────────────────────────────────────────────────────────────
@pytest.fixture()
def completed_run(client, auth_headers, small_video, test_storage, db_session) -> str:
    """Upload a match, run ingestion to completion, return the run id."""
    match_id = _upload_match(client, auth_headers, small_video)
    run_id = _latest_run_id(client, auth_headers, match_id)
    _complete_ingestion(db_session, run_id, match_id, test_storage)
    return run_id


@pytest.fixture()
def queued_run(client, auth_headers, small_video) -> str:
    """Upload a match but do NOT run ingestion; the run stays QUEUED."""
    match_id = _upload_match(client, auth_headers, small_video, title="Queued Run")
    return _latest_run_id(client, auth_headers, match_id)


# ── POST /vision ──────────────────────────────────────────────────────────
def test_start_vision_on_completed_run(client, auth_headers, completed_run):
    run_id = completed_run
    r = client.post(f"/api/analyses/{run_id}/vision", json={}, headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == run_id
    assert body["status"] == AnalysisStatus.PROCESSING.value
    assert body["current_stage"] == "load_video"
    assert body["progress_pct"] == 0


def test_start_vision_rejects_queued_run(client, auth_headers, queued_run):
    """A run whose ingestion has not completed cannot start vision (409)."""
    r = client.post(
        f"/api/analyses/{queued_run}/vision", json={}, headers=auth_headers
    )
    assert r.status_code == 409


def test_start_vision_rejects_active_run(client, auth_headers, completed_run):
    """Starting vision twice on the same run rejects the second (409)."""
    run_id = completed_run
    first = client.post(f"/api/analyses/{run_id}/vision", json={}, headers=auth_headers)
    assert first.status_code == 200
    assert first.json()["status"] == AnalysisStatus.PROCESSING.value

    second = client.post(f"/api/analyses/{run_id}/vision", json={}, headers=auth_headers)
    assert second.status_code == 409


# ── GET /tracks ───────────────────────────────────────────────────────────
def test_list_tracks(client, auth_headers, completed_run, db_session):
    run_id = completed_run
    _inject_track(db_session, run_id, track_id=1, label="player_1")
    _inject_track(db_session, run_id, track_id=2, label="player_2")

    r = client.get(f"/api/analyses/{run_id}/tracks", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 2
    # Ordered by track_id ascending.
    assert body[0]["track_id"] == 1
    assert body[0]["track_label"] == "player_1"
    assert body[1]["track_id"] == 2
    assert body[1]["is_selected_player"] is False


def test_list_tracks_empty(client, auth_headers, completed_run):
    r = client.get(f"/api/analyses/{completed_run}/tracks", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == []


# ── GET /poses ───────────────────────────────────────────────────────────
def test_list_poses_pagination_and_filters(
    client, auth_headers, completed_run, db_session
):
    run_id = completed_run
    track1 = _inject_track(db_session, run_id, track_id=1, label="player_1")
    track2 = _inject_track(db_session, run_id, track_id=2, label="player_2")
    # track1: t=0,1000,2000 ; track2: t=500
    _inject_pose(db_session, run_id, track1, 0, 0)
    _inject_pose(db_session, run_id, track1, 1000, 10)
    _inject_pose(db_session, run_id, track1, 2000, 20)
    _inject_pose(db_session, run_id, track2, 500, 5)

    # All poses for the run, ordered by timestamp_ms.
    r = client.get(f"/api/analyses/{run_id}/poses", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 4
    assert len(body["items"]) == 4
    assert [p["timestamp_ms"] for p in body["items"]] == [0, 500, 1000, 2000]
    assert body["has_more"] is False
    # keypoints parsed into a list of 17 triples.
    assert isinstance(body["items"][0]["keypoints"], list)
    assert len(body["items"][0]["keypoints"]) == 17

    # Filter by time window [0, 1000] (inclusive both ends).
    r = client.get(
        f"/api/analyses/{run_id}/poses?start_ms=0&end_ms=1000", headers=auth_headers
    )
    body = r.json()
    assert body["total"] == 3
    assert [p["timestamp_ms"] for p in body["items"]] == [0, 500, 1000]

    # Filter by track_id.
    r = client.get(
        f"/api/analyses/{run_id}/poses?track_id={track1.id}", headers=auth_headers
    )
    body = r.json()
    assert body["total"] == 3
    assert all(p["player_track_id"] == track1.id for p in body["items"])

    # Pagination: limit=2 → 2 items, has_more true, total still 4.
    r = client.get(
        f"/api/analyses/{run_id}/poses?limit=2&offset=0", headers=auth_headers
    )
    body = r.json()
    assert body["total"] == 4
    assert len(body["items"]) == 2
    assert body["has_more"] is True
    assert body["items"][0]["timestamp_ms"] == 0
    assert body["items"][1]["timestamp_ms"] == 500

    # Next page.
    r = client.get(
        f"/api/analyses/{run_id}/poses?limit=2&offset=2", headers=auth_headers
    )
    body = r.json()
    assert len(body["items"]) == 2
    assert body["has_more"] is False
    assert body["items"][0]["timestamp_ms"] == 1000


def test_list_poses_limit_clamped(client, auth_headers, completed_run, db_session):
    """limit above 1000 is rejected by the query param validation (le=1000)."""
    run_id = completed_run
    r = client.get(
        f"/api/analyses/{run_id}/poses?limit=1001", headers=auth_headers
    )
    assert r.status_code == 422  # Query param validation fails.


# ── PATCH /tracks/{id} ─────────────────────────────────────────────────────
def test_patch_track_identity(client, auth_headers, completed_run, db_session):
    run_id = completed_run
    track = _inject_track(db_session, run_id, track_id=1, label="player_1")

    r = client.patch(
        f"/api/analyses/{run_id}/tracks/{track.id}",
        json={"is_selected_player": True, "identity_note": "that's me"},
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == track.id
    assert body["is_selected_player"] is True
    assert body["identity_note"] == "that's me"

    # Only set fields are applied (identity_note alone).
    r2 = client.patch(
        f"/api/analyses/{run_id}/tracks/{track.id}",
        json={"identity_note": "updated note"},
        headers=auth_headers,
    )
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["identity_note"] == "updated note"
    # is_selected_player unchanged.
    assert body2["is_selected_player"] is True


def test_patch_track_unknown_returns_404(client, auth_headers, completed_run):
    r = client.patch(
        f"/api/analyses/{completed_run}/tracks/does-not-exist",
        json={"is_selected_player": True},
        headers=auth_headers,
    )
    assert r.status_code == 404


# ── POST /corrections ─────────────────────────────────────────────────────
def test_post_correction(client, auth_headers, completed_run, db_session):
    run_id = completed_run
    track = _inject_track(db_session, run_id, track_id=1, label="player_1")

    r = client.post(
        f"/api/analyses/{run_id}/corrections",
        json={
            "entity_type": "player_track",
            "entity_id": track.id,
            "correction_data": {"is_selected_player": True, "note": "fix"},
        },
        headers=auth_headers,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["analysis_run_id"] == run_id
    assert body["entity_type"] == "player_track"
    assert body["entity_id"] == track.id
    # correction_data parsed back into a dict.
    assert body["correction_data"] == {"is_selected_player": True, "note": "fix"}
    assert "id" in body
    assert "created_at" in body


# ── 404 for unknown run ───────────────────────────────────────────────────
def test_vision_endpoints_404_unknown_run(client, auth_headers):
    assert client.post(
        "/api/analyses/no-such-run/vision", json={}, headers=auth_headers
    ).status_code == 404
    assert client.get(
        "/api/analyses/no-such-run/tracks", headers=auth_headers
    ).status_code == 404
    assert client.get(
        "/api/analyses/no-such-run/poses", headers=auth_headers
    ).status_code == 404
    assert client.post(
        "/api/analyses/no-such-run/corrections",
        json={"entity_type": "player_track", "entity_id": "x", "correction_data": {}},
        headers=auth_headers,
    ).status_code == 404

"""
Tests for the Phase 2 vision worker pipeline.

These tests call run_vision_sync() directly with a mocked ModelAdapter
so no real YOLO model or GPU is required.  The mock adapter produces
deterministic fake detections, keypoints, and track IDs.

Tests cover:
  - Frame skip computation (dynamic, handles 30/60 fps)
  - Device resolution (auto falls back to cpu when torch absent)
  - Vision pipeline completes and persists tracks + poses
  - Idempotency (running twice is safe)
  - Failure handling (missing asset, model load error)
  - Progress updates are written to the analysis run
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from app.models.analysis_run import AnalysisRun
from app.models.match import Match
from app.models.player_track import PlayerTrack
from app.models.pose_frame import PoseFrame
from app.services.asset_service import store_upload
from app.services.job_service import create_analysis_run
from app.services.match_service import create_match
from app.schemas.match import MatchCreate
from shared.enums import AnalysisStatus, AssetType, MatchStatus
from worker.tasks.vision import _compute_frame_skip, _resolve_device, run_vision_sync


# ── Helpers (same pattern as test_ingestion.py) ────────────────────────────

class _FixedSession:
    def __init__(self, session): self._session = session
    def __call__(self): return _NoCloseSession(self._session)

class _NoCloseSession:
    def __init__(self, s): self._s = s
    def __getattr__(self, n): return getattr(self._s, n)
    def close(self): pass


# ── Mock ModelAdapter ──────────────────────────────────────────────────────

class MockDetection:
    """A minimal mock detection that matches the Detection dataclass shape."""
    def __init__(self, track_id, frame_idx=0, keypoints=None):
        self.bbox = (100.0 + track_id * 200, 100.0, 80.0, 120.0)
        self.bbox_conf = 0.85
        self.track_id = track_id
        self.keypoints = keypoints or [[float(i), float(i), 0.9] for i in range(17)]
        self.keypoint_conf = 0.75
        self.model_id = "mock-pose"


class MockAdapter:
    """A mock ModelAdapter that yields fake detections for a fixed number of frames."""
    def __init__(self, num_frames=10, tracks=(1, 2)):
        self._num_frames = num_frames
        self._tracks = tracks
        self._loaded = False
        self.load_error = None

    def load(self, device: str) -> None:
        if self.load_error:
            raise RuntimeError(self.load_error)
        self._loaded = True

    def infer_video(self, video_path, frame_skip, confidence, img_size):
        """Yield (frame_index, frame, [Detection, ...]) for every frame_skip-th frame.

        The frame value is a dummy — the vision task only uses frame_index
        and detections.  We avoid importing numpy so the mock works without
        heavy CV dependencies installed.
        """
        dummy_frame = None  # The vision task doesn't use the frame in mock mode.
        for i in range(0, self._num_frames, frame_skip):
            detections = []
            for tid in self._tracks:
                detections.append(MockDetection(track_id=tid, frame_idx=i))
            yield (i, dummy_frame, detections)

    def infer_frame(self, frame):
        return [MockDetection(track_id=1)]

    def unload(self) -> None:
        self._loaded = False


# ── Frame skip computation ──────────────────────────────────────────────────

class TestFrameSkip:

    def test_30fps_target_15(self):
        assert _compute_frame_skip(30.0, 15) == 2

    def test_60fps_target_15(self):
        assert _compute_frame_skip(60.0, 15) == 4

    def test_30fps_target_30(self):
        assert _compute_frame_skip(30.0, 30) == 1

    def test_60fps_target_0_means_every_frame(self):
        assert _compute_frame_skip(60.0, 0) == 1

    def test_50fps_target_10(self):
        assert _compute_frame_skip(50.0, 10) == 5

    def test_24fps_target_15(self):
        assert _compute_frame_skip(24.0, 15) == 2


# ── Device resolution ──────────────────────────────────────────────────────

class TestDeviceResolution:

    def test_cpu_device(self):
        assert _resolve_device("cpu") == "cpu"

    def test_empty_defaults_to_cpu(self):
        assert _resolve_device("") == "cpu"

    def test_auto_falls_back_to_cpu(self):
        result = _resolve_device("auto")
        assert result in ("cpu", "cuda:0")

    def test_cuda_unavailable_raises(self):
        try:
            import torch
            if torch.cuda.is_available():
                pytest.skip("CUDA available — cannot test failure path")
        except ImportError:
            pass
        with pytest.raises(RuntimeError, match="CUDA"):
            _resolve_device("cuda:0")


# ── Vision pipeline (mocked) ───────────────────────────────────────────────

@pytest.fixture()
def vision_test_setup(db_session, test_storage, small_video):
    """
    Create a match with a source video and a run in PROCESSING state
    (simulating what the API does when it dispatches vision).
    """
    match = create_match(db_session, MatchCreate(title="Vision Worker Test"))
    with open(small_video, "rb") as f:
        store_upload(
            db=db_session, storage=test_storage, match_id=match.id,
            source=f, original_filename="test.mp4", asset_type=AssetType.VIDEO_ORIGINAL,
        )
    db_session.commit()

    run = create_analysis_run(db_session, match.id)
    # Simulate what the API does: set to PROCESSING before dispatching.
    run.status = AnalysisStatus.PROCESSING.value
    run.current_stage = "load_video"
    run.progress_pct = 0
    # Set metadata that the vision task needs.
    match.width = 1920
    match.height = 1080
    match.fps_num = 30
    match.fps_den = 1
    match.duration_ms = 10000
    match.status = MatchStatus.READY.value
    db_session.commit()
    return match, run, db_session


class TestVisionPipeline:

    def test_vision_completes_and_persists(self, vision_test_setup, test_storage):
        """Vision task with mock adapter creates tracks and poses."""
        match, run, db_session = vision_test_setup
        import app.database as db_mod
        original = db_mod.SessionLocal
        db_mod.SessionLocal = _FixedSession(db_session)

        try:
            adapter = MockAdapter(num_frames=10, tracks=(1, 2))
            run_vision_sync(
                run_id=run.id, match_id=match.id,
                storage=test_storage, adapter=adapter,
            )
        finally:
            db_mod.SessionLocal = original

        db_session.expire_all()
        updated_run = db_session.get(AnalysisRun, run.id)
        assert updated_run.status == AnalysisStatus.COMPLETED.value
        assert updated_run.progress_pct == 100

        tracks = db_session.query(PlayerTrack).filter(
            PlayerTrack.analysis_run_id == run.id
        ).all()
        assert len(tracks) == 2
        assert {t.track_id for t in tracks} == {1, 2}
        assert tracks[0].track_label == "player_1"
        assert tracks[1].track_label == "player_2"

        poses = db_session.query(PoseFrame).filter(
            PoseFrame.analysis_run_id == run.id
        ).all()
        assert len(poses) > 0
        kp = json.loads(poses[0].keypoints_json)
        assert len(kp) == 17
        assert poses[0].timestamp_ms is not None
        assert poses[0].frame_index is not None
        assert poses[0].source_width == 1920
        assert poses[0].source_height == 1080
        assert poses[0].model_id == "mock-pose"

    def test_vision_idempotent(self, vision_test_setup, test_storage):
        """Running vision twice on a completed run is a no-op."""
        match, run, db_session = vision_test_setup
        import app.database as db_mod
        original = db_mod.SessionLocal
        db_mod.SessionLocal = _FixedSession(db_session)

        try:
            adapter = MockAdapter(num_frames=10, tracks=(1, 2))
            run_vision_sync(run_id=run.id, match_id=match.id,
                           storage=test_storage, adapter=adapter)
            # Second call should skip (run already COMPLETED).
            run_vision_sync(run_id=run.id, match_id=match.id,
                           storage=test_storage, adapter=adapter)
        finally:
            db_mod.SessionLocal = original

        db_session.expire_all()
        updated_run = db_session.get(AnalysisRun, run.id)
        assert updated_run.status == AnalysisStatus.COMPLETED.value

    def test_vision_model_load_error(self, vision_test_setup, test_storage):
        """A model load error marks the run FAILED."""
        match, run, db_session = vision_test_setup
        import app.database as db_mod
        original = db_mod.SessionLocal
        db_mod.SessionLocal = _FixedSession(db_session)

        try:
            adapter = MockAdapter(num_frames=10, tracks=(1, 2))
            adapter.load_error = "CUDA not available"
            run_vision_sync(run_id=run.id, match_id=match.id,
                           storage=test_storage, adapter=adapter)
        finally:
            db_mod.SessionLocal = original

        db_session.expire_all()
        updated_run = db_session.get(AnalysisRun, run.id)
        assert updated_run.status == AnalysisStatus.FAILED.value
        assert updated_run.error_code == "MODEL_LOAD_ERROR"
        assert "CUDA not available" in (updated_run.error_message or "")

    def test_vision_missing_asset(self, db_session, test_storage):
        """Vision on a match with no source asset fails gracefully."""
        match = create_match(db_session, MatchCreate(title="No Asset Match"))
        run = create_analysis_run(db_session, match.id)
        run.status = AnalysisStatus.PROCESSING.value
        db_session.commit()

        import app.database as db_mod
        original = db_mod.SessionLocal
        db_mod.SessionLocal = _FixedSession(db_session)

        try:
            run_vision_sync(run_id=run.id, match_id=match.id,
                           storage=test_storage, adapter=MockAdapter())
        finally:
            db_mod.SessionLocal = original

        db_session.expire_all()
        updated_run = db_session.get(AnalysisRun, run.id)
        assert updated_run.status == AnalysisStatus.FAILED.value
        assert updated_run.error_code == "NO_SOURCE_ASSET"

    def test_vision_run_not_found(self, db_session, test_storage):
        """Vision on a non-existent run exits without raising."""
        import app.database as db_mod
        original = db_mod.SessionLocal
        db_mod.SessionLocal = _FixedSession(db_session)
        try:
            run_vision_sync(run_id="nonexistent-run", match_id="nonexistent-match",
                           storage=test_storage, adapter=MockAdapter())
        finally:
            db_mod.SessionLocal = original

"""
Phase 2 vision pipeline: player detection, tracking, and pose estimation.

This Celery task runs the YOLO11n-pose model on the source video, assigns
stable track IDs via ByteTrack, estimates 17 COCO keypoints per player per
sampled frame, and persists the results to `player_tracks` and `pose_frames`.

Stages (mirrored by VisionStage enum):
  load_video → load_model → detect_players → track_and_pose → save_results → finalize

Heavy dependencies (torch, ultralytics, cv2) are imported lazily inside the
task body so that this module can be imported in environments where those
packages are not installed (e.g. unit tests with mocks).

Device handling:
  - "auto": uses CUDA if available, else CPU.
  - "cpu": forces CPU.
  - "cuda": requires GPU; errors if unavailable.

Frame skip:
  Computed dynamically from the source video fps and VISION_TARGET_FPS:
    frame_skip = max(1, round(source_fps / target_fps))
  target_fps=0 means process every frame (frame_skip=1).
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

# Ensure project root and backend are importable.
_project_root = Path(__file__).resolve().parents[2]
_backend_root = _project_root / "backend"
for _p in (str(_project_root), str(_backend_root)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

logger = logging.getLogger(__name__)


def _resolve_device(device: str) -> str:
    """Resolve the inference device, falling back to CPU if CUDA unavailable."""
    if device in ("cpu", ""):
        return "cpu"
    if device == "auto":
        try:
            import torch  # noqa: PLC0415
            if torch.cuda.is_available():
                return "cuda:0"
        except ImportError:
            pass
        return "cpu"
    if device.startswith("cuda"):
        try:
            import torch  # noqa: PLC0415
            if not torch.cuda.is_available():
                raise RuntimeError(
                    f"CUDA device requested ({device!r}) but torch.cuda.is_available() is False. "
                    "Set INFERENCE_DEVICE=auto or cpu in .env."
                )
        except ImportError:
            raise RuntimeError("PyTorch is not installed — cannot use CUDA.")
        return device
    return "cpu"


def _compute_frame_skip(source_fps: float, target_fps: int) -> int:
    """
    Compute the frame skip divisor from the source fps and target fps.

    target_fps=0 means process every frame (return 1).
    A 60fps video with target_fps=15 → frame_skip=4.
    A 30fps video with target_fps=15 → frame_skip=2.
    """
    if target_fps <= 0:
        return 1
    return max(1, round(source_fps / target_fps))


def run_vision_sync(
    run_id: str,
    match_id: str,
    storage=None,
    adapter=None,
) -> None:
    """
    Synchronous vision pipeline — callable from tests without Celery.

    Parameters:
      run_id: The analysis_run ID.
      match_id: The match ID (used to locate the source video).
      storage: Optional LocalFileStorage instance (for test injection).
      adapter: Optional ModelAdapter instance (for test injection / mocking).
               If None, a real YoloPoseAdapter is created and loaded.

    Heavy dependencies are imported lazily inside the function body.
    """
    from app.database import SessionLocal
    from app.models.analysis_run import AnalysisRun
    from app.models.match import Match
    from app.models.player_track import PlayerTrack
    from app.models.pose_frame import PoseFrame
    from app.services.asset_service import get_source_asset
    from app.services.job_service import (
        mark_run_completed,
        mark_run_failed,
        mark_vision_started,
        update_run_progress,
    )
    from app.storage.local import LocalFileStorage
    from app.config import settings
    from shared.enums import AnalysisStatus, VisionStage

    db = SessionLocal()
    if storage is None:
        storage = LocalFileStorage()

    try:
        run = db.get(AnalysisRun, run_id)
        if not run:
            logger.error("Vision: run %s not found in database.", run_id)
            return

        # Idempotency: if already completed, skip.
        if run.status == AnalysisStatus.COMPLETED.value:
            logger.info("Vision: run %s already completed, skipping.", run_id)
            return

        match = db.get(Match, match_id)
        if not match:
            mark_run_failed(db, run, "MATCH_NOT_FOUND", f"Match {match_id} not found.")
            return

        mark_vision_started(db, run, VisionStage.LOAD_VIDEO.value)
        update_run_progress(db, run, 2, VisionStage.LOAD_VIDEO.value)
        logger.info("Vision started: run=%s match=%s", run_id, match_id)

        # ── Step 1: Locate the source video ───────────────────────────────
        asset = get_source_asset(db, match_id)
        if not asset:
            mark_run_failed(db, run, "NO_SOURCE_ASSET", "No source video asset found.")
            return
        if not storage.exists(asset.storage_key):
            mark_run_failed(db, run, "FILE_NOT_FOUND",
                            f"Source file missing: {asset.storage_key}")
            return

        video_path = storage.resolve_path(asset.storage_key)
        update_run_progress(db, run, 5, VisionStage.LOAD_VIDEO.value)

        # ── Step 2: Get source video fps and compute frame skip ────────────
        # Use the stored fps from ingestion; fall back to cv2 if missing.
        source_fps = match.fps_num / match.fps_den if match.fps_num and match.fps_den else 30.0
        target_fps = settings.vision_target_fps
        frame_skip = _compute_frame_skip(source_fps, target_fps)
        logger.info("Source fps=%.1f, target_fps=%d, frame_skip=%d",
                    source_fps, target_fps, frame_skip)

        # ── Step 3: Load the model ─────────────────────────────────────────
        update_run_progress(db, run, 8, VisionStage.LOAD_MODEL.value)

        device = _resolve_device(settings.inference_device)
        logger.info("Using inference device: %s", device)

        if adapter is None:
            from worker.models.yolo_pose import YoloPoseAdapter
            adapter = YoloPoseAdapter(weights_dir=settings.model_weights_dir)

        try:
            adapter.load(device)
        except Exception as exc:
            mark_run_failed(db, run, "MODEL_LOAD_ERROR", str(exc)[:500])
            return

        update_run_progress(db, run, 10, VisionStage.DETECT_PLAYERS.value)

        # ── Step 4: Run detection + tracking + pose ────────────────────────
        # Track which track_ids we've seen to create PlayerTrack rows.
        track_map: dict[int, PlayerTrack] = {}
        track_label_counter = 0
        pose_frames_to_save: list[dict] = []
        total_frames = 0
        frames_processed = 0

        try:
            for frame_index, frame, detections in adapter.infer_video(
                video_path=str(video_path),
                frame_skip=frame_skip,
                confidence=settings.vision_confidence,
                img_size=settings.vision_img_size,
            ):
                frames_processed += 1
                total_frames = frame_index  # track the last frame index

                # Compute timestamp from frame index and source fps.
                timestamp_ms = int((frame_index / source_fps) * 1000)

                for det in detections:
                    # Skip detections without a track_id (no person tracked).
                    if det.track_id is None:
                        continue

                    # Create a PlayerTrack row if this is the first sighting.
                    if det.track_id not in track_map:
                        track_label_counter += 1
                        pt = PlayerTrack(
                            analysis_run_id=run_id,
                            track_id=det.track_id,
                            track_label=f"player_{track_label_counter}",
                            is_selected_player=False,
                        )
                        db.add(pt)
                        db.flush()  # get the ID
                        track_map[det.track_id] = pt

                    pt = track_map[det.track_id]

                    # Build the pose frame record.
                    pf = PoseFrame(
                        analysis_run_id=run_id,
                        player_track_id=pt.id,
                        timestamp_ms=timestamp_ms,
                        frame_index=frame_index,
                        bbox_x=det.bbox[0],
                        bbox_y=det.bbox[1],
                        bbox_w=det.bbox[2],
                        bbox_h=det.bbox[3],
                        bbox_conf=det.bbox_conf,
                        keypoints_json=json.dumps(det.keypoints),
                        overall_conf=det.keypoint_conf,
                        source_width=match.width or frame.shape[1],
                        source_height=match.height or frame.shape[0],
                        model_id=det.model_id,
                    )
                    db.add(pf)
                    pose_frames_to_save.append(pf)

                # Update progress (10–80% range for the tracking loop).
                # Estimate: if we know the duration, compute % from timestamp.
                if match.duration_ms and match.duration_ms > 0:
                    pct = 10 + int(70 * (timestamp_ms / match.duration_ms))
                    update_run_progress(db, run, min(pct, 80),
                                        VisionStage.TRACK_AND_POSE.value)

                # Batch commit every 100 frames to avoid huge transactions.
                if frames_processed % 100 == 0:
                    db.commit()
                    logger.info("Processed %d frames (last_idx=%d, ts=%dms)",
                                frames_processed, frame_index, timestamp_ms)

        except Exception as exc:
            logger.exception("Vision inference failed: run=%s", run_id)
            mark_run_failed(db, run, "VISION_ERROR", str(exc)[:500])
            try:
                adapter.unload()
            except Exception:
                pass
            return

        # ── Step 5: Save remaining results ──────────────────────────────────
        update_run_progress(db, run, 80, VisionStage.SAVE_RESULTS.value)
        db.commit()

        logger.info("Vision complete: %d frames processed, %d tracks, %d pose frames",
                    frames_processed, len(track_map),
                    len(pose_frames_to_save))

        # ── Step 6: Finalize ────────────────────────────────────────────────
        update_run_progress(db, run, 95, VisionStage.FINALIZE.value)

        # Update the pipeline_config with the actual settings used.
        run.pipeline_config = json.dumps({
            "frame_skip": frame_skip,
            "source_fps": source_fps,
            "target_fps": target_fps,
            "device": device,
            "confidence": settings.vision_confidence,
            "img_size": settings.vision_img_size,
            "model_id": "yolo11n-pose",
        })
        db.commit()

        mark_run_completed(db, run)
        logger.info("Vision finalized: run=%s match=%s", run_id, match_id)

        try:
            adapter.unload()
        except Exception:
            pass

    except Exception as exc:
        logger.exception("Vision failed unexpectedly: run=%s", run_id)
        try:
            run_obj = db.get(AnalysisRun, run_id)
            if run_obj:
                from app.services.job_service import mark_run_failed as _fail
                _fail(db, run_obj, "UNEXPECTED_ERROR", str(exc)[:500])
        except Exception:
            pass
        raise
    finally:
        db.close()


# ── Celery task wrapper ───────────────────────────────────────────────────────

try:
    from worker.celery_app import celery_app as _celery_app

    @_celery_app.task(name="worker.tasks.vision.run_vision", bind=True, max_retries=2)
    def run_vision(self, *, run_id: str, match_id: str) -> None:  # type: ignore[misc]
        try:
            run_vision_sync(run_id=run_id, match_id=match_id)
        except Exception as exc:
            raise self.retry(exc=exc, countdown=30)

except ImportError:
    def run_vision(*, run_id: str, match_id: str) -> None:  # type: ignore[misc]
        run_vision_sync(run_id=run_id, match_id=match_id)

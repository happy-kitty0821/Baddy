"""
Stage 1: Ingestion task.

Responsibilities:
  1. Validate the stored video file exists.
  2. Compute and verify the SHA-256 checksum.
  3. Extract video metadata (duration, resolution, fps, codec) via FFmpeg.
  4. Update the match record with extracted metadata.
  5. Mark the analysis run COMPLETED (ingestion phase done).
  6. Update the match status to READY.

This task is idempotent: running it twice for the same run ID is safe.
If the run is already COMPLETED, the task exits without changing anything.

Error handling:
  - Any exception marks the run FAILED with an error code and message.
  - The match status is NOT changed to FAILED — the original video and
    match record are preserved regardless of ingestion failure.
  - The caller can retry by creating a new analysis run.

FFmpeg dependency:
  - `ffprobe` must be on PATH.
  - On the development machine: installed via winget (FFmpeg 9.0.2).
  - On Linux production: install via package manager or Docker image.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import subprocess
import sys
from pathlib import Path

# Ensure project root and backend are importable when this module is loaded.
_project_root = Path(__file__).resolve().parents[2]
_backend_root = _project_root / "backend"
for _p in (str(_project_root), str(_backend_root)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from app.storage.local import LocalFileStorage  # noqa: E402

logger = logging.getLogger(__name__)


def _compute_checksum(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """Compute the SHA-256 checksum of a file on disk."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            h.update(chunk)
    return h.hexdigest()


def _extract_video_metadata(path: Path) -> dict:
    """
    Run ffprobe and return a dict with duration_ms, width, height,
    fps_num, fps_den, and codec.

    Raises RuntimeError if ffprobe fails or produces unexpected output.
    """
    if not shutil.which("ffprobe"):
        raise RuntimeError(
            "ffprobe is not on PATH. "
            "Install FFmpeg (e.g. `winget install Gyan.FFmpeg` on Windows, "
            "`apt install ffmpeg` on Debian/Ubuntu)."
        )

    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffprobe failed (exit {result.returncode}): {result.stderr[:500]}"
        )

    data = json.loads(result.stdout)
    video_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "video"),
        None,
    )
    if not video_stream:
        raise RuntimeError("No video stream found in file.")

    # Duration: prefer format-level duration, fall back to stream-level.
    raw_duration = (
        data.get("format", {}).get("duration")
        or video_stream.get("duration")
    )
    duration_ms = int(float(raw_duration) * 1000) if raw_duration else None

    # Frame rate: stored as a fraction string like "30/1" or "2997/100".
    r_frame_rate = video_stream.get("r_frame_rate", "0/1")
    fps_num, fps_den = (int(x) for x in r_frame_rate.split("/"))

    return {
        "duration_ms": duration_ms,
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "fps_num": fps_num,
        "fps_den": fps_den,
        "codec": video_stream.get("codec_name"),
    }


def run_ingestion_sync(
    run_id: str,
    match_id: str,
    storage: LocalFileStorage | None = None,
) -> None:
    """
    Synchronous ingestion logic — callable from tests without Celery.

    The optional *storage* parameter allows tests to inject a temporary
    storage backend without monkeypatching module-level names.
    """
    from app.database import SessionLocal
    from app.models.analysis_run import AnalysisRun
    from app.models.match import Match
    from app.services.asset_service import get_source_asset
    from app.services.job_service import (
        mark_run_completed,
        mark_run_failed,
        mark_run_started,
        update_run_progress,
    )
    from shared.enums import AnalysisStatus, MatchStatus

    db = SessionLocal()
    if storage is None:
        storage = LocalFileStorage()

    try:
        run: AnalysisRun | None = db.get(AnalysisRun, run_id)
        if not run:
            logger.error("Ingestion: run %s not found in database.", run_id)
            return

        # Idempotency guard.
        if run.status == AnalysisStatus.COMPLETED.value:
            logger.info("Ingestion: run %s already completed, skipping.", run_id)
            return

        match: Match | None = db.get(Match, match_id)
        if not match:
            mark_run_failed(db, run, "MATCH_NOT_FOUND", f"Match {match_id} not found.")
            return

        mark_run_started(db, run, "validate")
        update_run_progress(db, run, 5, "validate")
        logger.info("Ingestion started: run=%s match=%s", run_id, match_id)

        # ── Step 1: Locate the source asset ───────────────────────────────
        asset = get_source_asset(db, match_id)
        if not asset:
            mark_run_failed(db, run, "NO_SOURCE_ASSET", "No source video asset found.")
            return

        update_run_progress(db, run, 10, "locate_file")

        # ── Step 2: Verify the file exists in storage ──────────────────────
        if not storage.exists(asset.storage_key):
            mark_run_failed(
                db, run, "FILE_NOT_FOUND",
                f"Source file missing from storage: {asset.storage_key}"
            )
            return

        file_path = storage.resolve_path(asset.storage_key)
        update_run_progress(db, run, 20, "checksum")

        # ── Step 3: Compute checksum ────────────────────────────────────────
        computed_checksum = _compute_checksum(file_path)

        # If a checksum was stored at upload time, verify it matches.
        if asset.checksum and asset.checksum != computed_checksum:
            mark_run_failed(
                db, run, "CHECKSUM_MISMATCH",
                f"Stored checksum {asset.checksum!r} does not match "
                f"computed {computed_checksum!r}."
            )
            return

        # Store/confirm checksum on both asset and match.
        asset.checksum = computed_checksum
        if not match.checksum:
            match.checksum = computed_checksum
        db.commit()

        update_run_progress(db, run, 50, "extract_metadata")

        # ── Step 4: Extract video metadata ─────────────────────────────────
        try:
            meta = _extract_video_metadata(file_path)
        except RuntimeError as exc:
            mark_run_failed(db, run, "FFPROBE_ERROR", str(exc))
            return

        update_run_progress(db, run, 80, "persist_metadata")

        # ── Step 5: Persist metadata to match record ───────────────────────
        match.duration_ms = meta["duration_ms"]
        match.width = meta["width"]
        match.height = meta["height"]
        match.fps_num = meta["fps_num"]
        match.fps_den = meta["fps_den"]
        match.codec = meta["codec"]
        match.file_size_bytes = asset.size_bytes or storage.size(asset.storage_key)
        match.status = MatchStatus.READY.value
        db.commit()

        update_run_progress(db, run, 95, "finalize")

        # ── Step 6: Finalise ────────────────────────────────────────────────
        mark_run_completed(db, run)
        logger.info(
            "Ingestion completed: run=%s match=%s duration_ms=%s codec=%s",
            run_id, match_id, meta["duration_ms"], meta["codec"],
        )

    except Exception as exc:
        logger.exception("Ingestion failed unexpectedly: run=%s", run_id)
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


try:
    from worker.celery_app import celery_app as _celery_app

    @_celery_app.task(name="worker.tasks.ingestion.run_ingestion", bind=True, max_retries=2)
    def run_ingestion(self, *, run_id: str, match_id: str) -> None:  # type: ignore[misc]
        try:
            run_ingestion_sync(run_id=run_id, match_id=match_id)
        except Exception as exc:
            raise self.retry(exc=exc, countdown=30)

except ImportError:
    # Celery not importable in this context (e.g. lightweight test env).
    def run_ingestion(*, run_id: str, match_id: str) -> None:  # type: ignore[misc]
        run_ingestion_sync(run_id=run_id, match_id=match_id)

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


# ── FFmpeg binary resolution ─────────────────────────────────────────────────

# Windows-specific fallback locations to try when ffprobe is not on PATH.
# Covers winget installation paths (Gyan.FFmpeg) and common manual installs.
_WINDOWS_FFMPEG_CANDIDATES = [
    # winget Gyan.FFmpeg (full build and essentials)
    r"C:\Users\{user}\AppData\Local\Microsoft\WinGet\Packages",
    r"C:\Program Files\FFmpeg\bin",
    r"C:\FFmpeg\bin",
    r"C:\tools\ffmpeg\bin",
]

# Linux fallback locations (used on the Ubuntu production server).
_LINUX_FFMPEG_CANDIDATES = [
    "/usr/bin",
    "/usr/local/bin",
    "/opt/ffmpeg/bin",
    "/snap/bin",
]


def _find_ffmpeg_binary(name: str) -> str | None:
    """
    Resolve the path to an FFmpeg binary (ffmpeg or ffprobe).

    Resolution order:
    1. FFMPEG_BIN setting from .env (explicit override — highest priority).
    2. shutil.which(name) — finds the binary if it is on the inherited PATH.
    3. Platform-specific fallback locations (for processes that don't inherit
       the shell PATH, e.g. Celery workers started from a bare terminal).

    Returns the absolute path string, or None if not found.
    """
    import os

    # 1. Explicit override from settings.
    from app.config import settings
    if settings.ffmpeg_bin:
        candidate = Path(settings.ffmpeg_bin) / (name + (".exe" if sys.platform == "win32" else ""))
        if candidate.exists():
            return str(candidate)
        logger.warning("FFMPEG_BIN is set to %r but %s was not found there.", settings.ffmpeg_bin, name)

    # 2. Standard PATH lookup (refreshing PATH from the OS registry on Windows).
    if sys.platform == "win32":
        # The worker process may not have inherited the updated User PATH.
        # Re-read it from the registry and prepend it to the subprocess search.
        machine_path = os.environ.get("PATH", "")
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment") as key:
                user_path, _ = winreg.QueryValueEx(key, "Path")
            # Temporarily extend os.environ for this lookup only.
            original = os.environ["PATH"]
            os.environ["PATH"] = user_path + ";" + machine_path
            found = shutil.which(name)
            os.environ["PATH"] = original
            if found:
                return found
        except Exception:
            pass

    found = shutil.which(name)
    if found:
        return found

    # 3. Platform fallback scan.
    exe_name = name + (".exe" if sys.platform == "win32" else "")
    if sys.platform == "win32":
        import os as _os
        # Expand {user} placeholder.
        user_home = _os.path.expanduser("~")
        username = _os.path.basename(user_home)
        # Walk the winget packages directory for any FFmpeg variant.
        winget_base = Path(user_home) / "AppData" / "Local" / "Microsoft" / "WinGet" / "Packages"
        if winget_base.exists():
            for pkg_dir in winget_base.iterdir():
                if "FFmpeg" in pkg_dir.name or "ffmpeg" in pkg_dir.name:
                    for bin_dir in pkg_dir.rglob("bin"):
                        candidate = bin_dir / exe_name
                        if candidate.exists():
                            return str(candidate)
        # Fixed locations.
        for loc in [r"C:\Program Files\FFmpeg\bin", r"C:\FFmpeg\bin", r"C:\tools\ffmpeg\bin"]:
            candidate = Path(loc) / exe_name
            if candidate.exists():
                return str(candidate)
    else:
        for loc in _LINUX_FFMPEG_CANDIDATES:
            candidate = Path(loc) / exe_name
            if candidate.exists():
                return str(candidate)

    return None


def _require_ffmpeg_binary(name: str) -> str:
    """
    Return the path to an FFmpeg binary or raise a clear RuntimeError.
    """
    path = _find_ffmpeg_binary(name)
    if path:
        return path
    if sys.platform == "win32":
        install_hint = "`winget install Gyan.FFmpeg` — then restart the terminal/worker."
        config_hint = (
            "Or set FFMPEG_BIN in .env to the directory containing ffprobe.exe, e.g.:\n"
            r"  FFMPEG_BIN=C:/Users/YourName/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_.../ffmpeg-9.0.2-full_build/bin"
        )
    else:
        install_hint = "`apt install ffmpeg` (Debian/Ubuntu) or `dnf install ffmpeg` (Fedora)."
        config_hint = "Or set FFMPEG_BIN in .env to the directory containing ffprobe."
    raise RuntimeError(
        f"{name} not found on PATH or in any known location.\n"
        f"Install FFmpeg: {install_hint}\n{config_hint}"
    )


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

    Uses _require_ffmpeg_binary() which checks PATH, the FFMPEG_BIN setting,
    and platform-specific fallback locations.  This handles the common Windows
    case where winget installed FFmpeg to the User PATH but the Celery worker
    process was started before the PATH was refreshed.

    Raises RuntimeError if ffprobe is not found or produces unexpected output.
    """
    ffprobe = _require_ffmpeg_binary("ffprobe")
    logger.debug("Using ffprobe: %s", ffprobe)

    cmd = [
        ffprobe,
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

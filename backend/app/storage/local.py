"""
Local filesystem storage backend.

Files are stored under STORAGE_ROOT/<key>.  The key is an opaque path
segment (e.g. "videos/<uuid>/original.mp4") and is never exposed directly
to clients.

Thread safety: all operations are atomic at the OS level (write to a
temporary file then rename).  This is safe for concurrent Celery workers
and a single FastAPI server process.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import BinaryIO

from app.config import settings


class LocalFileStorage:
    """StorageBackend implementation that uses the local filesystem."""

    def __init__(self, root: Path | str | None = None) -> None:
        self._root = Path(root or settings.storage_root).resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    def _full_path(self, key: str) -> Path:
        # Prevent path traversal: resolve and confirm it stays under root.
        resolved = (self._root / key).resolve()
        if not str(resolved).startswith(str(self._root)):
            raise ValueError(f"Storage key escapes root: {key!r}")
        return resolved

    def store(
        self,
        key: str,
        source: BinaryIO,
        *,
        content_type: str | None = None,  # unused by local backend
    ) -> int:
        dest = self._full_path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)

        # Write to a temp file in the same directory, then rename atomically.
        fd, tmp_path = tempfile.mkstemp(dir=dest.parent)
        try:
            bytes_written = 0
            with os.fdopen(fd, "wb") as tmp:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    tmp.write(chunk)
                    bytes_written += len(chunk)
            os.replace(tmp_path, dest)
            return bytes_written
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    def open(self, key: str) -> BinaryIO:
        path = self._full_path(key)
        if not path.exists():
            raise FileNotFoundError(f"Storage key not found: {key!r}")
        return open(path, "rb")  # noqa: SIM115

    def delete(self, key: str) -> None:
        path = self._full_path(key)
        if not path.exists():
            raise FileNotFoundError(f"Storage key not found: {key!r}")
        path.unlink()
        # Remove empty parent directories up to (but not including) root.
        parent = path.parent
        while parent != self._root and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent

    def exists(self, key: str) -> bool:
        try:
            return self._full_path(key).exists()
        except ValueError:
            return False

    def size(self, key: str) -> int:
        path = self._full_path(key)
        if not path.exists():
            raise FileNotFoundError(f"Storage key not found: {key!r}")
        return path.stat().st_size

    def resolve_path(self, key: str) -> Path:
        """Return the absolute local Path — needed for FFmpeg subprocess calls."""
        path = self._full_path(key)
        if not path.exists():
            raise FileNotFoundError(f"Storage key not found: {key!r}")
        return path

"""
StorageBackend protocol.

All file storage goes through this interface, making the local-filesystem
implementation swappable for S3-compatible object storage without changing
any business logic.

Asset storage keys are opaque identifiers (e.g. "videos/<uuid>/<filename>").
They are never exposed as raw filesystem paths in API responses.
"""

from __future__ import annotations

from pathlib import Path
from typing import BinaryIO, Protocol, runtime_checkable


@runtime_checkable
class StorageBackend(Protocol):
    """Minimal protocol required by the application."""

    def store(
        self,
        key: str,
        source: BinaryIO,
        *,
        content_type: str | None = None,
    ) -> int:
        """
        Write *source* to the storage location identified by *key*.

        Returns the number of bytes written.
        Raises OSError on failure.
        """
        ...

    def open(self, key: str) -> BinaryIO:
        """
        Return an open binary file-like object for reading *key*.

        Raises FileNotFoundError if the key does not exist.
        """
        ...

    def delete(self, key: str) -> None:
        """
        Delete the object identified by *key*.

        Raises FileNotFoundError if the key does not exist.
        """
        ...

    def exists(self, key: str) -> bool:
        """Return True if *key* exists in storage."""
        ...

    def size(self, key: str) -> int:
        """Return the byte size of the object identified by *key*."""
        ...

    def resolve_path(self, key: str) -> Path:
        """
        Return the absolute local Path for *key*, if supported.

        Raises NotImplementedError for backends that do not use the local
        filesystem (e.g. S3).  Use this only where a real path is needed
        (e.g. for FFmpeg subprocess calls).
        """
        ...

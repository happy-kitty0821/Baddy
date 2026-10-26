"""
Asset service: persists uploaded files and creates Asset records.

Storage keys follow the convention:
    <asset_type>/<match_id>/<uuid>_<sanitised_filename>

The key is stored in the database; the raw path is never exposed to clients.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import uuid
from pathlib import Path
from typing import BinaryIO

from sqlalchemy.orm import Session

from app.models.asset import Asset
from app.storage.local import LocalFileStorage
from shared.enums import AssetType


def _sanitise_filename(name: str) -> str:
    """Strip unsafe characters from an original filename."""
    name = Path(name).name  # strip any directory component
    name = re.sub(r"[^\w.\-]", "_", name)
    return name[:200]  # cap length


def store_upload(
    db: Session,
    storage: LocalFileStorage,
    match_id: str,
    source: BinaryIO,
    original_filename: str,
    asset_type: AssetType = AssetType.VIDEO_ORIGINAL,
) -> Asset:
    """
    Write *source* to storage, compute its checksum, and create an Asset record.

    The file is streamed in chunks — it is never fully buffered in memory.
    """
    safe_name = _sanitise_filename(original_filename)
    asset_id = str(uuid.uuid4())
    key = f"{asset_type.value}/{match_id}/{asset_id}_{safe_name}"

    # Stream file to storage while computing SHA-256 checksum.
    hasher = hashlib.sha256()

    class _HashingWrapper:
        def __init__(self, inner: BinaryIO) -> None:
            self._inner = inner

        def read(self, n: int = -1) -> bytes:
            chunk = self._inner.read(n)
            if chunk:
                hasher.update(chunk)
            return chunk

    bytes_written = storage.store(key, _HashingWrapper(source))  # type: ignore[arg-type]
    checksum = hasher.hexdigest()
    mime_type = mimetypes.guess_type(original_filename)[0]

    asset = Asset(
        id=asset_id,
        match_id=match_id,
        asset_type=asset_type.value,
        storage_key=key,
        mime_type=mime_type,
        size_bytes=bytes_written,
        checksum=checksum,
        original_filename=original_filename,
    )
    db.add(asset)
    db.flush()  # get the ID without committing
    return asset


def get_asset(db: Session, asset_id: str) -> Asset | None:
    return db.get(Asset, asset_id)


def get_match_assets(db: Session, match_id: str) -> list[Asset]:
    return db.query(Asset).filter(Asset.match_id == match_id).all()


def get_source_asset(db: Session, match_id: str) -> Asset | None:
    return (
        db.query(Asset)
        .filter(
            Asset.match_id == match_id,
            Asset.asset_type == AssetType.VIDEO_ORIGINAL.value,
        )
        .first()
    )

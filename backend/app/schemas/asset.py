"""Pydantic schemas for asset responses."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AssetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    match_id: str
    asset_type: str
    mime_type: str | None
    size_bytes: int | None
    checksum: str | None
    original_filename: str | None
    created_at: datetime


class AssetURLResponse(BaseModel):
    asset_id: str
    url: str
    expires_at: datetime | None = None

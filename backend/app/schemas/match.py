"""Pydantic schemas for match request/response bodies."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class MatchCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    recorded_at: datetime | None = None
    opponent_label: str | None = Field(None, max_length=255)
    session_type: str | None = Field(None, max_length=64)
    notes: str | None = None
    tags: list[str] = Field(default_factory=list)


class MatchUpdate(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=255)
    recorded_at: datetime | None = None
    opponent_label: str | None = Field(None, max_length=255)
    session_type: str | None = Field(None, max_length=64)
    notes: str | None = None
    tags: list[str] | None = None


class MatchRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    recorded_at: datetime | None
    uploaded_at: datetime
    duration_ms: int | None
    width: int | None
    height: int | None
    fps_num: int | None
    fps_den: int | None
    codec: str | None
    file_size_bytes: int | None
    checksum: str | None
    notes: str | None
    opponent_label: str | None
    session_type: str | None
    # tags is stored as a JSON string in SQLite; deserialise on the way out.
    tags: list[str] = Field(default_factory=list)
    status: str
    created_at: datetime
    updated_at: datetime

    # Derived display helpers
    source_asset_id: str | None = None

    @field_validator("tags", mode="before")
    @classmethod
    def _parse_tags(cls, v: object) -> list[str]:
        import json as _json
        if isinstance(v, list):
            return v
        if isinstance(v, str):
            try:
                parsed = _json.loads(v)
                if isinstance(parsed, list):
                    return parsed
            except Exception:
                pass
        return []

    @classmethod
    def from_orm_with_asset(cls, match: object, source_asset_id: str | None) -> "MatchRead":
        obj = cls.model_validate(match)
        obj.source_asset_id = source_asset_id
        return obj


class MatchListResponse(BaseModel):
    items: list[MatchRead]
    total: int
    page: int
    page_size: int
    total_pages: int

"""Pydantic schemas for the Phase 2 vision API.

These mirror the ORM models in app/models/.  JSON-in-TEXT fields
(keypoints, correction_data) are deserialised on read via a
``field_validator(mode="before")`` — the same pattern used by
``MatchRead.tags``.
"""

from __future__ import annotations

import json
from datetime import datetime

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


class VisionCreate(BaseModel):
    """Optional overrides for starting a vision run (all default to None)."""
    frame_skip: int | None = None
    confidence: float | None = None
    device: str | None = None


class PlayerTrackRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    analysis_run_id: str
    track_id: int
    track_label: str
    is_selected_player: bool
    identity_note: str | None
    identity_confidence: float | None
    created_at: datetime


class PoseFrameRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    analysis_run_id: str
    player_track_id: str
    timestamp_ms: int
    frame_index: int
    bbox_x: float | None
    bbox_y: float | None
    bbox_w: float | None
    bbox_h: float | None
    bbox_conf: float | None
    # Stored as keypoints_json (JSON-in-TEXT) on the model; expose as a
    # parsed list of [x, y, conf] triples.
    keypoints: list[list[float]] = Field(
        default_factory=list,
        validation_alias=AliasChoices("keypoints", "keypoints_json"),
    )
    overall_conf: float | None
    source_width: int
    source_height: int
    model_id: str | None
    created_at: datetime

    @field_validator("keypoints", mode="before")
    @classmethod
    def _parse_keypoints(cls, v: object) -> list[list[float]]:
        if isinstance(v, list):
            return v  # type: ignore[return-value]
        if isinstance(v, str):
            try:
                parsed = json.loads(v)
                if isinstance(parsed, list):
                    return parsed
            except Exception:
                pass
        return []


class PoseFrameListResponse(BaseModel):
    items: list[PoseFrameRead]
    total: int
    offset: int
    limit: int
    has_more: bool


class PlayerIdentityUpdate(BaseModel):
    is_selected_player: bool | None = None
    identity_note: str | None = None


class CorrectionCreate(BaseModel):
    entity_type: str
    entity_id: str
    correction_data: dict


class CorrectionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    analysis_run_id: str
    entity_type: str
    entity_id: str
    # Stored as a JSON string in the DB; deserialise on read.
    correction_data: dict = Field(default_factory=dict)

    created_at: datetime

    @field_validator("correction_data", mode="before")
    @classmethod
    def _parse_correction_data(cls, v: object) -> dict:
        if isinstance(v, dict):
            return v
        if isinstance(v, str):
            try:
                parsed = json.loads(v)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
        return {}

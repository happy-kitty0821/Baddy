"""Pydantic schemas for the Phase 4 shuttle tracking API.

Mirrors PoseFrameRead / PoseFrameListResponse in structure.
No JSON-in-TEXT fields, so no field_validator parsing is needed.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ShuttleObservationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    analysis_run_id: str
    timestamp_ms: int
    frame_index: int
    x: float | None
    y: float | None
    confidence: float | None
    observation_status: str  # "detected" | "interpolated" | "unavailable"
    source_width: int
    source_height: int
    created_at: datetime


class ShuttleObservationListResponse(BaseModel):
    items: list[ShuttleObservationRead]
    total: int
    offset: int
    limit: int
    has_more: bool

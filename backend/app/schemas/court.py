"""Pydantic v2 schemas for court calibration data."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class CourtCalibrationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    analysis_run_id: str
    timestamp_ms: int
    frame_index: int
    corners_json: str
    homography_json: str
    drift_px: float | None
    confidence: float
    created_at: datetime


class CourtCalibrationListResponse(BaseModel):
    items: list[CourtCalibrationRead]
    total: int

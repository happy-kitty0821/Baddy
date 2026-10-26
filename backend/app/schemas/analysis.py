"""Pydantic schemas for analysis run request/response bodies."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AnalysisRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    match_id: str
    status: str
    pipeline_config: str | None
    analysis_version: str | None
    celery_task_id: str | None
    progress_pct: int
    current_stage: str | None
    started_at: datetime | None
    completed_at: datetime | None
    error_code: str | None
    error_message: str | None
    created_at: datetime


class AnalysisRunCreate(BaseModel):
    """Request body for starting a new analysis run (Phase 1: ingestion only)."""
    pass  # No configurable options yet; reserved for future model selection.

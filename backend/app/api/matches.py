"""
Match management endpoints.

POST   /api/matches         — create a match record and upload video
GET    /api/matches         — list matches (paginated, searchable)
GET    /api/matches/{id}    — retrieve a single match
PATCH  /api/matches/{id}    — update match metadata
DELETE /api/matches/{id}    — permanently delete match and all assets
"""

from __future__ import annotations

import json

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status

from app.config import settings
from app.dependencies import CurrentUser, DBSession, Storage
from app.schemas.match import MatchCreate, MatchListResponse, MatchRead, MatchUpdate
from app.services.asset_service import get_source_asset, store_upload
from app.services.job_service import create_analysis_run, dispatch_ingestion
from app.services.match_service import (
    create_match,
    delete_match,
    get_match,
    list_matches,
    update_match,
)
from shared.constants import ALLOWED_VIDEO_MIME_TYPES
from shared.enums import AssetType, MatchStatus

router = APIRouter(prefix="/api/matches", tags=["matches"])


def _get_match_or_404(db: DBSession, match_id: str):
    match = get_match(db, match_id)
    if not match or match.status == MatchStatus.DELETED.value:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Match not found")
    return match


@router.post("", response_model=MatchRead, status_code=status.HTTP_201_CREATED)
async def upload_match(
    db: DBSession,
    storage: Storage,
    current_user: CurrentUser,
    # Multipart form fields
    title: str = Form(..., min_length=1, max_length=255),
    recorded_at: str | None = Form(None),
    opponent_label: str | None = Form(None),
    session_type: str | None = Form(None),
    notes: str | None = Form(None),
    tags: str = Form("[]"),  # JSON-encoded list of strings
    video: UploadFile = File(...),
) -> MatchRead:
    # ── Validate file ──────────────────────────────────────────────────────
    if video.content_type and video.content_type not in ALLOWED_VIDEO_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unsupported video type: {video.content_type}",
        )

    # ── Parse tags ─────────────────────────────────────────────────────────
    try:
        parsed_tags: list[str] = json.loads(tags)
    except Exception:
        parsed_tags = []

    # ── Parse recorded_at ─────────────────────────────────────────────────
    from datetime import datetime
    parsed_recorded_at = None
    if recorded_at:
        try:
            parsed_recorded_at = datetime.fromisoformat(recorded_at)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="recorded_at must be an ISO 8601 datetime string.",
            )

    # ── Create match record ────────────────────────────────────────────────
    match_data = MatchCreate(
        title=title,
        recorded_at=parsed_recorded_at,
        opponent_label=opponent_label,
        session_type=session_type,
        notes=notes,
        tags=parsed_tags,
    )
    match = create_match(db, match_data)

    # ── Store video file ───────────────────────────────────────────────────
    asset = store_upload(
        db=db,
        storage=storage,
        match_id=match.id,
        source=video.file,
        original_filename=video.filename or "video.mp4",
        asset_type=AssetType.VIDEO_ORIGINAL,
    )
    db.commit()

    # ── Create analysis run and dispatch ingestion ─────────────────────────
    run = create_analysis_run(db, match.id)
    task_id = dispatch_ingestion(run.id, match.id)
    if task_id:
        run.celery_task_id = task_id
        db.commit()

    db.refresh(match)
    return MatchRead.from_orm_with_asset(match, asset.id)


@router.get("", response_model=MatchListResponse)
def list_all_matches(
    db: DBSession,
    current_user: CurrentUser,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str | None = Query(None),
    search: str | None = Query(None),
) -> MatchListResponse:
    return list_matches(db, page=page, page_size=page_size, status_filter=status, search=search)


@router.get("/{match_id}", response_model=MatchRead)
def get_single_match(
    match_id: str,
    db: DBSession,
    current_user: CurrentUser,
) -> MatchRead:
    match = _get_match_or_404(db, match_id)
    src = get_source_asset(db, match_id)
    return MatchRead.from_orm_with_asset(match, src.id if src else None)


@router.patch("/{match_id}", response_model=MatchRead)
def update_match_metadata(
    match_id: str,
    data: MatchUpdate,
    db: DBSession,
    current_user: CurrentUser,
) -> MatchRead:
    match = _get_match_or_404(db, match_id)
    match = update_match(db, match, data)
    src = get_source_asset(db, match_id)
    return MatchRead.from_orm_with_asset(match, src.id if src else None)


@router.delete("/{match_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_single_match(
    match_id: str,
    db: DBSession,
    storage: Storage,
    current_user: CurrentUser,
) -> None:
    match = _get_match_or_404(db, match_id)
    delete_match(db, match, storage)

"""
Analysis run endpoints.

POST /api/matches/{id}/analyses       — start a new analysis run
GET  /api/analyses/{id}               — get run status and config
POST /api/analyses/{id}/retry         — retry a failed run
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.dependencies import CurrentUser, DBSession
from app.schemas.analysis import AnalysisRunCreate, AnalysisRunRead
from app.services.job_service import (
    create_analysis_run,
    dispatch_ingestion,
    get_latest_run,
    get_run,
    mark_run_failed,
)
from app.services.match_service import get_match
from shared.enums import AnalysisStatus, MatchStatus

router = APIRouter(tags=["analyses"])


@router.post(
    "/api/matches/{match_id}/analyses",
    response_model=AnalysisRunRead,
    status_code=status.HTTP_201_CREATED,
)
def start_analysis(
    match_id: str,
    _body: AnalysisRunCreate,
    db: DBSession,
    current_user: CurrentUser,
) -> AnalysisRunRead:
    match = get_match(db, match_id)
    if not match or match.status == MatchStatus.DELETED.value:
        raise HTTPException(status_code=404, detail="Match not found")

    # Prevent duplicate active runs.
    existing = get_latest_run(db, match_id)
    if existing and existing.status in (
        AnalysisStatus.QUEUED.value,
        AnalysisStatus.INGESTING.value,
        AnalysisStatus.PROCESSING.value,
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An analysis run is already active for this match.",
        )

    run = create_analysis_run(db, match_id)
    task_id = dispatch_ingestion(run.id, match_id)
    if task_id:
        run.celery_task_id = task_id
        db.commit()

    return AnalysisRunRead.model_validate(run)


@router.get("/api/analyses/{run_id}", response_model=AnalysisRunRead)
def get_analysis(
    run_id: str,
    db: DBSession,
    current_user: CurrentUser,
) -> AnalysisRunRead:
    run = get_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Analysis run not found")
    return AnalysisRunRead.model_validate(run)


@router.get("/api/matches/{match_id}/analyses/latest", response_model=AnalysisRunRead)
def get_latest_analysis(
    match_id: str,
    db: DBSession,
    current_user: CurrentUser,
) -> AnalysisRunRead:
    """Return the most recently created analysis run for a match."""
    run = get_latest_run(db, match_id)
    if not run:
        raise HTTPException(
            status_code=404, detail="No analysis run found for this match"
        )
    return AnalysisRunRead.model_validate(run)


@router.post("/api/analyses/{run_id}/retry", response_model=AnalysisRunRead)
def retry_analysis(
    run_id: str,
    db: DBSession,
    current_user: CurrentUser,
) -> AnalysisRunRead:
    run = get_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Analysis run not found")
    if run.status != AnalysisStatus.FAILED.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Only FAILED runs can be retried; this run is {run.status!r}.",
        )

    # Create a fresh run rather than mutating the failed one.
    new_run = create_analysis_run(db, run.match_id)
    task_id = dispatch_ingestion(new_run.id, run.match_id)
    if task_id:
        new_run.celery_task_id = task_id
        db.commit()

    return AnalysisRunRead.model_validate(new_run)

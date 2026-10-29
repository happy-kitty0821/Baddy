"""
Phase 2 vision endpoints.

POST   /api/analyses/{run_id}/vision          — start the vision pipeline on a run
GET    /api/analyses/{run_id}/tracks           — list player tracks for a run
GET    /api/analyses/{run_id}/poses            — paginated pose frames for a run
PATCH  /api/analyses/{run_id}/tracks/{track_id} — update a track's player identity
POST   /api/analyses/{run_id}/corrections      — save a user correction

Vision reuses the SAME analysis_runs row as ingestion: ingestion completes it
(COMPLETED), then vision transitions it COMPLETED → PROCESSING → COMPLETED.
A run may start vision only when its status is COMPLETED or FAILED (a failed
run can be retried without re-ingesting).  Active states (queued, ingesting,
processing) are rejected with 409.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status

from app.dependencies import CurrentUser, DBSession
from app.schemas.analysis import AnalysisRunRead
from app.schemas.vision import (
    CorrectionCreate,
    CorrectionRead,
    CourtHalfAssignment,
    PlayerIdentityUpdate,
    PlayerTrackRead,
    PoseFrameListResponse,
    PoseFrameRead,
    VisionCreate,
)
from app.services.job_service import get_run
from app.services.vision_service import (
    assign_court_halves,
    dispatch_vision,
    get_track,
    get_tracks,
    query_poses,
    save_correction,
    update_player_identity,
)
from shared.enums import AnalysisStatus, VisionStage

router = APIRouter(prefix="/api/analyses", tags=["vision"])

# Statuses that block starting a new vision run.
_ACTIVE_STATUSES = frozenset(
    {
        AnalysisStatus.QUEUED.value,
        AnalysisStatus.INGESTING.value,
        AnalysisStatus.PROCESSING.value,
    }
)


def _get_run_or_404(db: DBSession, run_id: str):
    run = get_run(db, run_id)
    if not run:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Analysis run not found",
        )
    return run


@router.post("/{run_id}/vision", response_model=AnalysisRunRead)
def start_vision(
    run_id: str,
    _body: VisionCreate,
    db: DBSession,
    current_user: CurrentUser,
) -> AnalysisRunRead:
    """Start the Phase 2 vision pipeline on a completed (or failed) run."""
    run = _get_run_or_404(db, run_id)

    if run.status in _ACTIVE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An analysis run is already active for this run.",
        )
    # Allow COMPLETED and FAILED (failed = retry after a prior vision failure).
    # Transition the run into the vision pipeline.
    run.status = AnalysisStatus.PROCESSING.value
    run.current_stage = VisionStage.LOAD_VIDEO.value
    run.progress_pct = 0

    task_id = dispatch_vision(run.id, run.match_id)
    if task_id:
        run.celery_task_id = task_id
    db.commit()
    db.refresh(run)
    return AnalysisRunRead.model_validate(run)


@router.get("/{run_id}/tracks", response_model=list[PlayerTrackRead])
def list_tracks(
    run_id: str,
    db: DBSession,
    current_user: CurrentUser,
) -> list[PlayerTrackRead]:
    _get_run_or_404(db, run_id)
    return [PlayerTrackRead.model_validate(t) for t in get_tracks(db, run_id)]


@router.post("/{run_id}/assign-court-halves", response_model=CourtHalfAssignment)
def auto_assign_court_halves(
    run_id: str,
    db: DBSession,
    current_user: CurrentUser,
    source_height: int = 1080,
) -> CourtHalfAssignment:
    """
    Automatically assign Near-End and Far-End court positions to player tracks.

    Uses the median vertical bounding-box centre across all pose frames to
    determine which players are in which half of the court.  Falls back to
    horizontal split if footage is side-on.

    Pass source_height as a query parameter (defaults to 1080).
    """
    _get_run_or_404(db, run_id)
    result = assign_court_halves(db, run_id, source_height=source_height)
    return CourtHalfAssignment(
        near_end=PlayerTrackRead.model_validate(result["near_end"]) if result["near_end"] else None,
        far_end=PlayerTrackRead.model_validate(result["far_end"]) if result["far_end"] else None,
        axis=result["axis"],
        ambiguous=result["ambiguous"],
    )


@router.get("/{run_id}/poses", response_model=PoseFrameListResponse)
def list_poses(
    run_id: str,
    db: DBSession,
    current_user: CurrentUser,
    start_ms: int | None = Query(None),
    end_ms: int | None = Query(None),
    track_id: str | None = Query(None),
    court_side: str | None = Query(None, regex="^(near|far)$"),
    limit: int = Query(500, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> PoseFrameListResponse:
    _get_run_or_404(db, run_id)
    items, total = query_poses(
        db,
        run_id=run_id,
        start_ms=start_ms,
        end_ms=end_ms,
        track_id=track_id,
        court_side=court_side,
        limit=limit,
        offset=offset,
    )
    read_items = [PoseFrameRead.model_validate(p) for p in items]
    has_more = (offset + len(read_items)) < total
    return PoseFrameListResponse(
        items=read_items,
        total=total,
        offset=offset,
        limit=limit,
        has_more=has_more,
    )


@router.patch("/{run_id}/tracks/{track_id}", response_model=PlayerTrackRead)
def patch_player_identity(
    run_id: str,
    track_id: str,
    data: PlayerIdentityUpdate,
    db: DBSession,
    current_user: CurrentUser,
) -> PlayerTrackRead:
    _get_run_or_404(db, run_id)
    track = get_track(db, track_id)
    if not track or track.analysis_run_id != run_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Player track not found",
        )
    track = update_player_identity(db, track, data)
    return PlayerTrackRead.model_validate(track)


@router.post(
    "/{run_id}/corrections",
    response_model=CorrectionRead,
    status_code=status.HTTP_201_CREATED,
)
def create_correction(
    run_id: str,
    data: CorrectionCreate,
    db: DBSession,
    current_user: CurrentUser,
) -> CorrectionRead:
    _get_run_or_404(db, run_id)
    correction = save_correction(db, run_id, data)
    return CorrectionRead.model_validate(correction)

"""
Vision service: Phase 2 database read/write helpers and Celery dispatch.

Pure-DB functions mirror the match_service style.  dispatch_vision lazily
imports the worker task so the API works before the worker task exists.
"""

from __future__ import annotations

import json

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.player_track import PlayerTrack
from app.models.pose_frame import PoseFrame
from app.models.user_correction import UserCorrection
from app.schemas.vision import CorrectionCreate, PlayerIdentityUpdate

# Hard cap on the number of pose frames returned per request.
_MAX_POSE_LIMIT = 1000

# Minimum number of pose frames a track must have to appear in the UI.
# ByteTrack creates spurious short-lived IDs (1–2 frames) on every brief
# detection loss.  50 frames at a 25fps / frame_skip=2 source ≈ 4 seconds of
# continuous presence — a reliable minimum for a real player.
_MIN_TRACK_FRAMES = 50


def get_tracks(db: Session, run_id: str, min_frames: int = _MIN_TRACK_FRAMES) -> list[PlayerTrack]:
    """
    Return player tracks for an analysis run that have at least *min_frames*
    pose frames, ordered by pose-frame count descending (most visible first).

    Spurious short-lived ByteTrack IDs are filtered out by the min_frames
    threshold.  The top 2 tracks almost always correspond to the two players.
    """
    # Subquery: track IDs with their pose frame counts, filtered by minimum.
    track_counts = (
        db.query(
            PoseFrame.player_track_id,
            func.count(PoseFrame.id).label("frame_count"),
        )
        .filter(PoseFrame.analysis_run_id == run_id)
        .group_by(PoseFrame.player_track_id)
        .having(func.count(PoseFrame.id) >= min_frames)
        .subquery()
    )

    # Join with PlayerTrack, order by frame count descending.
    rows = (
        db.query(PlayerTrack, track_counts.c.frame_count)
        .join(track_counts, PlayerTrack.id == track_counts.c.player_track_id)
        .filter(PlayerTrack.analysis_run_id == run_id)
        .order_by(track_counts.c.frame_count.desc())
        .all()
    )
    return [r[0] for r in rows]


def assign_court_halves(db: Session, run_id: str, source_height: int) -> dict:
    """
    Automatically assign Near-End and Far-End court positions to player tracks.

    Algorithm:
    1. For every qualifying track, compute the median Y position of
       (bbox_y + bbox_h/2) — the vertical centre of the bounding box.
    2. Tracks whose median centre is above the halfway line (Y < 50% of frame)
       are "Far End" (far from the camera).
    3. Tracks whose median centre is below the halfway line (Y >= 50%) are
       "Near End" (close to the camera).
    4. Pick the track with the most pose frames in each half as the canonical
       player for that half.  Assign track_label accordingly.
    5. Mark the Near-End canonical track as the "primary" player by default
       (user can correct this).

    Handles dynamic footage / camera orientation:
    - If variance along Y is too low (side-on camera), falls back to X-axis split.
    - If only one half has tracks, all tracks are assigned to that half.

    Returns a dict describing the assignment:
      { "near_end": PlayerTrack | None, "far_end": PlayerTrack | None,
        "axis": "y" | "x", "ambiguous": bool }
    """
    tracks = get_tracks(db, run_id)
    if not tracks:
        return {"near_end": None, "far_end": None, "axis": "y", "ambiguous": True}

    # For each track compute: median bbox vertical centre and total frame count.
    half_line = source_height / 2.0

    track_medians: list[tuple[PlayerTrack, float, int]] = []
    for track in tracks:
        poses = (
            db.query(PoseFrame.bbox_y, PoseFrame.bbox_h)
            .filter(PoseFrame.player_track_id == track.id)
            .filter(PoseFrame.bbox_y.isnot(None))
            .order_by(PoseFrame.timestamp_ms)
            .all()
        )
        if not poses:
            continue
        centres = [(row[0] + (row[1] or 0) / 2.0) for row in poses]
        centres.sort()
        median_y = centres[len(centres) // 2]
        track_medians.append((track, median_y, len(poses)))

    if not track_medians:
        return {"near_end": None, "far_end": None, "axis": "y", "ambiguous": True}

    # Check variance to detect side-on footage.
    all_medians = [m[1] for m in track_medians]
    y_spread = max(all_medians) - min(all_medians)
    axis = "y"

    if y_spread < source_height * 0.15:
        # Very low Y-spread — probably a side-on view.  Use X instead.
        axis = "x"
        # Re-compute using X-axis: bbox_x + bbox_w/2
        source_width_approx = source_height * 16 // 9  # estimate from AR
        half_line_x = source_width_approx / 2.0
        track_medians = []
        for track in tracks:
            poses = (
                db.query(PoseFrame.bbox_x, PoseFrame.bbox_w)
                .filter(PoseFrame.player_track_id == track.id)
                .filter(PoseFrame.bbox_x.isnot(None))
                .all()
            )
            if not poses:
                continue
            centres = [(row[0] + (row[1] or 0) / 2.0) for row in poses]
            centres.sort()
            median_x = centres[len(centres) // 2]
            track_medians.append((track, median_x, len(poses)))
        half_line = half_line_x

    # Partition tracks into two halves.
    near_candidates = [(t, c, n) for t, c, n in track_medians if c >= half_line]
    far_candidates = [(t, c, n) for t, c, n in track_medians if c < half_line]

    # Canonical player for each half: most pose frames.
    near_track = max(near_candidates, key=lambda x: x[2])[0] if near_candidates else None
    far_track = max(far_candidates, key=lambda x: x[2])[0] if far_candidates else None

    ambiguous = (near_track is None or far_track is None)

    # Persist the assignment.
    if near_track:
        near_track.track_label = "near_end"
        near_track.identity_note = "Auto-assigned: near end of court (closer to camera)"
    if far_track:
        far_track.track_label = "far_end"
        far_track.identity_note = "Auto-assigned: far end of court (further from camera)"
    db.commit()

    return {
        "near_end": near_track,
        "far_end": far_track,
        "axis": axis,
        "ambiguous": ambiguous,
    }


def get_track(db: Session, track_id: str) -> PlayerTrack | None:
    return db.get(PlayerTrack, track_id)


def update_player_identity(
    db: Session, track: PlayerTrack, data: PlayerIdentityUpdate
) -> PlayerTrack:
    """Apply only the set fields from *data*, then commit and refresh."""
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(track, field, value)
    db.commit()
    db.refresh(track)
    return track


def query_poses(
    db: Session,
    run_id: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    track_id: str | None = None,
    limit: int = 500,
    offset: int = 0,
) -> tuple[list[PoseFrame], int]:
    """
    Query pose frames for a run, ordered by timestamp_ms.

    Returns (items, total) where total ignores pagination.
    limit is clamped to [1, 1000].
    """
    limit = max(1, min(limit, _MAX_POSE_LIMIT))
    offset = max(0, offset)

    query = db.query(PoseFrame).filter(PoseFrame.analysis_run_id == run_id)
    if start_ms is not None:
        query = query.filter(PoseFrame.timestamp_ms >= start_ms)
    if end_ms is not None:
        query = query.filter(PoseFrame.timestamp_ms <= end_ms)
    if track_id is not None:
        query = query.filter(PoseFrame.player_track_id == track_id)

    total = query.count()
    items = (
        query.order_by(PoseFrame.timestamp_ms.asc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return items, total


def save_correction(
    db: Session, run_id: str, data: CorrectionCreate
) -> UserCorrection:
    """Persist a user correction (append-only audit row) for a run."""
    correction = UserCorrection(
        analysis_run_id=run_id,
        entity_type=data.entity_type,
        entity_id=data.entity_id,
        correction_data=json.dumps(data.correction_data),
    )
    db.add(correction)
    db.commit()
    db.refresh(correction)
    return correction


def dispatch_vision(run_id: str, match_id: str) -> str | None:
    """
    Dispatch the Phase 2 vision Celery task for *run_id*.

    Returns the Celery task ID, or None if the broker is unavailable.
    """
    try:
        from worker.tasks.vision import run_vision  # noqa: PLC0415
        result = run_vision.delay(run_id=run_id, match_id=match_id)
        return result.id
    except Exception:
        import logging
        logging.getLogger(__name__).warning(
            "Could not dispatch vision task for run %s — broker unavailable.",
            run_id,
        )
        return None

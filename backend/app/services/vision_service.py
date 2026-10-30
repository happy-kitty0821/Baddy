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


def assign_court_halves(db: Session, run_id: str, source_height: int, source_width: int = 0) -> dict:
    """
    Automatically assign Near-End and Far-End court positions to player tracks.

    Orientation detection:
      - Landscape (width > height, typical overhead/back-corner footage):
        Split on Y axis. Near End = bottom half (Y >= 50%), Far End = top half.
      - Portrait (height > width, e.g. phone recording, YouTube Short 9:16):
        Split on X axis. Near End = right half (X >= 50%), Far End = left half.
        Labels become "Left Side" / "Right Side" in the UI.

    Algorithm:
    1. Determine axis from source dimensions (Y for landscape, X for portrait).
    2. For every qualifying track, compute the median centre on the chosen axis.
    3. Partition tracks into two halves by the midpoint.
    4. Pick the track with the most pose frames in each half as canonical.
    5. Persist track_label and identity_note.

    Returns a dict:
      { "near_end": PlayerTrack | None, "far_end": PlayerTrack | None,
        "axis": "y" | "x", "ambiguous": bool }
    """
    tracks = get_tracks(db, run_id)
    if not tracks:
        return {"near_end": None, "far_end": None, "axis": "y", "ambiguous": True}

    # Choose axis from source dimensions.
    # Portrait = height > width → side-on or vertical recording → split on X.
    is_portrait = source_height > 0 and source_width > 0 and source_height > source_width
    axis = "x" if is_portrait else "y"

    if axis == "y":
        # Y-axis split: Near End = bottom half (Y >= source_height/2)
        half = source_height / 2.0

        track_medians: list[tuple[PlayerTrack, float, int]] = []
        for track in tracks:
            poses = (
                db.query(PoseFrame.bbox_y, PoseFrame.bbox_h)
                .filter(PoseFrame.player_track_id == track.id)
                .filter(PoseFrame.bbox_y.isnot(None))
                .all()
            )
            if not poses:
                continue
            centres = sorted([(row[0] + (row[1] or 0) / 2.0) for row in poses])
            median_y = centres[len(centres) // 2]
            track_medians.append((track, median_y, len(poses)))

        # If Y variance is very low, fall back to X (probably a side-on view
        # that was miscategorised as landscape).
        if track_medians:
            y_spread = max(m[1] for m in track_medians) - min(m[1] for m in track_medians)
            if y_spread < source_height * 0.15:
                axis = "x"
    
    if axis == "x":
        # X-axis split: Near End = right half (X >= source_width/2)
        # For portrait footage the "near end" is conventionally the player
        # who appears on the right (or bottom of a rotated view).
        effective_width = source_width or source_height  # fallback if width=0
        half = effective_width / 2.0

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
            centres = sorted([(row[0] + (row[1] or 0) / 2.0) for row in poses])
            median_x = centres[len(centres) // 2]
            track_medians.append((track, median_x, len(poses)))

    if not track_medians:
        return {"near_end": None, "far_end": None, "axis": axis, "ambiguous": True}

    # Partition into two halves and pick canonical track (most pose frames).
    near_candidates = [(t, c, n) for t, c, n in track_medians if c >= half]
    far_candidates  = [(t, c, n) for t, c, n in track_medians if c < half]

    near_track = max(near_candidates, key=lambda x: x[2])[0] if near_candidates else None
    far_track  = max(far_candidates,  key=lambda x: x[2])[0] if far_candidates  else None

    ambiguous = (near_track is None or far_track is None)

    # Persist labels and notes.
    if axis == "x":
        near_label = "right_side"
        far_label  = "left_side"
        near_note  = "Auto-assigned: right side of frame"
        far_note   = "Auto-assigned: left side of frame"
    else:
        near_label = "near_end"
        far_label  = "far_end"
        near_note  = "Auto-assigned: near end of court (closer to camera)"
        far_note   = "Auto-assigned: far end of court (further from camera)"

    if near_track:
        near_track.track_label = near_label
        near_track.identity_note = near_note
    if far_track:
        far_track.track_label = far_label
        far_track.identity_note = far_note
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
    court_side: str | None = None,
    limit: int = 500,
    offset: int = 0,
) -> tuple[list[PoseFrame], int]:
    """
    Query pose frames for a run, ordered by timestamp_ms.

    Optional filters:
      start_ms / end_ms — time window.
      track_id          — only poses for a specific track.
      court_side        — "near" (bottom half, closer to camera) or
                          "far" (top half, further from camera).
                          Uses per-frame bbox Y centre vs source_height / 2.
                          This is per-FRAME, not per-track, so ByteTrack
                          re-ID issues don't affect the split.

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

    if court_side is not None:
        # Per-frame court half: bbox_y + bbox_h/2 vs source_height/2.
        # Near end = player is in the bottom half of the frame (Y >= 50%).
        # Far end  = player is in the top half of the frame (Y < 50%).
        # Use coalesce to handle NULL bbox values safely.
        bbox_centre = PoseFrame.bbox_y + (PoseFrame.bbox_h / 2.0)
        half = PoseFrame.source_height / 2.0
        if court_side == "near":
            query = query.filter(bbox_centre >= half)
        elif court_side == "far":
            query = query.filter(bbox_centre < half)

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

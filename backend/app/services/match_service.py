"""
Match service: create, list, get, update, and delete match records.

Deletion removes the match record, all asset records, and all stored files.
It does NOT delete records for completed analyses — those are retained for
audit and recovery purposes and are cascade-deleted by the DB when the match
is removed.
"""

from __future__ import annotations

import json
import math

from sqlalchemy.orm import Session

from app.models.match import Match
from app.schemas.match import MatchCreate, MatchRead, MatchUpdate, MatchListResponse
from app.services.asset_service import get_source_asset
from app.storage.local import LocalFileStorage
from shared.enums import MatchStatus


def create_match(db: Session, data: MatchCreate) -> Match:
    match = Match(
        title=data.title,
        recorded_at=data.recorded_at,
        opponent_label=data.opponent_label,
        session_type=data.session_type,
        notes=data.notes,
        tags=json.dumps(data.tags),
        status=MatchStatus.PENDING.value,
    )
    db.add(match)
    db.commit()
    db.refresh(match)
    return match


def get_match(db: Session, match_id: str) -> Match | None:
    return db.get(Match, match_id)


def list_matches(
    db: Session,
    page: int = 1,
    page_size: int = 20,
    status_filter: str | None = None,
    search: str | None = None,
) -> MatchListResponse:
    query = db.query(Match).filter(Match.status != MatchStatus.DELETED.value)
    if status_filter:
        query = query.filter(Match.status == status_filter)
    if search:
        like = f"%{search}%"
        query = query.filter(
            Match.title.ilike(like) | Match.opponent_label.ilike(like)
        )
    total = query.count()
    items_orm = (
        query.order_by(Match.uploaded_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = []
    for m in items_orm:
        src = get_source_asset(db, m.id)
        items.append(MatchRead.from_orm_with_asset(m, src.id if src else None))
    return MatchListResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=math.ceil(total / page_size) if total else 0,
    )


def update_match(db: Session, match: Match, data: MatchUpdate) -> Match:
    import json as _json
    for field, value in data.model_dump(exclude_unset=True).items():
        if field == "tags" and isinstance(value, list):
            value = _json.dumps(value)
        setattr(match, field, value)
    db.commit()
    db.refresh(match)
    return match


def delete_match(
    db: Session,
    match: Match,
    storage: LocalFileStorage,
) -> None:
    """
    Delete a match and all its associated assets from storage and the database.

    The original video is permanently removed.  This operation is irreversible.
    """
    from app.services.asset_service import get_match_assets

    assets = get_match_assets(db, match.id)
    for asset in assets:
        try:
            storage.delete(asset.storage_key)
        except FileNotFoundError:
            pass  # File already gone; still remove the record.

    # Mark as deleted first in case the DB delete fails, so no orphan file
    # appears to be accessible.
    match.status = MatchStatus.DELETED.value
    db.commit()
    db.delete(match)
    db.commit()

"""
FastAPI dependency injection helpers.

These are imported by route handlers via Depends().
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

from app.auth.jwt import get_current_user
from app.database import get_db
from app.storage.local import LocalFileStorage


@lru_cache(maxsize=1)
def _get_storage() -> LocalFileStorage:
    return LocalFileStorage()


def get_storage() -> LocalFileStorage:
    return _get_storage()


# Convenient type aliases for route handler signatures.
DBSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[str, Depends(get_current_user)]
Storage = Annotated[LocalFileStorage, Depends(get_storage)]

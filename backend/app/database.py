"""
Database engine and session factory.

SQLite notes:
  - We enable foreign-key enforcement via PRAGMA (SQLite ignores FKs by default).
  - check_same_thread=False is required for SQLite with FastAPI's threading model.
  - pool_pre_ping=True detects stale connections on both SQLite and PostgreSQL.

PostgreSQL notes:
  - Switch DATABASE_URL to a postgresql+psycopg://... URL.
  - Remove the SQLite-specific connect_args and event listener below.
  - The rest of the session/engine setup is identical.

Compatibility:
  - All models use SQLAlchemy 2.0 declarative syntax.
  - Migrations (Alembic) are tested against SQLite in CI.
  - PostgreSQL compatibility must be verified separately before production
    deployment — see docs/development-plan.md §PostgreSQL Integration Testing.
"""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


def _make_engine() -> Engine:
    if settings.is_sqlite:
        engine = create_engine(
            settings.database_url,
            connect_args={"check_same_thread": False},
            pool_pre_ping=True,
        )
        # Enable foreign-key constraints for every SQLite connection.
        @event.listens_for(engine, "connect")
        def _set_sqlite_pragma(dbapi_conn, _connection_record):  # type: ignore[no-untyped-def]
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        return engine
    else:
        # PostgreSQL (and other dialects): no SQLite-specific settings needed.
        return create_engine(settings.database_url, pool_pre_ping=True)


engine = _make_engine()

SessionLocal = sessionmaker(
    bind=engine,
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    """Shared declarative base for all ORM models."""
    pass


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

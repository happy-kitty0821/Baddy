"""
FastAPI application factory.

The application:
  - Serves a REST API for match management, video streaming, and job status.
  - Does NOT run long-running video analysis inside HTTP request handlers.
  - Analysis is dispatched to Celery workers via the job service.

Startup behaviour:
  - Creates the ./data directory (for SQLite) if it does not exist.
  - Storage directories are created by LocalFileStorage on first use.
  - Database tables are created via Alembic migrations, not here.
    (In development, tables are auto-created for convenience; in
     production, always run `alembic upgrade head` before starting.)
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.analyses import router as analyses_router
from app.api.assets import router as assets_router
from app.api.auth import router as auth_router
from app.api.matches import router as matches_router
from app.api.vision import router as vision_router
from app.config import settings

logger = logging.getLogger(__name__)

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # ── Startup ────────────────────────────────────────────────────────────
    # Ensure the data directory exists (SQLite needs it before connecting).
    if settings.is_sqlite:
        db_path = Path(settings.database_url.replace("sqlite:///", "")).resolve()
        db_path.parent.mkdir(parents=True, exist_ok=True)

    # Ensure storage subdirectories exist.
    storage_root = settings.storage_path
    for subdir in ("videos", "artifacts", "exports", "thumbnails"):
        (storage_root / subdir).mkdir(parents=True, exist_ok=True)

    # Auto-create tables in development only (not in testing or production).
    # In tests, conftest.py creates tables on the test engine directly.
    # In production, always run `alembic upgrade head` before starting.
    if os.environ.get("APP_ENV", settings.app_env) == "development":
        from app.database import Base, engine
        import app.models  # noqa: F401 — ensure all models are imported
        Base.metadata.create_all(bind=engine)
        logger.info("Database tables ensured (dev mode).")

    # Validate authentication configuration.
    # In production, missing credentials are a hard error.
    # In development, emit a warning so the developer knows the login is non-functional.
    if not settings.auth_username or not settings.auth_password_hash:
        _msg = (
            "AUTH_USERNAME and/or AUTH_PASSWORD_HASH are not set. "
            "The /api/auth/login endpoint will reject all login attempts. "
            "Set both variables in .env — see .env.example for instructions."
        )
        if settings.app_env == "production":
            raise RuntimeError(_msg)
        else:
            logger.warning(_msg)

    logger.info(
        "Badminton AI Coach API starting. env=%s db=%s",
        settings.app_env,
        "sqlite" if settings.is_sqlite else "postgresql",
    )

    yield
    # ── Shutdown ───────────────────────────────────────────────────────────
    logger.info("Badminton AI Coach API shutting down.")


def create_app() -> FastAPI:
    app = FastAPI(
        title="Badminton AI Coach API",
        version="0.1.0",
        description="Personal badminton video analysis and coaching platform.",
        lifespan=lifespan,
    )

    # ── CORS ───────────────────────────────────────────────────────────────
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Routers ────────────────────────────────────────────────────────────
    app.include_router(auth_router)
    app.include_router(matches_router)
    app.include_router(assets_router)
    app.include_router(analyses_router)
    app.include_router(vision_router)

    # ── Health check (unauthenticated) ─────────────────────────────────────
    @app.get("/health", include_in_schema=False)
    def health():
        return {"status": "ok", "env": settings.app_env}

    return app


app = create_app()

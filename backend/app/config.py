"""
Application configuration loaded from environment variables.

Pydantic Settings reads values from:
  1. The .env file at the PROJECT ROOT (two levels above this file).
  2. Actual environment variables (override .env).

Storage root:
  STORAGE_ROOT should always be set to an ABSOLUTE path in .env so that
  both the API (started from backend/) and the worker (started from the
  project root) resolve to exactly the same directory.

  Default: <project_root>/storage  (derived from this file's location,
  not from the current working directory — so it is CWD-independent).

Database:
  - SQLite by default (local development, no Docker required).
  - PostgreSQL via DATABASE_URL in production.
  - The access layer (SQLAlchemy + Alembic) is portable between both.

PostgreSQL compatibility note:
  SQLite and PostgreSQL behave differently in several areas:
    - SQLite has loose type affinity; PostgreSQL enforces column types strictly.
    - SQLite does not enforce foreign keys by default (we enable PRAGMA).
    - SQLite allows only one writer at a time; PostgreSQL supports concurrent writers.
  All migrations are written to be compatible with both dialects.
  PostgreSQL compatibility has NOT been verified by integration tests yet.
  See docs/development-plan.md §PostgreSQL Integration Testing.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Project root: two levels above backend/app/config.py
# backend/app/config.py → parents[0]=app/, parents[1]=backend/, parents[2]=project root
_PROJECT_ROOT = Path(__file__).resolve().parents[2]

# The .env file lives at the project root, not backend/.
_ENV_FILE = _PROJECT_ROOT / ".env"

# CWD-independent default storage root.
_DEFAULT_STORAGE_ROOT = str(_PROJECT_ROOT / "storage")

# CWD-independent default SQLite path.
_DEFAULT_DATABASE_URL = f"sqlite:///{_PROJECT_ROOT / 'backend' / 'data' / 'badminton.db'}"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Always read from the project-root .env, regardless of CWD.
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Application ────────────────────────────────────────────────────────
    app_env: Literal["development", "testing", "production"] = "development"
    log_level: str = "INFO"
    cors_origins: str = "http://localhost:3000"

    # ── Database ───────────────────────────────────────────────────────────
    # Default is an absolute CWD-independent path inside backend/data/.
    database_url: str = _DEFAULT_DATABASE_URL

    # ── Storage ────────────────────────────────────────────────────────────
    # Must be an absolute path so that both the API and the Celery worker
    # resolve to the same directory regardless of their working directory.
    # The default is derived from the project root, not the CWD.
    storage_root: str = _DEFAULT_STORAGE_ROOT

    # ── Redis / Celery ─────────────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/0"

    # ── Auth ───────────────────────────────────────────────────────────────
    jwt_secret: str = "change-me-before-first-use"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 10080  # 7 days

    # Single-user credentials (Phase 1).  Read from .env via Pydantic Settings.
    # NOTE: os.getenv() does NOT see .env file values — only Settings does.
    # All auth code must read from settings.auth_username / settings.auth_password_hash.
    auth_username: str = ""
    auth_password_hash: str = ""

    # ── Upload limits ──────────────────────────────────────────────────────
    max_upload_mb: int = 2048
    max_duration_minutes: int = 180

    # ── Optional LLM endpoint (Phase 6+) ──────────────────────────────────
    llm_endpoint_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""

    # ── Vision / inference (Phase 2) ──────────────────────────────────────
    # inference_device: "auto" uses CUDA when available, else CPU.
    # Set to "cpu" to force CPU; "cuda" to require GPU (errors if unavailable).
    inference_device: str = "auto"
    # Target sample rate for the vision pipeline.  The worker dynamically
    # computes a frame skip from the source fps so this is honoured for any
    # source framerate (e.g. 30 or 60 fps).
    vision_target_fps: int = 15
    # Minimum detection confidence for a player/keypoint to be kept.
    vision_confidence: float = 0.3
    # YOLO inference image size (pixels, square).
    vision_img_size: int = 640
    # Optional directory for model weight files (.pt).  Empty uses the
    # Ultralytics default cache location.
    model_weights_dir: str = ""

    # ── FFmpeg / ffprobe location ──────────────────────────────────────────
    # Optional: set to the directory that contains ffmpeg.exe and ffprobe.exe
    # (or the binary symlinks on Linux).  Useful when the Celery worker process
    # does not inherit the shell PATH that ffmpeg was installed into.
    #
    # Windows example (winget install):
    #   FFMPEG_BIN=C:/Users/YourName/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_.../bin
    # Linux example:
    #   FFMPEG_BIN=/usr/bin
    #
    # Leave empty to rely on PATH (which works when all processes share a shell).
    ffmpeg_bin: str = ""

    # ── Derived helpers ────────────────────────────────────────────────────
    @property
    def storage_path(self) -> Path:
        """
        Always resolves to an absolute path.

        If STORAGE_ROOT is already absolute, it is used as-is.
        If it is relative (legacy or override), it is resolved from the
        project root — NOT from the CWD — ensuring consistency between
        the API process and the worker process.
        """
        p = Path(self.storage_root)
        if p.is_absolute():
            return p
        # Relative: anchor to project root, not CWD.
        return (_PROJECT_ROOT / p).resolve()

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def is_postgresql(self) -> bool:
        return "postgresql" in self.database_url

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @field_validator("jwt_secret")
    @classmethod
    def warn_default_secret(cls, v: str) -> str:
        if v == "change-me-before-first-use":
            import warnings
            warnings.warn(
                "JWT_SECRET is set to the default placeholder. "
                "Set a strong random value in .env before use.",
                stacklevel=2,
            )
        return v


# Module-level singleton — import this throughout the application.
settings = Settings()

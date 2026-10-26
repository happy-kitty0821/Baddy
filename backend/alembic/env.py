"""
Alembic environment configuration.

Reads DATABASE_URL from app.config.settings so that migration commands
automatically use the correct database for the current environment.

SQLite notes:
  - `render_as_batch=True` is required for ALTER TABLE operations on SQLite,
    which does not support them natively (Alembic rewrites the table instead).
  - This flag is harmless on PostgreSQL.

PostgreSQL notes:
  - Switch DATABASE_URL to a postgresql+psycopg://... URL.
  - Alembic will connect with the psycopg driver when available.
  - PostgreSQL compatibility has NOT been tested with integration tests yet.
    See docs/development-plan.md §PostgreSQL Integration Testing.
"""

from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# ── Make the backend package importable from the alembic/ subdirectory ──────
# parents[0] = alembic/, parents[1] = backend/, parents[2] = project root
_backend_dir = Path(__file__).resolve().parents[1]
_project_root = Path(__file__).resolve().parents[2]
# backend/ first so `app.*` imports resolve.
sys.path.insert(0, str(_backend_dir))
# project root second so `shared.*` imports resolve.
sys.path.insert(0, str(_project_root))

from app.config import settings  # noqa: E402
from app.database import Base  # noqa: E402
import app.models  # noqa: F401, E402 — registers all ORM models with Base.metadata

config = context.config

# Override the URL from our settings.
config.set_main_option("sqlalchemy.url", settings.database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations without a database connection (generates SQL script)."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,  # Required for SQLite ALTER TABLE support.
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations against a live database connection."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # Required for SQLite ALTER TABLE support.
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

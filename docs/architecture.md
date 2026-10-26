# Architecture

## Component overview

```
Browser (Next.js 15 + TypeScript)
  │
  │  HTTPS — REST API
  ▼
FastAPI application server
  │
  ├── SQLAlchemy ──────────────────► PostgreSQL (production)
  │                                  SQLite     (local development)
  │
  ├── Celery task dispatch ─────────► Redis (broker)
  │                                       │
  │                                       ▼
  │                              Celery worker
  │                                       │
  │                              Video processing pipeline
  │                              (Phase 2+: CV models)
  │
  └── LocalFileStorage ──────────► storage/
                                    videos/     (original uploads)
                                    artifacts/  (analysis outputs)
                                    exports/    (annotated videos)
                                    thumbnails/

  Optional (Phase 6+):
  Coaching service ─────────────► Ollama LLM on Ubuntu VM
                                   (authenticated private endpoint)
```

## Data boundaries

### PostgreSQL / SQLite

Stores all relational and queryable data:
- Match metadata, status, checksums
- Asset references (storage keys — not raw paths)
- Analysis run status, progress, errors
- Player tracks, pose observations (Phase 2+)
- Shuttle observations (Phase 4+)
- Shot events, court calibrations (Phases 3–5+)
- Coaching reports, user corrections (Phase 6+)

### File storage (`storage/`)

Stores all large binary data:
- Original uploaded videos (never overwritten after upload)
- Analysis artifacts (pose JSON, trajectory files)
- Exported annotated videos
- Thumbnails

Storage keys are opaque identifiers. Raw filesystem paths are never returned in API responses.

### Redis

Ephemeral broker and result backend for Celery only. Job status is always persisted to the database — Redis state is not the source of truth.

## Timestamp and coordinate conventions

- All timestamps stored as `timestamp_ms` (integer milliseconds from video start).
- Pixel coordinates use the original video resolution at analysis time.
- Court coordinates use BWF standard dimensions in metres, origin at top-left.
- Both `frame_index` and `timestamp_ms` are stored per observation.

## Analysis versioning

- Each analysis run has an `analysis_version` field recording the pipeline version.
- Reprocessing creates a new `AnalysisRun` record; it never mutates a completed one.
- User corrections are stored in `user_corrections` with a reference to the analysis version.

## Security boundaries

| Boundary | Mechanism |
|---|---|
| Browser → API | JWT Bearer token |
| API → storage | Internal filesystem access via `LocalFileStorage` |
| API → video stream | Authenticated `/api/assets/{id}/stream` endpoint |
| API → LLM | Internal API key (`LLM_API_KEY` env var) |
| Worker → DB/storage | Same credentials as API (internal network) |
| Cloudflare Tunnel | Transport only; provides no auth |

## Development vs production

| Aspect | Development (Windows) | Production (Linux) |
|---|---|---|
| Database | SQLite file (`data/badminton.db`) | PostgreSQL 16 |
| Storage | Local `storage/` directory | Mounted volume or S3-compatible |
| Worker pool | `--pool=solo` (Windows-safe) | `prefork` or `gevent` |
| Redis | Manual/WSL | Docker Compose service |
| HTTPS | Not required | Required |

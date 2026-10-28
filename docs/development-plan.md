# Development Plan

## Phase 1 — Persistent video library ✅

**Acceptance criteria:**
1. A video can be uploaded through the browser.
2. The API validates the file type and rejects invalid uploads.
3. The original file is stored at a stable UUID-based path.
4. SHA-256 checksum and FFmpeg metadata are recorded in the database.
5. The ingestion Celery task runs independently of the HTTP request.
6. The user can close the browser during upload; the job continues.
7. The match appears in the library after ingestion completes.
8. The match is still in the library after application restart.
9. The video streams and seeks correctly (HTTP Range requests).
10. Reopening a completed match does not start a new analysis job.
11. A failed ingestion job can be retried without duplicate records.
12. All Phase 1 tests pass.

**Status:** Implemented. See test results below.

### Test results (Phase 1)

```
26 tests, 26 passed, 0 failed
```

Run: `cd backend && pytest`

### PostgreSQL integration testing

⚠️ **Not yet performed.** Phase 1 is tested against SQLite only.

Before any production deployment:
1. Start PostgreSQL: `docker compose up postgres -d`
2. Set `DATABASE_URL=postgresql+psycopg://...` in `.env`
3. Run migrations: `alembic upgrade head`
4. Run full test suite: `pytest`
5. Manually perform the playback acceptance test (see below).
6. Only mark PostgreSQL-compatible once all tests pass.

### Playback acceptance test (manual)

1. Start the API and worker.
2. Upload a real MP4 file via the UI.
3. Wait for ingestion to complete.
4. Stop the API.
5. Restart the API.
6. Open the match in the library.
7. Confirm the video plays and seeks correctly.
8. Confirm reopening the match does not trigger another analysis run.

---

## Phase 2 — Player detection and skeleton ✅

**Prerequisites:**
- Phase 1 complete and tested. ✅
- GPU verified on Ubuntu VM (RTX 5060 Ti, driver 595.91, CUDA 13.2). ✅
- Model licenses confirmed (AGPL-3.0, personal use). ✅

**Models used:**
- Player detection + pose estimation: YOLO11n-pose (Ultralytics, AGPL-3.0)
- Tracking: ByteTrack (built into Ultralytics)

**Implementation:**
- Migration `0002`: `player_tracks`, `pose_frames`, `user_corrections` tables
- Vision API: `POST /vision`, `GET /tracks`, `GET /poses`, `PATCH /tracks/{id}`, `POST /corrections`
- Worker: `worker/tasks/vision.py` with YOLO11n-pose adapter
- Frontend: `SkeletonOverlay` component + `PlayerPanel` for identity selection
- Dynamic frame skip: `frame_skip = max(1, round(source_fps / target_fps))` — handles 30/60 fps

**Test results:**
- 77 backend tests (62 Phase 1 + 15 vision worker), all pass
- Frontend build: 7 routes, type check clean
- Migration 0002 verified on disposable SQLite DB

**Still required before production:**
1. Install `torch` (cu128) + `ultralytics` + `opencv-python-headless` on the Ubuntu VM
2. Benchmark a real badminton clip on the GPU
3. Run a real vision analysis on a match and verify the skeleton overlay renders correctly in the browser

---

## Phase 3 — Court calibration and movement

**Dependencies on Phase 2:** Player foot positions must be available.

**Risk:** Automated court-line detection from phone footage is unreliable.
Manual court marking must be available from the start.

---

## Phase 4 — Shuttle tracking

**Feasibility experiment required first:**
Benchmark TrackNetV2 on CPU. If >2 seconds/frame, evaluate YOLO + Kalman fallback.

---

## Phase 5 — Shot events

**Dependencies on Phase 4:** Shuttle trajectory required for contact detection.

---

## Phase 6 — Coaching and analytics

**LLM integration (Ollama on Ubuntu VM):**
- Verify `LLM_ENDPOINT_URL` is accessible from the production server.
- Verify the Ollama API is OpenAI-compatible at `/v1/chat/completions`.
- Implement authentication via `LLM_API_KEY` header.
- Test graceful fallback when the endpoint is unavailable.
- **Never** send raw video data or filesystem paths to the LLM.
- **Only** send validated structured data (metrics, events, coaching summaries).

---

## Phase 7 — Advanced analysis

Speed estimation, improved shuttle trajectories, tactical inference.
Each feature must be validated individually before being presented to the user.

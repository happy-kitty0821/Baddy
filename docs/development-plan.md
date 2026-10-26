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

## Phase 2 — Player detection and skeleton

**Prerequisites:**
- Phase 1 complete and tested.
- CPU inference speed benchmarked on this hardware.
- Model licenses confirmed.

**Models to evaluate:**
- Player detection: YOLOv8n (Ultralytics AGPL-3.0)
- Pose estimation: MediaPipe Pose (Apache 2.0)
- Tracking: ByteTrack (built into Ultralytics)

**Feasibility experiment required first:**
Run YOLOv8n + MediaPipe Pose on a 60-second test clip on the Windows dev machine.
Record: frames processed per second, total wall-clock time, peak RAM usage.
If too slow: evaluate frame-skipping, lower resolution, or lighter models.

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

# Badminton AI Coach

Personal badminton video analysis and coaching platform.

Upload match recordings, replay them with overlays, track movement, and receive evidence-based coaching feedback.

---

## Phase status

| Phase | Feature | Status |
|---|---|---|
| 1 | Persistent video upload, library, playback, background job infrastructure | ✅ Implemented |
| 2 | Player detection, tracking, skeleton overlay | 🔲 Not started |
| 3 | Court calibration, movement visualization | 🔲 Not started |
| 4 | Shuttlecock tracking and highlighting | 🔲 Not started |
| 5 | Shot events and timeline | 🔲 Not started |
| 6 | Coaching engine, historical analytics | 🔲 Not started |
| 7 | Advanced analysis (speed estimation, tactical inference) | 🔲 Not started |

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Python | 3.13+ | [python.org](https://python.org) |
| Node.js | 24+ | [nodejs.org](https://nodejs.org) |
| FFmpeg | 7+ | `winget install Gyan.FFmpeg` on Windows |
| Redis | 7+ | Required only to run the Celery worker |
| PostgreSQL | 16+ | Optional for local dev (SQLite is the default) |
| Docker Compose | v2+ | Optional — used for PostgreSQL + Redis in production |

---

## Local development (Windows, SQLite)

### 1. Clone and set up environment

```powershell
git clone <repo-url>
cd "Badminton AI Analysis"
Copy-Item .env.example .env
```

Edit `.env` at the **project root** and fill in all required values:

```ini
# Required — generate a strong random secret:
JWT_SECRET=<run: python -c "import secrets; print(secrets.token_hex(32))">

# Required — your login username:
AUTH_USERNAME=admin

# Required — bcrypt hash of your password. Generate with:
#   cd backend; .venv\Scripts\activate
#   python -c "from passlib.context import CryptContext; print(CryptContext(['bcrypt']).hash('your_password'))"
AUTH_PASSWORD_HASH=$2b$12$aZq9nCmzm5pELem4X8.Ov.6cHHhqJKilickDrKWKUQp3s.5JY7zmy
```

> **Security:** Never commit `.env`. Never store plaintext passwords. The app refuses to start in production if auth credentials are missing.

### 2. Backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
# Run database migrations (creates backend/data/badminton.db)
alembic upgrade head
# Start the API
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 3. Worker (requires Redis)

Start Redis first (use WSL, a standalone Redis build, or Docker:
`docker run -d -p 6379:6379 redis:7-alpine`).

```powershell
# Activate the venv from backend/, then cd to the project root
# (the worker/ package lives at the project root, not inside backend/)
cd backend
.venv\Scripts\activate
cd ..
celery -A worker.celery_app worker --loglevel=info --pool=solo
```

> If Redis is not running, uploads still succeed and matches appear in the library, but ingestion jobs stay queued until the worker can connect.

### 4. Frontend

```powershell
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You will be redirected to `/login` if not authenticated.

### 5. First login

1. Start the API, worker, and frontend.
2. Open `http://localhost:3000` — you will be redirected to `/login`.
3. Enter the `AUTH_USERNAME` and the **plaintext password** (not the hash) you set in `.env`.
4. After login, you are redirected to the dashboard.

---

## Running tests

```powershell
cd backend
.venv\Scripts\activate
pytest
```

Tests use a file-based SQLite database and temporary storage. No Docker, Redis, or external service is required.

**Test suite:** 51 tests covering storage, match API, ingestion, authentication, video streaming, latest-run retrieval, and Alembic migrations.

---

## Storage and paths

`STORAGE_ROOT` must be an absolute path. Both the API and the Celery worker must resolve to the same directory regardless of their working directory.

- The default is `<project_root>/storage` (derived from the project root, not the CWD).
- Override with an absolute path in `.env` if you need a custom location.
- Stored files: `storage/videos/`, `storage/artifacts/`, `storage/exports/`, `storage/thumbnails/`.
- All of `storage/` is gitignored.

---

## Video playback authentication

The native HTML `<video>` element cannot set HTTP headers. To authenticate video streaming requests, the stream endpoint accepts the JWT as a `?token=` query parameter. This token has the same expiry as the Bearer token used elsewhere. The backend validates it identically.

---

## PostgreSQL integration testing

**PostgreSQL compatibility is not yet verified.** Before any production deployment, run the full test suite against PostgreSQL:

```bash
# Start PostgreSQL and Redis
docker compose up postgres redis -d

# Update .env
DATABASE_URL=postgresql+psycopg://badminton:changeme@localhost:5432/badminton

# Install the psycopg driver
pip install "psycopg[binary]==3.2.9"

# Run migrations
cd backend && alembic upgrade head

# Run tests
pytest
```

See [docs/development-plan.md](docs/development-plan.md) for the full checklist.

---

## Production deployment (Linux, Docker Compose)

```bash
cp .env.example .env
# Edit .env with production values (strong JWT_SECRET, real DATABASE_URL,
# AUTH_USERNAME, AUTH_PASSWORD_HASH)
docker compose up -d
docker compose exec api alembic upgrade head
```

> The app will refuse to start in production if `AUTH_USERNAME` or `AUTH_PASSWORD_HASH` is missing.

---

## Documentation

- [Architecture](docs/architecture.md)
- [Development Plan](docs/development-plan.md)
- [Model Evaluation](docs/model-evaluation.md)

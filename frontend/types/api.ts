/**
 * TypeScript types that mirror the FastAPI Pydantic schemas.
 * Keep in sync with backend/app/schemas/*.py.
 */

// ── Matches ──────────────────────────────────────────────────────────────────

export interface MatchRead {
  id: string;
  title: string;
  recorded_at: string | null;
  uploaded_at: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps_num: number | null;
  fps_den: number | null;
  codec: string | null;
  file_size_bytes: number | null;
  checksum: string | null;
  notes: string | null;
  opponent_label: string | null;
  session_type: string | null;
  tags: string[];
  status: MatchStatus;
  created_at: string;
  updated_at: string;
  source_asset_id: string | null;
}

export type MatchStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "deleted";

export interface MatchListResponse {
  items: MatchRead[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface MatchCreate {
  title: string;
  recorded_at?: string | null;
  opponent_label?: string | null;
  session_type?: string | null;
  notes?: string | null;
  tags?: string[];
}

// ── Analysis runs ─────────────────────────────────────────────────────────────

export interface AnalysisRunRead {
  id: string;
  match_id: string;
  status: AnalysisStatus;
  pipeline_config: string | null;
  analysis_version: string | null;
  celery_task_id: string | null;
  progress_pct: number;
  current_stage: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

export type AnalysisStatus =
  | "queued"
  | "ingesting"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

// ── Assets ────────────────────────────────────────────────────────────────────

export interface AssetRead {
  id: string;
  match_id: string;
  asset_type: string;
  mime_type: string | null;
  size_bytes: number | null;
  checksum: string | null;
  original_filename: string | null;
  created_at: string;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface UserRead {
  username: string;
}

// ── API error shape ───────────────────────────────────────────────────────────

export interface APIError {
  detail: string | { msg: string; type: string }[];
}

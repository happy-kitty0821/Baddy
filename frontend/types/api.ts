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

// ── Phase 2: Vision ──────────────────────────────────────────────────────────

export interface PlayerTrack {
  id: string;
  analysis_run_id: string;
  track_id: number;
  track_label: string;
  is_selected_player: boolean;
  identity_note: string | null;
  identity_confidence: number | null;
  created_at: string;
}

export interface PoseFrame {
  id: string;
  analysis_run_id: string;
  player_track_id: string;
  timestamp_ms: number;
  frame_index: number;
  bbox_x: number | null;
  bbox_y: number | null;
  bbox_w: number | null;
  bbox_h: number | null;
  bbox_conf: number | null;
  keypoints: number[][]; // [[x, y, conf], ...] 17 COCO points in source pixels
  overall_conf: number | null;
  source_width: number;
  source_height: number;
  model_id: string | null;
  created_at: string;
}

export interface PoseFrameListResponse {
  items: PoseFrame[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

export interface VisionCreate {
  frame_skip?: number;
  confidence?: number;
  device?: string;
}

export interface PlayerIdentityUpdate {
  is_selected_player?: boolean;
  identity_note?: string | null;
}

export interface CourtHalfAssignment {
  near_end: PlayerTrack | null;
  far_end: PlayerTrack | null;
  axis: "y" | "x";
  ambiguous: boolean;
}

// ── Phase 4: Shuttle Tracking ─────────────────────────────────────────────

export interface ShuttleObservation {
  id: string;
  analysis_run_id: string;
  timestamp_ms: number;
  frame_index: number;
  x: number | null;
  y: number | null;
  confidence: number | null;
  observation_status: "detected" | "interpolated" | "unavailable";
  source_width: number;
  source_height: number;
  created_at: string;
}

export interface ShuttleObservationListResponse {
  items: ShuttleObservation[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

// ── Phase 3: Court Calibration ────────────────────────────────────────────

export interface CourtCalibration {
  id: string;
  analysis_run_id: string;
  timestamp_ms: number;
  frame_index: number;
  corners_json: string;
  homography_json: string;
  drift_px: number | null;
  confidence: number;
  created_at: string;
}

export interface CourtCalibrationListResponse {
  items: CourtCalibration[];
  total: number;
}

// ── System info (Profile page) ───────────────────────────────────────────────

export interface SystemGpu {
  index?: number;
  name?: string;
  vram_total_gb?: number;
  vram_reserved_gb?: number;
  vram_allocated_gb?: number;
  vram_free_gb?: number;
  cuda_capability?: string;
  sm_count?: number;
  cuda_version?: string;
  torch_version?: string;
  util_gpu_pct?: number;
  util_mem_pct?: number;
  temp_celsius?: number;
  available: boolean;
  reason?: string;
}

export interface SystemInfo {
  platform: {
    os: string;
    os_version: string;
    os_release: string;
    machine: string;
    hostname: string;
  };
  cpu: {
    name: string;
    physical_cores?: number;
    logical_cores?: number;
    freq_mhz_current?: number;
    freq_mhz_max?: number;
    usage_pct?: number;
  };
  ram: {
    total_gb?: number;
    available_gb?: number;
    used_gb?: number;
    usage_pct?: number;
  };
  disk: {
    path?: string;
    total_gb?: number;
    used_gb?: number;
    free_gb?: number;
    usage_pct?: number;
  };
  gpus: SystemGpu[];
  python: {
    version: string;
    implementation: string;
    executable: string;
  };
  models: Record<string, {
    name: string;
    task: string;
    available: boolean;
    weights_cached?: boolean;
    weights_path?: string | null;
  }>;
  capabilities: Record<string, boolean>;
  config: Record<string, string | number | boolean>;
}

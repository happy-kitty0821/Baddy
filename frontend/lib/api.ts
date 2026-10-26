/**
 * Typed API client for the Badminton AI Coach backend.
 *
 * All requests go through the Next.js rewrite proxy (/api/...) so the
 * browser never needs direct access to the FastAPI origin.
 *
 * Authentication:
 *   The JWT token is stored in localStorage under "bac_token".
 *   All API calls automatically include it as a Bearer token.
 *   Call `apiClient.setToken(token)` after login and
 *   `apiClient.clearToken()` on logout.
 */

import type {
  AnalysisRunRead,
  AssetRead,
  MatchCreate,
  MatchListResponse,
  MatchRead,
  TokenResponse,
  UserRead,
} from "@/types/api";

const API_BASE = "/api";

const TOKEN_KEY = "bac_token";

// ── Token management ─────────────────────────────────────────────────────────

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ── Base fetch helper ─────────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const err = await response.json();
      detail = typeof err.detail === "string"
        ? err.detail
        : JSON.stringify(err.detail);
    } catch {
      // ignore parse error
    }
    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function login(username: string, password: string): Promise<TokenResponse> {
  const result = await apiFetch<TokenResponse>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  setToken(result.access_token);
  return result;
}

async function getMe(): Promise<UserRead> {
  return apiFetch<UserRead>("/auth/me");
}

function logout(): void {
  clearToken();
}

// ── Matches ───────────────────────────────────────────────────────────────────

async function uploadMatch(
  formData: FormData
): Promise<MatchRead> {
  return apiFetch<MatchRead>("/matches", {
    method: "POST",
    body: formData,
    // Do NOT set Content-Type — the browser sets it with the boundary.
  });
}

async function listMatches(params?: {
  page?: number;
  page_size?: number;
  status?: string;
  search?: string;
}): Promise<MatchListResponse> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.page_size) qs.set("page_size", String(params.page_size));
  if (params?.status) qs.set("status", params.status);
  if (params?.search) qs.set("search", params.search);
  const query = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch<MatchListResponse>(`/matches${query}`);
}

async function getMatch(matchId: string): Promise<MatchRead> {
  return apiFetch<MatchRead>(`/matches/${matchId}`);
}

async function deleteMatch(matchId: string): Promise<void> {
  return apiFetch<void>(`/matches/${matchId}`, { method: "DELETE" });
}

async function updateMatch(
  matchId: string,
  data: Partial<MatchCreate>
): Promise<MatchRead> {
  return apiFetch<MatchRead>(`/matches/${matchId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ── Analysis runs ─────────────────────────────────────────────────────────────

async function getAnalysis(runId: string): Promise<AnalysisRunRead> {
  return apiFetch<AnalysisRunRead>(`/analyses/${runId}`);
}

async function getLatestAnalysis(matchId: string): Promise<AnalysisRunRead> {
  return apiFetch<AnalysisRunRead>(`/matches/${matchId}/analyses/latest`);
}

async function startAnalysis(matchId: string): Promise<AnalysisRunRead> {
  return apiFetch<AnalysisRunRead>(`/matches/${matchId}/analyses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function retryAnalysis(runId: string): Promise<AnalysisRunRead> {
  return apiFetch<AnalysisRunRead>(`/analyses/${runId}/retry`, {
    method: "POST",
  });
}

// ── Assets ────────────────────────────────────────────────────────────────────

function getAssetStreamUrl(assetId: string): string {
  return `${API_BASE}/assets/${assetId}/stream`;
}

function getAssetStreamUrlWithToken(assetId: string): string {
  // For use in <video src="..."> where we can't set headers.
  // The backend must accept the token as a query param too (Phase 2).
  // For now, return the stream URL; the <video> element will hit it
  // without auth (the route requires auth, so the server will 401).
  // TODO: implement signed URL or cookie-based auth for video playback.
  return `${API_BASE}/assets/${assetId}/stream`;
}

// ── Exports ───────────────────────────────────────────────────────────────────

const apiClient = {
  // auth
  login,
  logout,
  getMe,
  setToken,
  clearToken,
  getToken,
  // matches
  uploadMatch,
  listMatches,
  getMatch,
  deleteMatch,
  updateMatch,
  // analyses
  getAnalysis,
  getLatestAnalysis,
  startAnalysis,
  retryAnalysis,
  // assets
  getAssetStreamUrl,
  getAssetStreamUrlWithToken,
};

export default apiClient;

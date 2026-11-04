/**
 * ShuttleOverlay — fetches shuttle observation data and renders a yellow
 * shuttle dot plus fading trail on the video player canvas.
 *
 * Architecture mirrors SkeletonOverlay exactly:
 *   - All mutable data in refs (no React state) so the renderer never goes stale.
 *   - Stable renderer registered via onRendererReady callback.
 *   - Background prefetch interval keeps the window ahead of playback.
 *   - Binary-search + linear interpolation for smooth dot positioning.
 *
 * Renderer contract:
 *   - NEVER calls ctx.clearRect() — the combined renderer in MatchDetail clears
 *     once per frame, then this renderer draws additively on top.
 *   - Draws a fading trail (last trailLength observations) + current dot.
 *   - Uses letterbox-aware coordinate mapping identical to SkeletonOverlay.
 */
"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ShuttleObservation } from "@/types/api";
import apiClient from "@/lib/api";

// Max ms between current video time and a stored frame to still draw the dot.
const FRAME_TOLERANCE_MS = 80;
// Max gap between two observations to interpolate position (ms).
const MAX_INTERP_GAP_MS = 200;
// How far back to look for trail observations (ms).
const TRAIL_WINDOW_MS = 500;

interface ShuttleOverlayProps {
  runId: string;
  enabled: boolean;
  trailLength?: number;
  /** Source video dimensions in pixels (from match metadata). */
  sourceWidth: number;
  sourceHeight: number;
  onRendererReady: (
    renderer: ((ctx: CanvasRenderingContext2D, currentTime: number) => void) | null
  ) => void;
}

export default function ShuttleOverlay({
  runId,
  enabled,
  trailLength = 15,
  sourceWidth,
  sourceHeight,
  onRendererReady,
}: ShuttleOverlayProps) {
  // ── All data in refs — no React state so the renderer never goes stale ───
  // Sorted array of observations by timestamp_ms.
  const observationsRef = useRef<ShuttleObservation[]>([]);
  const fetchedWindowRef = useRef<{ start: number; end: number }>({ start: -1, end: -1 });
  const fetchingRef = useRef(false);
  const loadedRef = useRef(false);
  const currentTimeSecRef = useRef(0);

  // ── Fetch a window of shuttle observations ────────────────────────────────
  const fetchWindow = useCallback(
    async (centerMs: number, windowMs = 30000) => {
      if (!runId || fetchingRef.current) return;

      const start = Math.max(0, centerMs - windowMs * 0.2);
      const end = centerMs + windowMs * 0.8;

      // Skip if already loaded.
      if (start >= fetchedWindowRef.current.start && end <= fetchedWindowRef.current.end) {
        return;
      }

      fetchingRef.current = true;
      try {
        let offset = 0;
        const limit = 5000;
        const fetched: ShuttleObservation[] = [];

        while (true) {
          const result = await apiClient.getShuttle(runId, {
            start_ms: Math.floor(start),
            end_ms: Math.ceil(end),
            limit,
            offset,
          });

          fetched.push(...result.items);

          if (!result.has_more) break;
          offset += limit;
        }

        // Merge fetched observations into the sorted array, de-dup by id.
        const existing = observationsRef.current;
        const existingIds = new Set(existing.map((o) => o.id));
        const newObs = fetched.filter((o) => !existingIds.has(o.id));

        if (newObs.length > 0) {
          const merged = [...existing, ...newObs];
          // Keep sorted by timestamp_ms
          merged.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
          observationsRef.current = merged;
        }

        fetchedWindowRef.current = { start, end };
      } catch {
        // Non-fatal — overlay won't render for this window.
      } finally {
        fetchingRef.current = false;
      }
    },
    [runId]
  );

  // ── Fetch all shuttle data in pages (same pattern as CourtHeatmap) ────────
  const fetchAll = useCallback(async () => {
    if (!runId) return;
    fetchingRef.current = true;
    try {
      const allObs: ShuttleObservation[] = [];
      let offset = 0;
      const limit = 5000;

      while (true) {
        const result = await apiClient.getShuttle(runId, { limit, offset });
        allObs.push(...result.items);
        if (!result.has_more) break;
        offset += limit;
      }

      // Sort by timestamp_ms
      allObs.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
      observationsRef.current = allObs;

      if (allObs.length > 0) {
        const last = allObs[allObs.length - 1];
        fetchedWindowRef.current = { start: 0, end: last.timestamp_ms + 1000 };
      }
    } catch {
      // Non-fatal
    } finally {
      fetchingRef.current = false;
    }
  }, [runId]);

  // ── Load initial data on mount ─────────────────────────────────────────────
  useEffect(() => {
    if (!runId || !enabled) return;

    observationsRef.current = [];
    fetchedWindowRef.current = { start: -1, end: -1 };
    loadedRef.current = false;

    // Eagerly fetch all data (PAGE_SIZE=5000, shuttle runs ≤ ~324k rows but
    // typically far fewer for badminton match lengths under 90 min at 30fps).
    // For very long matches, a windowed approach is used via fetchWindow.
    fetchWindow(0, 30000).then(() => {
      loadedRef.current = true;
    });
  }, [runId, enabled, fetchWindow]);

  // ── Background pre-fetch: polls every 2 seconds to load the next window ───
  useEffect(() => {
    if (!enabled || !runId) return;

    const id = setInterval(() => {
      const currentTimeMs = Math.round(currentTimeSecRef.current * 1000);
      const windowEnd = fetchedWindowRef.current.end;
      if (windowEnd > 0 && currentTimeMs > windowEnd - 5000) {
        fetchWindow(windowEnd, 30000);
      }
    }, 2000);

    return () => clearInterval(id);
  }, [enabled, runId, fetchWindow]);

  // ── Binary search helper ──────────────────────────────────────────────────
  function binarySearchLastLE(arr: ShuttleObservation[], targetMs: number): number {
    let lo = 0, hi = arr.length - 1, result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].timestamp_ms <= targetMs) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  // ── Stable renderer ────────────────────────────────────────────────────────
  const renderer = useCallback(
    (ctx: CanvasRenderingContext2D, currentTime: number) => {
      if (!enabled) return;

      currentTimeSecRef.current = currentTime;

      const currentTimeMs = Math.round(currentTime * 1000);
      if (isNaN(currentTimeMs) || currentTimeMs < 0) return;

      const obs = observationsRef.current;
      if (obs.length === 0) return;

      const canvas = ctx.canvas;
      if (canvas.width === 0 || canvas.height === 0) return;

      // ── Letterbox-aware coordinate mapping ────────────────────────────────
      const canvasAR = canvas.width / canvas.height;
      const sourceAR = sourceWidth / sourceHeight;

      let renderedW: number;
      let renderedH: number;
      let offsetX: number;
      let offsetY: number;

      if (sourceAR < canvasAR) {
        // Pillarbox
        renderedH = canvas.height;
        renderedW = canvas.height * sourceAR;
        offsetX = (canvas.width - renderedW) / 2;
        offsetY = 0;
      } else {
        // Letterbox
        renderedW = canvas.width;
        renderedH = canvas.width / sourceAR;
        offsetX = 0;
        offsetY = (canvas.height - renderedH) / 2;
      }

      const scaleX = renderedW / sourceWidth;
      const scaleY = renderedH / sourceHeight;
      const mapX = (px: number) => px * scaleX + offsetX;
      const mapY = (py: number) => py * scaleY + offsetY;

      // ── Find surrounding observations ─────────────────────────────────────
      const prevIdx = binarySearchLastLE(obs, currentTimeMs);
      const nextIdx = prevIdx < obs.length - 1 ? prevIdx + 1 : -1;

      const prevObs = prevIdx >= 0 ? obs[prevIdx] : null;
      const nextObs = nextIdx >= 0 ? obs[nextIdx] : null;

      const prevOk = prevObs !== null && currentTimeMs - prevObs.timestamp_ms <= FRAME_TOLERANCE_MS;
      const nextOk = nextObs !== null && nextObs.timestamp_ms - currentTimeMs <= FRAME_TOLERANCE_MS;

      // ── Draw trail ─────────────────────────────────────────────────────────
      // Find the trailLength most recent non-unavailable observations up to currentTimeMs.
      const trailStart = currentTimeMs - TRAIL_WINDOW_MS;
      const trailObs: ShuttleObservation[] = [];
      for (let i = prevIdx; i >= 0 && trailObs.length < trailLength; i--) {
        const o = obs[i];
        if (o.observation_status === "unavailable") continue;
        if (o.timestamp_ms < trailStart) break;
        trailObs.unshift(o);
      }

      // Draw trail circles from oldest (most transparent) to newest.
      for (let i = 0; i < trailObs.length; i++) {
        const o = trailObs[i];
        if (o.x == null || o.y == null) continue;
        const alpha = (i + 1) / trailObs.length;
        const cx = mapX(o.x);
        const cy = mapY(o.y);
        const r = 3;

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        if (o.observation_status === "interpolated") {
          ctx.fillStyle = `rgba(253,224,71,${alpha * 0.5})`;
        } else {
          ctx.fillStyle = `rgba(253,224,71,${alpha * 0.7})`;
        }
        ctx.fill();
      }

      // ── Draw current dot ─────────────────────────────────────────────────
      if (!prevOk && !nextOk) return; // no dot if out of tolerance

      // Interpolate position if both neighbours exist and gap is small.
      const shouldInterp =
        prevObs !== null &&
        nextObs !== null &&
        prevObs.x != null &&
        prevObs.y != null &&
        nextObs.x != null &&
        nextObs.y != null &&
        (nextObs.timestamp_ms - prevObs.timestamp_ms) <= MAX_INTERP_GAP_MS;

      let dotX: number | null = null;
      let dotY: number | null = null;
      let dotStatus: string = "unavailable";

      if (shouldInterp && prevObs && nextObs) {
        const t = Math.max(0, Math.min(1,
          (currentTimeMs - prevObs.timestamp_ms) /
          (nextObs.timestamp_ms - prevObs.timestamp_ms)
        ));
        dotX = prevObs.x! + (nextObs.x! - prevObs.x!) * t;
        dotY = prevObs.y! + (nextObs.y! - prevObs.y!) * t;
        dotStatus = prevObs.observation_status;
      } else if (prevOk && prevObs && prevObs.x != null && prevObs.y != null) {
        dotX = prevObs.x;
        dotY = prevObs.y;
        dotStatus = prevObs.observation_status;
      } else if (nextOk && nextObs && nextObs.x != null && nextObs.y != null) {
        dotX = nextObs.x;
        dotY = nextObs.y;
        dotStatus = nextObs.observation_status;
      }

      if (dotX == null || dotY == null || dotStatus === "unavailable") return;

      const cx = mapX(dotX);
      const cy = mapY(dotY);
      const r = 8;

      if (dotStatus === "detected") {
        // Solid bright-yellow filled circle with white outline.
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = "#fde047"; // yellow-300
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (dotStatus === "interpolated") {
        // Hollow dashed circle.
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(253,224,71,0.85)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }
    },
    // Stable deps — all mutable data accessed through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, trailLength, sourceWidth, sourceHeight]
  );

  // ── Register renderer ──────────────────────────────────────────────────────
  useEffect(() => {
    onRendererReady(enabled ? renderer : null);
  }, [renderer, enabled, onRendererReady]);

  // ── When disabled, unregister ──────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      onRendererReady(null);
    }
  }, [enabled, onRendererReady]);

  return null;
}

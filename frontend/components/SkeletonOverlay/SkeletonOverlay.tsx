/**
 * SkeletonOverlay — fetches pose data and renders a green skeleton overlay
 * on the video player canvas.
 *
 * Architecture:
 *   All mutable data (frames, tracks, fetch window) is stored in refs, not
 *   React state.  This means the renderer closure is stable — it never goes
 *   stale, never causes unnecessary re-renders, and always reads the latest
 *   data via the ref.
 *
 *   Pre-loading: when the overlay mounts and data is ready, we eagerly fetch
 *   the first 30 seconds so the first frame is drawn immediately.  As the
 *   video plays, we fetch the next window 5 seconds before it's needed.
 *
 * Coordinate scaling:
 *   Pose keypoints are stored in source video pixels (e.g. 1920×1080).
 *   The canvas is sized to the video element's rendered size, so we scale:
 *     scaleX = canvas.width / source_width
 *     scaleY = canvas.height / source_height
 *
 * Tolerance:
 *   The renderer looks for the nearest stored frame within ±50ms of the
 *   current video time.  At 30fps one frame is 33ms, so this never shows
 *   a frame that's more than ~1.5 frames stale.  If no frame is within
 *   tolerance the canvas is cleared so there's no ghost/trailing image.
 */
"use client";

import { useCallback, useEffect, useRef } from "react";
import type { PoseFrame } from "@/types/api";
import apiClient from "@/lib/api";

// COCO 17-keypoint skeleton connections (0-indexed pairs).
const SKELETON_CONNECTIONS: [number, number][] = [
  [0, 1], [0, 2], [1, 3], [2, 4], [1, 2], [3, 4],   // face
  [5, 6], [5, 11], [6, 12], [11, 12],               // torso
  [5, 7], [7, 9], [6, 8], [8, 10],                  // arms
  [11, 13], [13, 15], [12, 14], [14, 16],           // legs
  [0, 5],                                            // head-torso
];

const CONFIDENCE_THRESHOLD = 0.3;
// Maximum milliseconds between the video time and a stored frame to still
// draw it.  At 30fps a frame is 33ms; 50ms = ≤1.5 frames tolerance.
// Below this the skeleton follows the player precisely with no trailing.
const FRAME_TOLERANCE_MS = 50;

interface SkeletonOverlayProps {
  runId: string;
  enabled: boolean;
  showBoxes: boolean;
  showTrackIds: boolean;
  /** "near" or "far" to show only one court half; null = both. */
  courtSide: "near" | "far" | null;
  sourceWidth: number;
  sourceHeight: number;
  onRendererReady: (
    renderer: ((ctx: CanvasRenderingContext2D, currentTime: number) => void) | null
  ) => void;
}

export default function SkeletonOverlay({
  runId,
  enabled,
  showBoxes,
  showTrackIds,
  courtSide,
  sourceWidth,
  sourceHeight,
  onRendererReady,
}: SkeletonOverlayProps) {
  // ── All data in refs — no React state so the renderer never goes stale ───
  // Map<timestamp_ms, PoseFrame[]>
  const framesRef = useRef<Map<number, PoseFrame[]>>(new Map());
  const fetchedWindowRef = useRef<{ start: number; end: number }>({ start: -1, end: -1 });
  const fetchingRef = useRef(false);
  const loadedRef = useRef(false);

  // ── Fetch a window of poses ────────────────────────────────────────────────
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
        const limit = 1000;
        const newMap = new Map<number, PoseFrame[]>(framesRef.current);

        while (true) {
          const result = await apiClient.getPoses(runId, {
            start_ms: start,
            end_ms: end,
            court_side: courtSide ?? undefined,
            limit,
            offset,
          });

          for (const f of result.items) {
            const existing = newMap.get(f.timestamp_ms) ?? [];
            // Avoid exact duplicates from overlapping windows.
            if (!existing.some((e) => e.id === f.id)) {
              existing.push(f);
            }
            newMap.set(f.timestamp_ms, existing);
          }

          if (!result.has_more) break;
          offset += limit;
        }

        framesRef.current = newMap;
        fetchedWindowRef.current = { start, end };
      } catch {
        // Non-fatal — the overlay won't render for this window.
      } finally {
        fetchingRef.current = false;
      }
    },
    [runId, courtSide]
  );

  // ── Load initial data on mount ─────────────────────────────────────────────
  useEffect(() => {
    if (!runId || !enabled) return;

    framesRef.current = new Map();
    fetchedWindowRef.current = { start: -1, end: -1 };
    loadedRef.current = false;

    // Eagerly fetch the first 30 seconds so the first play is smooth.
    fetchWindow(0, 30000).then(() => {
      loadedRef.current = true;
    });
  }, [runId, enabled, courtSide, fetchWindow]);

  // ── Stable renderer — reads from refs, never becomes stale ───────────────
  const renderer = useCallback(
    (ctx: CanvasRenderingContext2D, currentTime: number) => {
      if (!enabled) {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        return;
      }

      const currentTimeMs = Math.round(currentTime * 1000);
      if (isNaN(currentTimeMs) || currentTimeMs < 0) return;

      // Pre-fetch the next window 5 seconds before it's needed.
      const windowEnd = fetchedWindowRef.current.end;
      if (windowEnd > 0 && currentTimeMs > windowEnd - 5000) {
        fetchWindow(windowEnd, 30000);
      }

      const frames = framesRef.current;

      // Find the nearest stored frame within FRAME_TOLERANCE_MS.
      let nearest: PoseFrame[] | null = null;
      let nearestDiff = Infinity;

      for (const [ts, fs] of frames) {
        const diff = Math.abs(ts - currentTimeMs);
        if (diff < nearestDiff && diff <= FRAME_TOLERANCE_MS) {
          nearestDiff = diff;
          nearest = fs;
        }
      }

      // Always clear — prevents ghost/trailing images when out of tolerance.
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

      if (!nearest || nearest.length === 0) return;

      const canvas = ctx.canvas;
      if (canvas.width === 0 || canvas.height === 0) return;

      const scaleX = canvas.width / sourceWidth;
      const scaleY = canvas.height / sourceHeight;

      for (const frame of nearest) {
        const kps = frame.keypoints;
        if (!kps || kps.length === 0) continue;

        // ── Bounding box ──────────────────────────────────────────────────
        if (showBoxes && frame.bbox_x != null && frame.bbox_y != null &&
            frame.bbox_w != null && frame.bbox_h != null) {
          const bx = frame.bbox_x * scaleX;
          const by = frame.bbox_y * scaleY;
          const bw = frame.bbox_w * scaleX;
          const bh = frame.bbox_h * scaleY;
          ctx.globalAlpha = 0.4;
          ctx.strokeStyle = "rgba(0, 255, 100, 1)";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(bx, by, bw, bh);
          ctx.globalAlpha = 1;

          if (showTrackIds) {
            ctx.fillStyle = "rgba(0, 255, 100, 0.8)";
            ctx.font = "bold 12px sans-serif";
            ctx.fillText("player", bx, by - 4);
          }
        }

        // ── Skeleton connections ──────────────────────────────────────────
        for (const [a, b] of SKELETON_CONNECTIONS) {
          if (a >= kps.length || b >= kps.length) continue;
          const ka = kps[a];
          const kb = kps[b];
          if (!ka || !kb) continue;
          const confA = ka[2] ?? 0;
          const confB = kb[2] ?? 0;
          const confident = confA > CONFIDENCE_THRESHOLD && confB > CONFIDENCE_THRESHOLD;

          ctx.beginPath();
          ctx.moveTo(ka[0] * scaleX, ka[1] * scaleY);
          ctx.lineTo(kb[0] * scaleX, kb[1] * scaleY);
          ctx.strokeStyle = confident
            ? "rgba(0, 255, 80, 0.9)"
            : "rgba(0, 200, 60, 0.25)";
          ctx.lineWidth = confident ? 2.5 : 1;
          ctx.stroke();
        }

        // ── Keypoints ─────────────────────────────────────────────────────
        for (let i = 0; i < kps.length; i++) {
          const kp = kps[i];
          if (!kp) continue;
          const conf = kp[2] ?? 0;
          if (conf < 0.15) continue; // skip very low confidence points entirely
          const x = kp[0] * scaleX;
          const y = kp[1] * scaleY;
          const r = conf > CONFIDENCE_THRESHOLD ? 4 : 2.5;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = conf > CONFIDENCE_THRESHOLD
            ? "rgba(0, 255, 80, 1)"
            : "rgba(0, 200, 60, 0.4)";
          ctx.fill();
        }
      }
    },
    // Deliberately only depends on primitive/stable values.
    // framesRef and fetchedWindowRef are refs so they don't trigger re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, showBoxes, showTrackIds, sourceWidth, sourceHeight, fetchWindow]
  );

  // ── Register renderer once (and whenever it genuinely changes) ────────────
  useEffect(() => {
    onRendererReady(enabled ? renderer : null);
  }, [renderer, enabled, onRendererReady]);

  // ── When overlay is disabled, clear the canvas ────────────────────────────
  useEffect(() => {
    if (!enabled) {
      onRendererReady(null);
    }
  }, [enabled, onRendererReady]);

  return null;
}

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
// draw it.  At 30fps a frame is 33ms; 80ms = ~2.4 frames tolerance.
// Wider than 50ms to reduce blank flashes when the clock lands slightly
// outside a frame boundary without introducing visible ghost images.
const FRAME_TOLERANCE_MS = 80;

interface SkeletonOverlayProps {
  runId: string;
  enabled: boolean;
  showBoxes: boolean;
  showTrackIds: boolean;
  /** "near" or "far" to show only one court half; null = both. */
  courtSide: "near" | "far" | null;
  /** Source video dimensions in pixels (from match metadata). */
  sourceWidth: number;
  sourceHeight: number;
  /** Hex colour for the "near" player skeleton/box. Default: #22c55e green. */
  nearColor?: string;
  /** Hex colour for the "far" player skeleton/box. Default: #3b82f6 blue. */
  farColor?: string;
  /** Label shown next to the "near" player's bounding box. Default: "Near". */
  nearLabel?: string;
  /** Label shown next to the "far" player's bounding box. Default: "Far". */
  farLabel?: string;
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
  nearColor = "#22c55e",
  farColor  = "#3b82f6",
  nearLabel = "Near",
  farLabel  = "Far",
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
        const limit = 5000;
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

  // ── Background pre-fetch: polls every 2 seconds to load the next window ──
  // Deliberately kept OUTSIDE the renderer so the draw callback is purely
  // synchronous canvas operations with no async / microtask pressure.
  const currentTimeSecRef = useRef(0);
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

  // ── Stable renderer — reads from refs, never becomes stale ───────────────
  const renderer = useCallback(
    (ctx: CanvasRenderingContext2D, currentTime: number) => {
      if (!enabled) {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        return;
      }

      // Keep currentTimeSecRef updated so the interval above can see
      // the latest video time without any async work inside this callback.
      currentTimeSecRef.current = currentTime;

      const currentTimeMs = Math.round(currentTime * 1000);
      if (isNaN(currentTimeMs) || currentTimeMs < 0) return;

      const frames = framesRef.current;

      // Build a sorted key array for binary-search-based interpolation.
      const sortedKeys = Array.from(frames.keys()).sort((a, b) => a - b);
      if (sortedKeys.length === 0) {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        return;
      }

      // Binary-search for the last key ≤ currentTimeMs.
      let lo = 0, hi = sortedKeys.length - 1, prevIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sortedKeys[mid] <= currentTimeMs) { prevIdx = mid; lo = mid + 1; }
        else hi = mid - 1;
      }

      const prevTs = prevIdx >= 0 ? sortedKeys[prevIdx] : null;
      const nextTs = prevIdx < sortedKeys.length - 1 ? sortedKeys[prevIdx + 1] : null;

      // Tolerance guard — if neither neighbour is close enough, clear and bail.
      const prevOk = prevTs !== null && currentTimeMs - prevTs <= FRAME_TOLERANCE_MS;
      const nextOk = nextTs !== null && nextTs - currentTimeMs <= FRAME_TOLERANCE_MS;

      // Always clear — prevents ghost/trailing images when out of tolerance.
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

      if (!prevOk && !nextOk) return;

      // Only interpolate when both neighbours exist AND gap is ≤ 200ms.
      // If the gap is too large (dropped frames), snap to prevTs.
      const shouldInterpolate =
        prevTs !== null && nextTs !== null && (nextTs - prevTs) <= 200;

      const t = shouldInterpolate
        ? Math.max(0, Math.min(1, (currentTimeMs - prevTs!) / (nextTs! - prevTs!)))
        : 0;

      const prevFrames = prevTs !== null ? (frames.get(prevTs) ?? []) : [];
      const nextFrames = nextTs !== null ? (frames.get(nextTs) ?? []) : [];

      // Build one interpolated PoseFrame per prevFrame entry.
      const renderFrames: PoseFrame[] = prevFrames.map((prevFrame) => {
        if (!shouldInterpolate || t === 0) return prevFrame;

        // Match nextFrame by player_track_id for same-player interpolation.
        const nextFrame = nextFrames.find(
          (nf) => nf.player_track_id === prevFrame.player_track_id
        );
        if (!nextFrame) return prevFrame;

        const kps = prevFrame.keypoints ?? [];
        const nkps = nextFrame.keypoints ?? [];
        const interpKps: number[][] = kps.map((pk, i) => {
          const nk = nkps[i];
          // Only interpolate when both keypoints are confident enough.
          if (!nk || (pk[2] ?? 0) <= 0.15 || (nk[2] ?? 0) <= 0.15) {
            return pk;
          }
          return [
            pk[0] + (nk[0] - pk[0]) * t,
            pk[1] + (nk[1] - pk[1]) * t,
            pk[2] + (nk[2] - pk[2]) * t,
          ];
        });

        // Return a synthetic PoseFrame with interpolated keypoints.
        // bbox is deliberately kept from prevFrame (not interpolated).
        return { ...prevFrame, keypoints: interpKps };
      });

      if (renderFrames.length === 0) return;

      const canvas = ctx.canvas;
      if (canvas.width === 0 || canvas.height === 0) return;

      // ── Letterbox-aware coordinate mapping ──────────────────────────────
      // The video element uses object-fit: contain inside an aspect-video
      // (16:9) container.  For non-16:9 source videos (e.g. 608×1080 = 9:16)
      // the browser adds black bars.  Keypoints are in source pixels, so we
      // must map them onto the actual video content rect, not the full canvas.
      //
      // Rendered video rect inside canvas:
      //   canvasAR = canvas.width / canvas.height   (container aspect ratio)
      //   sourceAR = sourceWidth / sourceHeight       (source aspect ratio)
      //
      //   if sourceAR < canvasAR  →  pillarbox (black bars left/right)
      //     renderedH = canvas.height
      //     renderedW = canvas.height * sourceAR
      //     offsetX   = (canvas.width - renderedW) / 2
      //     offsetY   = 0
      //
      //   if sourceAR > canvasAR  →  letterbox (black bars top/bottom)
      //     renderedW = canvas.width
      //     renderedH = canvas.width / sourceAR
      //     offsetX   = 0
      //     offsetY   = (canvas.height - renderedH) / 2
      const canvasAR = canvas.width / canvas.height;
      const sourceAR = sourceWidth / sourceHeight;

      let renderedW: number;
      let renderedH: number;
      let offsetX: number;
      let offsetY: number;

      if (sourceAR < canvasAR) {
        // Pillarbox — black bars on left and right (e.g. portrait 9:16 in 16:9)
        renderedH = canvas.height;
        renderedW = canvas.height * sourceAR;
        offsetX = (canvas.width - renderedW) / 2;
        offsetY = 0;
      } else {
        // Letterbox — black bars on top and bottom (e.g. wide source in 16:9)
        renderedW = canvas.width;
        renderedH = canvas.width / sourceAR;
        offsetX = 0;
        offsetY = (canvas.height - renderedH) / 2;
      }

      const scaleX = renderedW / sourceWidth;
      const scaleY = renderedH / sourceHeight;

      // Helper: map a source-pixel point onto the canvas.
      const mapX = (px: number) => px * scaleX + offsetX;
      const mapY = (py: number) => py * scaleY + offsetY;

      for (const frame of renderFrames) {
        const kps = frame.keypoints;
        if (!kps || kps.length === 0) continue;

        // ── Per-frame colour: near vs far based on bbox_y position ───────
        // Near end = bbox_y >= source_height/2 (landscape), or bbox_x >= source_width/2 (portrait)
        const isPortraitFrame = frame.source_height > frame.source_width;
        const isNear = isPortraitFrame
          ? (frame.bbox_x ?? 0) >= frame.source_width  / 2
          : (frame.bbox_y ?? 0) >= frame.source_height / 2;
        const frameColor = isNear ? nearColor : farColor;
        const frameLabel = isNear ? nearLabel : farLabel;

        // Parse hex to rgba helper
        const hex = frameColor.replace("#", "");
        const fr = parseInt(hex.slice(0,2), 16);
        const fg = parseInt(hex.slice(2,4), 16);
        const fb = parseInt(hex.slice(4,6), 16);
        const rgbStr = `${fr},${fg},${fb}`;

        // ── Bounding box ──────────────────────────────────────────────────
        // bbox_x/y from Ultralytics xywh are the CENTRE (cx, cy).
        // strokeRect expects the top-left corner, so subtract half w/h first.
        if (showBoxes && frame.bbox_x != null && frame.bbox_y != null &&
            frame.bbox_w != null && frame.bbox_h != null) {
          const bw = frame.bbox_w * scaleX;
          const bh = frame.bbox_h * scaleY;
          const bx = mapX(frame.bbox_x) - bw / 2;
          const by = mapY(frame.bbox_y) - bh / 2;

          // Box outline
          ctx.globalAlpha = 0.65;
          ctx.strokeStyle = `rgba(${rgbStr},1)`;
          ctx.lineWidth   = 2;
          ctx.strokeRect(bx, by, bw, bh);
          ctx.globalAlpha = 1;

          // Top-left colour swatch + label
          if (showTrackIds) {
            const swatchW = 8, swatchH = 14, pad = 3;
            const labelText = frameLabel;
            ctx.font = "bold 11px system-ui, sans-serif";
            const textW = ctx.measureText(labelText).width;
            const chipW = swatchW + pad + textW + pad * 2;
            const chipH = swatchH;
            // Chip background
            ctx.fillStyle = "rgba(0,0,0,0.60)";
            ctx.fillRect(bx, by - chipH - 2, chipW, chipH);
            // Colour swatch
            ctx.fillStyle = frameColor;
            ctx.fillRect(bx + 2, by - chipH - 2 + 2, swatchW, chipH - 4);
            // Label
            ctx.fillStyle = "rgba(255,255,255,0.95)";
            ctx.textBaseline = "middle";
            ctx.fillText(labelText, bx + swatchW + pad + 2, by - chipH - 2 + chipH / 2);
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
          ctx.moveTo(mapX(ka[0]), mapY(ka[1]));
          ctx.lineTo(mapX(kb[0]), mapY(kb[1]));
          ctx.strokeStyle = confident
            ? `rgba(${rgbStr},0.90)`
            : `rgba(${rgbStr},0.22)`;
          ctx.lineWidth = confident ? 2.5 : 1;
          ctx.stroke();
        }

        // ── Keypoints ─────────────────────────────────────────────────────
        for (let i = 0; i < kps.length; i++) {
          const kp = kps[i];
          if (!kp) continue;
          const conf = kp[2] ?? 0;
          if (conf < 0.15) continue;
          const x = mapX(kp[0]);
          const y = mapY(kp[1]);
          const r = conf > CONFIDENCE_THRESHOLD ? 4 : 2.5;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = conf > CONFIDENCE_THRESHOLD
            ? `rgba(${rgbStr},1)`
            : `rgba(${rgbStr},0.40)`;
          ctx.fill();
        }
      }
    },
    // Deliberately only depends on primitive/stable values.
    // framesRef and fetchedWindowRef are refs so they don't trigger re-renders.
    // fetchWindow is intentionally excluded — it runs in its own interval,
    // never inside the synchronous rAF draw callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, showBoxes, showTrackIds, sourceWidth, sourceHeight, nearColor, farColor, nearLabel, farLabel]
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

/**
 * SkeletonOverlay — fetches pose data and renders a green skeleton overlay
 * on the video player canvas.
 *
 * Data flow:
 *   1. On mount, fetches all player tracks for the analysis run.
 *   2. Fetches pose frames in a time window around the current playback position.
 *   3. Caches frames in a Map keyed by timestamp_ms for O(1) lookup.
 *   4. The parent VideoPlayer calls renderOverlay(ctx, currentTime) on every
 *      timeupdate, which looks up the nearest frame and draws the skeleton.
 *
 * Coordinate scaling:
 *   Pose keypoints are stored in source video pixels (e.g. 1920×1080).
 *   The canvas is sized to the displayed video element, so we scale:
 *     scaleX = canvas.width / source_width
 *     scaleY = canvas.height / source_height
 *
 * Visual conventions:
 *   - Skeleton lines: green (#00ff00), alpha 0.8 for confident, 0.3 for uncertain.
 *   - Keypoints: green circles, larger for confident, small/dim for uncertain.
 *   - Bounding boxes: faint green outline (alpha 0.3).
 *   - Track IDs: drawn above the bounding box.
 *
 * Performance:
 *   The render function is called on every timeupdate (~4×/sec at normal speed).
 *   It only draws one frame's worth of data — no batch rendering.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PoseFrame, PlayerTrack } from "@/types/api";
import apiClient from "@/lib/api";

// COCO 17-keypoint skeleton connections (0-indexed pairs).
const SKELETON_CONNECTIONS = [
  [0, 1], [0, 2], [1, 3], [2, 4], [1, 2], [3, 4],   // face
  [5, 6], [5, 11], [6, 12], [11, 12],               // torso
  [5, 7], [7, 9], [6, 8], [8, 10],                  // arms
  [11, 13], [13, 15], [12, 14], [14, 16],           // legs
  [0, 5],                                            // head-torso
];

const CONFIDENCE_THRESHOLD = 0.3;

interface SkeletonOverlayProps {
  runId: string;
  /** Whether to show the skeleton overlay. */
  enabled: boolean;
  /** Whether to show bounding boxes. */
  showBoxes: boolean;
  /** Whether to show track IDs. */
  showTrackIds: boolean;
  /** The source video width (for coordinate scaling). */
  sourceWidth: number;
  /** The source video height (for coordinate scaling). */
  sourceHeight: number;
  /** Called to register the overlay renderer with the parent. */
  onRendererReady: (renderer: (ctx: CanvasRenderingContext2D, currentTime: number) => void) => void;
}

export default function SkeletonOverlay({
  runId,
  enabled,
  showBoxes,
  showTrackIds,
  sourceWidth,
  sourceHeight,
  onRendererReady,
}: SkeletonOverlayProps) {
  const [tracks, setTracks] = useState<PlayerTrack[]>([]);
  const [frames, setFrames] = useState<Map<number, PoseFrame[]>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchWindowRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  // Fetch tracks on mount.
  useEffect(() => {
    if (!runId || !enabled) return;
    apiClient
      .getTracks(runId)
      .then(setTracks)
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }, [runId, enabled]);

  // Fetch pose frames in a window around the current time.
  // Called lazily by the renderer when the time moves outside the loaded window.
  const fetchFrames = useCallback(async (centerTimeMs: number) => {
    if (!runId) return;
    const windowMs = 10000; // 10-second window
    const start = Math.max(0, centerTimeMs - windowMs / 2);
    const end = centerTimeMs + windowMs / 2;

    // Skip if we already have this window.
    if (centerTimeMs >= fetchWindowRef.current.start &&
        centerTimeMs <= fetchWindowRef.current.end) {
      return;
    }

    try {
      const result = await apiClient.getPoses(runId, {
        start_ms: start,
        end_ms: end,
        limit: 1000,
      });
      const newMap = new Map<number, PoseFrame[]>();
      for (const f of result.items) {
        const existing = newMap.get(f.timestamp_ms) ?? [];
        existing.push(f);
        newMap.set(f.timestamp_ms, existing);
      }
      setFrames(newMap);
      fetchWindowRef.current = { start, end };
    } catch {
      // Non-fatal — the overlay just won't render for this window.
    }
  }, [runId]);

  // Create and register the renderer.
  const renderer = useCallback((ctx: CanvasRenderingContext2D, currentTime: number) => {
    if (!enabled || !loaded || frames.size === 0) return;

    const currentTimeMs = Math.round(currentTime * 1000);

    // Find the nearest frame (within 100ms tolerance).
    let nearest: PoseFrame[] = [];
    let nearestDiff = Infinity;
    for (const [ts, fs] of frames) {
      const diff = Math.abs(ts - currentTimeMs);
      if (diff < nearestDiff && diff < 200) { // 200ms = ~6 frames at 30fps
        nearestDiff = diff;
        nearest = fs;
      }
    }
    if (nearest.length === 0) return;

    // Trigger async fetch for the next window if we're at the edge.
    fetchFrames(currentTimeMs);

    // Scale from source resolution to canvas size.
    const canvas = ctx.canvas;
    const scaleX = canvas.width / sourceWidth;
    const scaleY = canvas.height / sourceHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const frame of nearest) {
      const kps = frame.keypoints;
      if (!kps || kps.length === 0) continue;

      // Draw bounding box (faint).
      if (showBoxes && frame.bbox_x != null && frame.bbox_y != null &&
          frame.bbox_w != null && frame.bbox_h != null) {
        const x = frame.bbox_x * scaleX;
        const y = frame.bbox_y * scaleY;
        const w = frame.bbox_w * scaleX;
        const h = frame.bbox_h * scaleY;
        const track = tracks.find((t) => t.id === frame.player_track_id);
        const isMe = track?.is_selected_player;
        ctx.strokeStyle = isMe ? "rgba(0, 255, 0, 0.6)" : "rgba(0, 200, 100, 0.3)";
        ctx.lineWidth = isMe ? 2 : 1;
        ctx.strokeRect(x, y, w, h);

        // Track ID label.
        if (showTrackIds && track) {
          ctx.fillStyle = isMe ? "rgba(0, 255, 0, 0.9)" : "rgba(0, 200, 100, 0.6)";
          ctx.font = "14px sans-serif";
          ctx.fillText(
            `${track.track_label}${isMe ? " (Me)" : ""}`,
            x,
            y - 5
          );
        }
      }

      // Draw skeleton connections.
      ctx.strokeStyle = "rgba(0, 255, 0, 0.8)";
      ctx.lineWidth = 2;
      for (const [a, b] of SKELETON_CONNECTIONS) {
        if (a >= kps.length || b >= kps.length) continue;
        const ka = kps[a];
        const kb = kps[b];
        if (!ka || !kb) continue;
        const confA = ka[2] ?? 0;
        const confB = kb[2] ?? 0;
        // Skip connection if either endpoint is low confidence.
        if (confA < CONFIDENCE_THRESHOLD || confB < CONFIDENCE_THRESHOLD) {
          ctx.globalAlpha = 0.2;
        } else {
          ctx.globalAlpha = 0.8;
        }
        ctx.beginPath();
        ctx.moveTo(ka[0] * scaleX, ka[1] * scaleY);
        ctx.lineTo(kb[0] * scaleX, kb[1] * scaleY);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Draw keypoints.
      for (let i = 0; i < kps.length; i++) {
        const kp = kps[i];
        if (!kp) continue;
        const conf = kp[2] ?? 0;
        const x = kp[0] * scaleX;
        const y = kp[1] * scaleY;
        ctx.beginPath();
        ctx.arc(x, y, conf > CONFIDENCE_THRESHOLD ? 4 : 2, 0, Math.PI * 2);
        ctx.fillStyle = conf > CONFIDENCE_THRESHOLD
          ? "rgba(0, 255, 0, 0.9)"
          : "rgba(0, 255, 0, 0.3)";
        ctx.fill();
      }
    }
  }, [enabled, loaded, frames, tracks, showBoxes, showTrackIds, sourceWidth, sourceHeight, fetchFrames]);

  // Register the renderer with the parent whenever it changes.
  useEffect(() => {
    onRendererReady(renderer);
  }, [renderer, onRendererReady]);

  if (error) {
    return null; // Silent — don't block video playback.
  }

  return null; // This component is invisible; it only provides the renderer.
}

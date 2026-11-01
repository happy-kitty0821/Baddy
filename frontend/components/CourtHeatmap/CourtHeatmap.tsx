"use client";

import { useEffect, useRef, useState } from "react";
import type { PoseFrame } from "@/types/api";
import apiClient from "@/lib/api";

// Grid dimensions (landscape court proportions).
const COLS = 40;
const ROWS = 22;
// Pixel size of each grid cell on the canvas.
// COLS * CELL_PX = 40 * 15 = 600px; ROWS * CELL_PX = 22 * 15 = 330px.
const CELL_PX = 15;

interface CourtHeatmapProps {
  runId: string;
  courtSide: "near" | "far" | null;
  sourceWidth: number;
  sourceHeight: number;
  enabled: boolean;
  /** Current video playback time in milliseconds — heatmap shows cumulative
   *  movement up to this timestamp.  Pass 0 to show all frames. */
  currentTimeMs: number;
}

/**
 * Colour scale — 4-stop gradient from transparent-blue → green → yellow → red.
 * t is normalised density [0, 1].
 */
function heatColour(t: number): string {
  const stops: [number, number, number, number, number][] = [
    [0.00,   0,   0, 255, 0.00],
    [0.33,   0, 255, 100, 0.60],
    [0.67, 255, 255,   0, 0.80],
    [1.00, 255,   0,   0, 0.95],
  ];

  let s0 = stops[0];
  let s1 = stops[1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      s0 = stops[i];
      s1 = stops[i + 1];
      break;
    }
  }

  const span = s1[0] - s0[0];
  const f = span === 0 ? 0 : (t - s0[0]) / span;
  const r = Math.round(s0[1] + (s1[1] - s0[1]) * f);
  const g = Math.round(s0[2] + (s1[2] - s0[2]) * f);
  const b = Math.round(s0[3] + (s1[3] - s0[3]) * f);
  const a = s0[4] + (s1[4] - s0[4]) * f;

  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/** Draws the heatmap onto the canvas using only poses up to `upToMs`. */
function drawHeatmap(
  canvas: HTMLCanvasElement,
  frames: PoseFrame[],
  upToMs: number,
  sourceWidth: number,
  sourceHeight: number
) {
  canvas.width = COLS * CELL_PX;
  canvas.height = ROWS * CELL_PX;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(20, 30, 40, 1)";
  ctx.fillRect(0, 0, W, H);

  const isPortrait = sourceHeight > sourceWidth;

  // Filter to frames up to current video time (0 means show all).
  const visible = upToMs > 0 ? frames.filter((f) => f.timestamp_ms <= upToMs) : frames;

  const grid: number[][] = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));

  for (const f of visible) {
    if (f.bbox_x == null || f.bbox_y == null) continue;
    const rawX = f.bbox_x + (f.bbox_w ?? 0) / 2;
    const rawY = f.bbox_y + (f.bbox_h ?? 0) / 2;

    let courtX: number;
    let courtY: number;
    if (isPortrait) {
      courtX = rawY / sourceHeight;
      courtY = rawX / sourceWidth;
    } else {
      courtX = rawX / sourceWidth;
      courtY = rawY / sourceHeight;
    }

    const col = Math.max(0, Math.min(COLS - 1, Math.floor(courtX * COLS)));
    const row = Math.max(0, Math.min(ROWS - 1, Math.floor(courtY * ROWS)));
    grid[row][col]++;
  }

  let maxCount = 0;
  for (const row of grid) for (const val of row) { if (val > maxCount) maxCount = val; }

  if (maxCount === 0) {
    ctx.fillStyle = "rgba(150, 150, 150, 0.7)";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No movement data for this player", W / 2, H / 2);
  } else {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const count = grid[row][col];
        if (count === 0) continue;
        ctx.fillStyle = heatColour(count / maxCount);
        ctx.fillRect(col * CELL_PX, row * CELL_PX, CELL_PX, CELL_PX);
      }
    }
  }

  // Court outline on top.
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 1.5;
  const pad = 4;
  ctx.strokeRect(pad, pad, W - pad * 2, H - pad * 2);

  // Net.
  ctx.beginPath();
  ctx.moveTo(W / 2, pad);
  ctx.lineTo(W / 2, H - pad);
  ctx.stroke();

  // Short service lines.
  const sl1X = W * (1 / 6);
  const sl2X = W * (5 / 6);
  ctx.beginPath(); ctx.moveTo(sl1X, pad); ctx.lineTo(sl1X, H - pad); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(sl2X, pad); ctx.lineTo(sl2X, H - pad); ctx.stroke();
}

export default function CourtHeatmap({
  runId,
  courtSide,
  sourceWidth,
  sourceHeight,
  enabled,
  currentTimeMs,
}: CourtHeatmapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framesRef = useRef<PoseFrame[]>([]);
  const [loading, setLoading] = useState(false);
  // Ref version of currentTimeMs so the rAF loop always sees the latest value
  // without needing to restart the loop on every video tick.
  const currentTimeMsRef = useRef(currentTimeMs);
  // Track the last upToMs we drew so we skip identical frames.
  const lastDrawnMsRef = useRef(-1);
  // Ref to hold the rAF handle for cleanup.
  const rafRef = useRef<number | null>(null);
  // Track when data is ready so the rAF loop knows when to start drawing.
  const dataReadyRef = useRef(false);

  // Keep the ref in sync with the prop on every render.
  currentTimeMsRef.current = currentTimeMs;

  // Fetch all pose frames (paginated) whenever runId/courtSide/enabled changes.
  useEffect(() => {
    if (!enabled || !runId) return;

    let cancelled = false;
    dataReadyRef.current = false;
    lastDrawnMsRef.current = -1;
    framesRef.current = [];

    async function fetchAll() {
      setLoading(true);
      const allFrames: PoseFrame[] = [];
      let offset = 0;
      const limit = 1000;

      try {
        while (true) {
          const result = await apiClient.getPoses(runId, {
            ...(courtSide ? { court_side: courtSide } : {}),
            limit,
            offset,
          });
          if (cancelled) return;
          allFrames.push(...result.items);
          if (!result.has_more) break;
          offset += limit;
        }
      } catch {
        // Non-fatal.
      }

      if (!cancelled) {
        framesRef.current = allFrames;
        dataReadyRef.current = true;
        lastDrawnMsRef.current = -1; // Force a redraw.
        setLoading(false);
      }
    }

    fetchAll();
    return () => { cancelled = true; };
  }, [runId, courtSide, enabled]);

  // rAF loop — redraws the canvas at up to 60fps, but only when the time
  // has actually changed.  Pure synchronous canvas operations, no async.
  useEffect(() => {
    if (!enabled) return;

    function loop() {
      rafRef.current = requestAnimationFrame(loop);
      if (!dataReadyRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const upToMs = currentTimeMsRef.current;
      // Skip if time hasn't changed since last draw.
      if (upToMs === lastDrawnMsRef.current) return;
      lastDrawnMsRef.current = upToMs;

      drawHeatmap(canvas, framesRef.current, upToMs, sourceWidth, sourceHeight);
    }

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [enabled, sourceWidth, sourceHeight]);

  return (
    <div className="relative w-full rounded-lg overflow-hidden bg-gray-900 border border-gray-700">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-gray-900/80">
          <svg
            className="animate-spin h-8 w-8 text-green-500"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-label="Loading heatmap"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="ml-2 text-xs text-gray-400">Building heatmap…</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="w-full h-full rounded"
        style={{ display: "block" }}
      />
    </div>
  );
}

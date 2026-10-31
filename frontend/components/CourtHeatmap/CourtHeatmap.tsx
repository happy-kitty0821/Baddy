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
}

/**
 * Colour scale — 4-stop gradient from transparent-blue → green → yellow → red.
 * t is normalised density [0, 1].
 */
function heatColour(t: number): string {
  // Stops: [t, r, g, b, a]
  const stops: [number, number, number, number, number][] = [
    [0.00,   0,   0, 255, 0.00],
    [0.33,   0, 255, 100, 0.60],
    [0.67, 255, 255,   0, 0.80],
    [1.00, 255,   0,   0, 0.95],
  ];

  // Find the two stops that bracket t.
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

export default function CourtHeatmap({
  runId,
  courtSide,
  sourceWidth,
  sourceHeight,
  enabled,
}: CourtHeatmapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framesRef = useRef<PoseFrame[]>([]);
  const [loading, setLoading] = useState(false);
  // Incremented each time framesRef.current is committed, so the draw effect
  // re-fires even if `loading` doesn't change (e.g. incremental updates later).
  const [drawVersion, setDrawVersion] = useState(0);

  // Set canvas pixel dimensions once on mount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = COLS * CELL_PX;
    canvas.height = ROWS * CELL_PX;
  }, []);

  // Fetch all pose frames (paginated) whenever runId/courtSide/enabled changes.
  useEffect(() => {
    if (!enabled || !runId) return;

    let cancelled = false;

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
        // Non-fatal — render with whatever we have.
      }

      if (!cancelled) {
        framesRef.current = allFrames;
        setDrawVersion((v) => v + 1);
        setLoading(false);
      }
    }

    fetchAll();

    return () => {
      cancelled = true;
    };
  }, [runId, courtSide, enabled]);

  // Redraw canvas whenever frame data changes (drawVersion increments alongside
  // framesRef.current writes) or loading finishes, or dimensions change.
  useEffect(() => {
    if (loading) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const frames = framesRef.current;
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    // Portrait detection: swap axes so the court always renders landscape.
    const isPortrait = sourceHeight > sourceWidth;

    // Build visit-count grid.
    const grid: number[][] = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));

    for (const f of frames) {
      if (f.bbox_x == null || f.bbox_y == null) continue;
      const rawX = f.bbox_x + (f.bbox_w ?? 0) / 2;
      const rawY = f.bbox_y + (f.bbox_h ?? 0) / 2;

      let courtX: number;
      let courtY: number;
      if (isPortrait) {
        // Rotate 90°: video x-axis maps to court y, video y-axis maps to court x.
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

    // Max-normalise.
    let maxCount = 0;
    for (const row of grid) {
      for (const val of row) {
        if (val > maxCount) maxCount = val;
      }
    }

    // --- Draw heatmap cells first ---
    if (maxCount > 0) {
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const count = grid[row][col];
          if (count === 0) continue;
          const density = count / maxCount;
          ctx.fillStyle = heatColour(density);
          ctx.fillRect(col * CELL_PX, row * CELL_PX, CELL_PX, CELL_PX);
        }
      }
    }

    // --- Draw court outline on top ---
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1.5;

    const pad = 4;

    // Outer boundary.
    ctx.strokeRect(pad, pad, W - pad * 2, H - pad * 2);

    // Net — vertical line at horizontal midpoint.
    ctx.beginPath();
    ctx.moveTo(W / 2, pad);
    ctx.lineTo(W / 2, H - pad);
    ctx.stroke();

    // Short service lines at ~1/6 and 5/6 of court length — vertical, parallel to the net.
    const sl1X = W * (1 / 6);
    const sl2X = W * (5 / 6);

    ctx.beginPath();
    ctx.moveTo(sl1X, pad);
    ctx.lineTo(sl1X, H - pad);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(sl2X, pad);
    ctx.lineTo(sl2X, H - pad);
    ctx.stroke();
  }, [loading, drawVersion, sourceWidth, sourceHeight]);

  return (
    <div className="relative w-full" style={{ aspectRatio: `${COLS}/${ROWS}` }}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <svg
            className="animate-spin h-8 w-8 text-green-500"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-label="Loading heatmap"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={loading ? "hidden" : "w-full h-full rounded"}
      />
    </div>
  );
}

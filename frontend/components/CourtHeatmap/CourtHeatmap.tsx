"use client";

import { useEffect, useRef, useState } from "react";
import type { PoseFrame } from "@/types/api";
import apiClient from "@/lib/api";

// ── Canvas dimensions ────────────────────────────────────────────────────────
const CANVAS_W = 600;
const CANVAS_H = 330;

// Heat grid resolution.
const COLS = 40;
const ROWS = 22;

interface CourtHeatmapProps {
  runId: string;
  courtSide: "near" | "far" | null;
  sourceWidth: number;
  sourceHeight: number;
  enabled: boolean;
  /** Current video playback time in ms.  Pass 0 to show all frames. */
  currentTimeMs: number;
}

// ── Colour scale: transparent → blue → green → yellow → red ─────────────────
function heatColour(t: number): string {
  const stops: [number, number, number, number, number][] = [
    [0.00,   0,   0, 255, 0.00],
    [0.33,   0, 255, 100, 0.60],
    [0.67, 255, 255,   0, 0.80],
    [1.00, 255,   0,   0, 0.95],
  ];
  let s0 = stops[0], s1 = stops[1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { s0 = stops[i]; s1 = stops[i + 1]; break; }
  }
  const span = s1[0] - s0[0];
  const f = span === 0 ? 0 : (t - s0[0]) / span;
  const r = Math.round(s0[1] + (s1[1] - s0[1]) * f);
  const g = Math.round(s0[2] + (s1[2] - s0[2]) * f);
  const b = Math.round(s0[3] + (s1[3] - s0[3]) * f);
  const a = (s0[4] + (s1[4] - s0[4]) * f).toFixed(3);
  return `rgba(${r},${g},${b},${a})`;
}

// ── Badminton court lines ────────────────────────────────────────────────────
//
// Court rendered LANDSCAPE: long axis = horizontal (width), short = vertical (height).
// Real BWF doubles court: 13.4 m (length) × 6.1 m (width).
//
// All fractions are of the FULL court length (13.4 m) or width (6.1 m):
//
//  HORIZONTAL (x) positions — fractions of 13.4 m:
//    Back boundary (left) :  0
//    Back service line (L):  0.76 / 13.4 = 0.0567  (doubles long-service inset)
//    Short service line (L): 1.98 / 6.7  = 0.2955 of each half
//                             → full-court fraction = (0.5 - 0.2955) = 0.2045
//    Net                  :  0.5
//    Short service line (R): 0.5 + 0.2955 = 0.7045  — mirror
//    Back service line (R):  1 - 0.0567  = 0.9433
//    Back boundary (right):  1
//
//  VERTICAL (y) positions — fractions of 6.1 m:
//    Doubles sideline (top)  : 0
//    Singles sideline (top)  : 0.46 / 6.1 = 0.0754
//    Centre service line     : 0.5
//    Singles sideline (bot)  : 1 - 0.0754 = 0.9246
//    Doubles sideline (bot)  : 1
//
//  Centre service line runs horizontally at y=0.5, but only between the
//  short service lines of each half: x=[bsl, ssl_L] and x=[ssl_R, bsl_R].
//
function drawCourtLines(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const PAD = 10;
  const cW = W - PAD * 2;
  const cH = H - PAD * 2;

  const px = (f: number) => PAD + f * cW;
  const py = (f: number) => PAD + f * cH;

  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  ctx.save();

  // ── court surface fill (inside boundary)
  ctx.fillStyle = "rgba(20, 100, 45, 0.85)";
  ctx.fillRect(px(0), py(0), cW, cH);

  // ── standard line style
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 1.5;

  // Outer boundary
  ctx.strokeRect(px(0), py(0), cW, cH);

  // Singles sidelines  (y = 0.0754 and 0.9246)
  const si = 0.0754;
  line(px(0), py(si),      px(1), py(si));
  line(px(0), py(1 - si),  px(1), py(1 - si));

  // Back service lines for doubles (x = 0.0567 from each end)
  //   Run only between singles sidelines.
  const bsl = 0.0567;
  line(px(bsl),      py(si), px(bsl),      py(1 - si));
  line(px(1 - bsl),  py(si), px(1 - bsl),  py(1 - si));

  // Short service lines (1.98 m from net = 0.2955 of each half-court)
  //   As a fraction of the full court: 0.5 - 0.2955 = 0.2045  and  0.7955
  //   These run the full width (doubles sideline to sideline).
  const ssl = 0.2045;
  line(px(ssl),      py(0), px(ssl),      py(1));
  line(px(1 - ssl),  py(0), px(1 - ssl),  py(1));

  // Net — full height, thicker, fully white
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "rgba(255, 255, 255, 1)";
  line(px(0.5), py(0), px(0.5), py(1));

  // Reset
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";

  // Centre service lines (y = 0.5), between short service line and back service line
  //   Left half:  x in [bsl, ssl]
  //   Right half: x in [1-ssl, 1-bsl]
  const midY = 0.5;
  line(px(bsl),      py(midY), px(ssl),      py(midY));
  line(px(1 - ssl),  py(midY), px(1 - bsl),  py(midY));

  ctx.restore();
}

// ── Main draw ────────────────────────────────────────────────────────────────
function drawHeatmap(
  canvas: HTMLCanvasElement,
  frames: PoseFrame[],
  upToMs: number,
  sourceWidth: number,
  sourceHeight: number,
) {
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Background outside the court.
  ctx.fillStyle = "#0d1f12";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const isPortrait = sourceHeight > sourceWidth;

  // Filter frames to current video time (0 = show everything).
  const visible = upToMs > 0
    ? frames.filter((f) => f.timestamp_ms <= upToMs)
    : frames;

  // ── Build hit-count grid ─────────────────────────────────────────────────
  // IMPORTANT: bbox_x / bbox_y from Ultralytics xywh format are the CENTRE
  // of the bounding box, not the top-left corner.  Use them directly as the
  // player's position — do NOT add half the width/height again.
  const grid: number[][] = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));

  for (const f of visible) {
    if (f.bbox_x == null || f.bbox_y == null) continue;

    // bbox_x, bbox_y are already the centre point (Ultralytics xywh centre).
    const cx = f.bbox_x;
    const cy = f.bbox_y;

    // Map source-pixel centre → [0, 1] normalised court coordinates.
    // Portrait video: the long axis of the court runs along the video Y axis.
    let courtX: number, courtY: number;
    if (isPortrait) {
      // Portrait: video Y → court long axis (horizontal), video X → court short axis (vertical).
      courtX = cy / sourceHeight;
      courtY = cx / sourceWidth;
    } else {
      // Landscape: straight mapping.
      courtX = cx / sourceWidth;
      courtY = cy / sourceHeight;
    }

    // Clamp to grid.
    const col = Math.max(0, Math.min(COLS - 1, Math.floor(courtX * COLS)));
    const row = Math.max(0, Math.min(ROWS - 1, Math.floor(courtY * ROWS)));
    grid[row][col]++;
  }

  let maxCount = 0;
  for (const row of grid) for (const v of row) { if (v > maxCount) maxCount = v; }

  // Draw heat cells (under court lines).
  if (maxCount > 0) {
    const cellW = CANVAS_W / COLS;
    const cellH = CANVAS_H / ROWS;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const count = grid[row][col];
        if (count === 0) continue;
        ctx.fillStyle = heatColour(count / maxCount);
        ctx.fillRect(col * cellW, row * cellH, cellW, cellH);
      }
    }
  }

  // Court lines drawn on top of heat.
  drawCourtLines(ctx, CANVAS_W, CANVAS_H);

  // No-data overlay.
  if (maxCount === 0) {
    ctx.fillStyle = "rgba(200, 200, 200, 0.55)";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Play the video — heatmap builds as it runs", CANVAS_W / 2, CANVAS_H / 2);
  }
}

// ── Component ────────────────────────────────────────────────────────────────
export default function CourtHeatmap({
  runId,
  courtSide,
  sourceWidth,
  sourceHeight,
  enabled,
  currentTimeMs,
}: CourtHeatmapProps) {
  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const framesRef        = useRef<PoseFrame[]>([]);
  const [loading, setLoading] = useState(false);

  const currentTimeMsRef = useRef(currentTimeMs);
  const lastDrawnMsRef   = useRef(-1);
  const rafRef           = useRef<number | null>(null);
  const dataReadyRef     = useRef(false);

  // Keep ref in sync on every render (no re-render needed, just ref update).
  currentTimeMsRef.current = currentTimeMs;

  // ── Fetch all pose frames ─────────────────────────────────────────────────
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    dataReadyRef.current   = false;
    lastDrawnMsRef.current = -1;
    framesRef.current      = [];

    async function fetchAll() {
      setLoading(true);
      const all: PoseFrame[] = [];
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
          all.push(...result.items);
          if (!result.has_more) break;
          offset += limit;
        }
      } catch { /* non-fatal */ }

      if (!cancelled) {
        framesRef.current      = all;
        dataReadyRef.current   = true;
        lastDrawnMsRef.current = -1;
        setLoading(false);
      }
    }

    fetchAll();
    return () => { cancelled = true; };
  }, [runId, courtSide, enabled]);

  // ── rAF draw loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    function loop() {
      rafRef.current = requestAnimationFrame(loop);
      if (!dataReadyRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const upToMs = currentTimeMsRef.current;
      if (upToMs === lastDrawnMsRef.current) return;
      lastDrawnMsRef.current = upToMs;
      drawHeatmap(canvas, framesRef.current, upToMs, sourceWidth, sourceHeight);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [sourceWidth, sourceHeight]);

  return (
    <div className="relative w-full rounded-lg overflow-hidden bg-[#0d1f12]">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-black/60 rounded-lg">
          <svg className="animate-spin h-6 w-6 text-green-400" xmlns="http://www.w3.org/2000/svg"
            fill="none" viewBox="0 0 24 24" aria-label="Loading heatmap">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="ml-2 text-xs text-gray-400">Loading poses…</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="w-full h-auto rounded-lg"
        style={{ display: "block", aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
      />
    </div>
  );
}

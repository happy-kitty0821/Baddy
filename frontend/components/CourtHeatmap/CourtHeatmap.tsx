"use client";

import { useEffect, useRef, useState } from "react";
import type { PoseFrame } from "@/types/api";
import apiClient from "@/lib/api";

// ── Canvas size ───────────────────────────────────────────────────────────────
// BWF court aspect ratio: 13.4 m × 6.1 m = 2.197:1
// We render slightly wider to leave padding for the court margin lines.
const CANVAS_W = 660;
const CANVAS_H = 340;

// Heat grid resolution — more columns than rows, matching court proportions.
const COLS = 44;
const ROWS = 20;

interface CourtHeatmapProps {
  runId: string;
  courtSide: "near" | "far" | null;
  sourceWidth: number;
  sourceHeight: number;
  enabled: boolean;
  /** Current video time in ms — heatmap shows cumulative movement up to here.
   *  Pass 0 to show all frames (end-of-match summary). */
  currentTimeMs: number;
}

// ── Colour scale: transparent-blue → cyan → yellow → red ─────────────────────
function heatColour(t: number): string {
  // 4 stops: [position, r, g, b, alpha]
  const stops: [number, number, number, number, number][] = [
    [0.00,   0,  60, 255, 0.00],
    [0.25,   0, 200, 255, 0.55],
    [0.55,   0, 255, 100, 0.75],
    [0.80, 255, 220,   0, 0.88],
    [1.00, 255,  30,   0, 0.96],
  ];
  // Find bracketing stops
  let s0 = stops[0], s1 = stops[1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      s0 = stops[i];
      s1 = stops[i + 1];
      break;
    }
  }
  const span = s1[0] - s0[0];
  const f = span === 0 ? 0 : (t - s0[0]) / span;
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * f);
  return `rgba(${lerp(s0[1], s1[1])},${lerp(s0[2], s1[2])},${lerp(s0[3], s1[3])},${(s0[4] + (s1[4] - s0[4]) * f).toFixed(3)})`;
}

// ── Gaussian blur kernel (3×3, sigma≈0.8) ────────────────────────────────────
// Smooths the grid so single-cell spikes look like natural density clouds.
function blurGrid(grid: number[][], rows: number, cols: number): number[][] {
  const k = [
    [0.0625, 0.125, 0.0625],
    [0.125,  0.25,  0.125],
    [0.0625, 0.125, 0.0625],
  ];
  const out: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            sum += grid[nr][nc] * k[dr + 1][dc + 1];
          } else {
            sum += grid[r][c] * k[dr + 1][dc + 1]; // mirror pad
          }
        }
      }
      out[r][c] = sum;
    }
  }
  return out;
}

// ── Auto-calibration: find data percentile bounds ────────────────────────────
// Returns [xMin, xMax, yMin, yMax] in normalised [0..1] source coordinates.
// Using p3/p97 trims outliers without needing hard-coded constants.
function computeBounds(
  frames: PoseFrame[],
  isPortrait: boolean,
  sourceWidth: number,
  sourceHeight: number,
): [number, number, number, number] {
  if (frames.length === 0) return [0, 1, 0, 1];

  const nxs: number[] = [];
  const nys: number[] = [];

  for (const f of frames) {
    if (f.bbox_x == null || f.bbox_y == null) continue;
    // For portrait: court long-axis = video Y, short-axis = video X
    const nx = isPortrait ? f.bbox_y / sourceHeight : f.bbox_x / sourceWidth;
    const ny = isPortrait ? f.bbox_x / sourceWidth  : f.bbox_y / sourceHeight;
    nxs.push(nx);
    nys.push(ny);
  }

  if (nxs.length === 0) return [0, 1, 0, 1];

  nxs.sort((a, b) => a - b);
  nys.sort((a, b) => a - b);

  const p = (arr: number[], pct: number) =>
    arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * pct)))];

  // 3%/97% trims out-of-court false positives without over-squeezing.
  const xMin = p(nxs, 0.03);
  const xMax = p(nxs, 0.97);
  const yMin = p(nys, 0.03);
  const yMax = p(nys, 0.97);

  // Ensure minimum span to avoid division-by-zero on degenerate data.
  return [
    xMin,
    xMax > xMin + 0.05 ? xMax : xMin + 0.05,
    yMin,
    yMax > yMin + 0.05 ? yMax : yMin + 0.05,
  ];
}

// ── Badminton court line drawing ──────────────────────────────────────────────
//
// Rendered landscape (long axis = horizontal).
// BWF court: 13.4 m long × 6.1 m wide.
//
// All fractions of full-court length (13.4 m) or width (6.1 m):
//
//   Outer boundary  : x=0, x=1, y=0, y=1
//   Back service    : x=0.0567 from each end  (0.76 m / 13.4 m)
//   Short service   : x=0.2045 from each end  (1.98 m / 6.7 m × 0.5)
//                     i.e. at x=0.2045 and x=0.7955
//   Net             : x=0.5
//   Singles sides   : y=0.0754 and y=0.9246   (0.46 m / 6.1 m inset)
//   Centre line     : y=0.5, from short-service to back-service on each half
//
function drawCourtLines(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const PAD_X = 24;   // px from canvas edge to doubles sideline (left/right)
  const PAD_Y = 18;   // px from canvas edge to back boundary (top/bottom)

  const cW = W - PAD_X * 2;  // court width in canvas px  (long axis)
  const cH = H - PAD_Y * 2;  // court height in canvas px (short axis)

  // Map fractional court coords → canvas px
  const cx = (f: number) => PAD_X + f * cW;
  const cy = (f: number) => PAD_Y + f * cH;

  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  ctx.save();

  // ── 1. Court surface fill ─────────────────────────────────────────────────
  ctx.fillStyle = "#1a5c30";   // dark green surface
  ctx.fillRect(cx(0), cy(0), cW, cH);

  // ── 2. White lines ────────────────────────────────────────────────────────
  ctx.strokeStyle = "rgba(255, 255, 255, 0.90)";
  ctx.lineWidth = 1.5;

  // Outer boundary
  ctx.strokeRect(cx(0), cy(0), cW, cH);

  // Singles sidelines (y = 0.0754 and 0.9246)
  const si = 0.0754;
  line(cx(0), cy(si),       cx(1), cy(si));
  line(cx(0), cy(1 - si),   cx(1), cy(1 - si));

  // Back service lines (x = 0.0567 from each end)
  // Run only between singles sidelines
  const bsl = 0.0567;
  line(cx(bsl),      cy(si), cx(bsl),      cy(1 - si));
  line(cx(1 - bsl),  cy(si), cx(1 - bsl),  cy(1 - si));

  // Short service lines (x = 0.2045 from each end)
  // Run full court width
  const ssl = 0.2045;
  line(cx(ssl),      cy(0), cx(ssl),      cy(1));
  line(cx(1 - ssl),  cy(0), cx(1 - ssl),  cy(1));

  // Centre service lines (y = 0.5) from back-service to short-service on each half
  const midY = 0.5;
  line(cx(bsl),      cy(midY), cx(ssl),      cy(midY));
  line(cx(1 - ssl),  cy(midY), cx(1 - bsl),  cy(midY));

  // ── 3. Net — thicker, brighter ────────────────────────────────────────────
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255, 255, 255, 1)";
  line(cx(0.5), cy(0), cx(0.5), cy(1));

  // Net post markers
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fillRect(cx(0.5) - 2, cy(0) - 4, 4, 8);
  ctx.fillRect(cx(0.5) - 2, cy(1) - 4, 4, 8);

  ctx.restore();
}

// ── Main draw ─────────────────────────────────────────────────────────────────
function drawHeatmap(
  canvas: HTMLCanvasElement,
  frames: PoseFrame[],
  upToMs: number,
  sourceWidth: number,
  sourceHeight: number,
  boundsRef: { current: [number, number, number, number] | null },
) {
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Dark surround (outside court)
  ctx.fillStyle = "#0c1a10";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const isPortrait = sourceHeight > sourceWidth;

  // Filter to current video time
  const visible = upToMs > 0
    ? frames.filter((f) => f.timestamp_ms <= upToMs)
    : frames;

  // ── Calibrate bounds once from the full frame set ────────────────────────
  // Use the full frames array (not just visible) so bounds are stable as
  // the video plays — they don't jump around as new data appears.
  if (!boundsRef.current && frames.length > 50) {
    boundsRef.current = computeBounds(frames, isPortrait, sourceWidth, sourceHeight);
  }
  const bounds = boundsRef.current ?? [0, 1, 0, 1];
  const [xMin, xMax, yMin, yMax] = bounds;
  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;

  // ── Build hit-count grid ─────────────────────────────────────────────────
  // bbox_x / bbox_y from Ultralytics xywh are already the CENTRE (cx, cy).
  const grid: number[][] = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));

  for (const f of visible) {
    if (f.bbox_x == null || f.bbox_y == null) continue;

    // Normalise to [0, 1] in source frame
    const rawNx = isPortrait ? f.bbox_y / sourceHeight : f.bbox_x / sourceWidth;
    const rawNy = isPortrait ? f.bbox_x / sourceWidth  : f.bbox_y / sourceHeight;

    // Re-map using calibrated bounds so the court fills the canvas
    const courtX = (rawNx - xMin) / xSpan;
    const courtY = (rawNy - yMin) / ySpan;

    // Skip out-of-calibrated-range points (beyond p3/p97)
    if (courtX < -0.05 || courtX > 1.05 || courtY < -0.05 || courtY > 1.05) continue;

    const col = Math.max(0, Math.min(COLS - 1, Math.floor(courtX * COLS)));
    const row = Math.max(0, Math.min(ROWS - 1, Math.floor(courtY * ROWS)));
    grid[row][col]++;
  }

  // ── Gaussian smooth ──────────────────────────────────────────────────────
  const smoothed = blurGrid(grid, ROWS, COLS);

  let maxCount = 0;
  for (const row of smoothed) for (const v of row) { if (v > maxCount) maxCount = v; }

  // ── Draw court surface + lines (drawn before heat so heat overlays them) ─
  drawCourtLines(ctx, CANVAS_W, CANVAS_H);

  // ── Draw heat cells ──────────────────────────────────────────────────────
  if (maxCount > 0) {
    // Map grid cells to the court drawing area (inside PAD_X, PAD_Y)
    const PAD_X = 24, PAD_Y = 18;
    const courtW = CANVAS_W - PAD_X * 2;
    const courtH = CANVAS_H - PAD_Y * 2;
    const cellW = courtW / COLS;
    const cellH = courtH / ROWS;

    // Use a subtle power curve so low-density areas still show some colour
    const gamma = 0.55;

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const count = smoothed[row][col];
        if (count < 0.001) continue;
        const t = Math.pow(count / maxCount, gamma);
        ctx.fillStyle = heatColour(t);
        ctx.fillRect(
          PAD_X + col * cellW,
          PAD_Y + row * cellH,
          Math.ceil(cellW),
          Math.ceil(cellH),
        );
      }
    }
  }

  // ── Re-draw court lines on TOP of heat ───────────────────────────────────
  // Court surface fill was already drawn; re-draw only the lines so they
  // remain visible through the heat overlay.
  {
    const PAD_X = 24, PAD_Y = 18;
    const cW = CANVAS_W - PAD_X * 2;
    const cH = CANVAS_H - PAD_Y * 2;
    const cx = (f: number) => PAD_X + f * cW;
    const cy = (f: number) => PAD_Y + f * cH;
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };

    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.80)";
    ctx.lineWidth = 1.5;
    const si = 0.0754, bsl = 0.0567, ssl = 0.2045, midY = 0.5;
    ctx.strokeRect(cx(0), cy(0), cW, cH);
    line(cx(0), cy(si), cx(1), cy(si));
    line(cx(0), cy(1 - si), cx(1), cy(1 - si));
    line(cx(bsl), cy(si), cx(bsl), cy(1 - si));
    line(cx(1 - bsl), cy(si), cx(1 - bsl), cy(1 - si));
    line(cx(ssl), cy(0), cx(ssl), cy(1));
    line(cx(1 - ssl), cy(0), cx(1 - ssl), cy(1));
    line(cx(bsl), cy(midY), cx(ssl), cy(midY));
    line(cx(1 - ssl), cy(midY), cx(1 - bsl), cy(midY));
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255, 255, 255, 1)";
    line(cx(0.5), cy(0), cx(0.5), cy(1));
    ctx.restore();
  }

  // ── No-data overlay ───────────────────────────────────────────────────────
  if (maxCount === 0) {
    ctx.fillStyle = "rgba(200, 200, 200, 0.55)";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Play the video — heatmap builds as it runs", CANVAS_W / 2, CANVAS_H / 2);
  }

  // ── Colour scale legend ───────────────────────────────────────────────────
  if (maxCount > 0) {
    const lx = CANVAS_W - 16;
    const ly1 = 30;
    const ly2 = CANVAS_H - 30;
    const lh = ly2 - ly1;
    const lw = 8;
    const grad = ctx.createLinearGradient(lx, ly2, lx, ly1);
    grad.addColorStop(0,    heatColour(0.05));
    grad.addColorStop(0.4,  heatColour(0.40));
    grad.addColorStop(0.75, heatColour(0.75));
    grad.addColorStop(1,    heatColour(1.00));
    ctx.fillStyle = grad;
    ctx.fillRect(lx - lw, ly1, lw, lh);
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(lx - lw, ly1, lw, lh);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "9px system-ui";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText("High", lx - lw - 3, ly1);
    ctx.fillText("Low",  lx - lw - 3, ly2);
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function CourtHeatmap({
  runId,
  courtSide,
  sourceWidth,
  sourceHeight,
  enabled,
  currentTimeMs,
}: CourtHeatmapProps) {
  const canvasRef         = useRef<HTMLCanvasElement>(null);
  const framesRef         = useRef<PoseFrame[]>([]);
  const [loading, setLoading] = useState(false);

  // Calibrated bounds computed once from the full data set and reused.
  const boundsRef         = useRef<[number, number, number, number] | null>(null);

  const currentTimeMsRef  = useRef(currentTimeMs);
  const lastDrawnMsRef    = useRef(-1);
  const rafRef            = useRef<number | null>(null);
  const dataReadyRef      = useRef(false);

  currentTimeMsRef.current = currentTimeMs;

  // ── Fetch ALL pose frames ──────────────────────────────────────────────────
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    dataReadyRef.current   = false;
    lastDrawnMsRef.current = -1;
    boundsRef.current      = null;   // recalibrate on new data
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

  // ── rAF draw loop — 60 fps, redraws only when time changes ───────────────
  useEffect(() => {
    function loop() {
      rafRef.current = requestAnimationFrame(loop);
      if (!dataReadyRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const upToMs = currentTimeMsRef.current;
      if (upToMs === lastDrawnMsRef.current) return;
      lastDrawnMsRef.current = upToMs;
      drawHeatmap(
        canvas, framesRef.current, upToMs,
        sourceWidth, sourceHeight, boundsRef,
      );
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [sourceWidth, sourceHeight]);

  return (
    <div className="relative w-full rounded-lg overflow-hidden bg-[#0c1a10]">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-black/60 rounded-lg">
          <svg className="animate-spin h-6 w-6 text-green-400"
            xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
            aria-label="Loading heatmap">
            <circle className="opacity-25" cx="12" cy="12" r="10"
              stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
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

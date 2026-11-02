"use client";

import { useEffect, useRef, useState } from "react";
import type { PoseFrame } from "@/types/api";
import apiClient from "@/lib/api";

// ── Canvas ────────────────────────────────────────────────────────────────────
const CANVAS_W = 680;
const CANVAS_H = 360;

// Court surface rect inside the canvas (px). Generous padding on all sides.
const COURT = { x: 40, y: 28, w: CANVAS_W - 80, h: CANVAS_H - 56 };

// Heat grid resolution — cols:rows mirrors court aspect ratio ~2.2:1
const COLS = 44;
const ROWS = 20;

// ── BWF line fractions ────────────────────────────────────────────────────────
// All fractions are of the FULL court length (13.4 m) or width (6.1 m).
// Canvas is LANDSCAPE: horizontal = long axis, vertical = short axis.
//
//  HORIZONTAL fractions (along court long axis):
//    Back boundary         x = 0   and  1
//    Back service line     x = 0.76/13.4  = 0.0567  (from each end)
//    Short service line    x = (6.7−1.98)/13.4 = 0.3522  (from each end)
//                          → placed at 0.3522 from left  &  0.6478 from left
//    Net                   x = 0.5
//
//  VERTICAL fractions (along court short axis):
//    Doubles sideline      y = 0   and  1
//    Singles sideline      y = 0.46/6.1 = 0.0754  (from each edge)
//    Centre service line   y = 0.5
//
const SI  = 0.0754;   // singles sideline inset
const BSL = 0.0567;   // back service line from each end
const SSL = 0.3522;   // short service line from each end
//    short service line is at x = SSL        (left half → near net)
//                       and at x = 1 - SSL   (right half → near net)

// ── Camera-to-court mapping constants ────────────────────────────────────────
// From end-on landscape camera, the players occupy these normalised Y ranges:
//   Near player (camera-side): Y ≈ 0.48 – 0.97  (high in frame = their baseline)
//   Far  player (far side):    Y ≈ 0.03 – 0.52  (low in frame  = their baseline)
// These were measured from real data; they set the depth calibration.
const NEAR_Y_NET      = 0.48;   // frame Y when near player is at net
const NEAR_Y_BASELINE = 0.97;   // frame Y when near player is at baseline
const FAR_Y_BASELINE  = 0.03;   // frame Y when far  player is at baseline
const FAR_Y_NET       = 0.52;   // frame Y when far  player is at net

interface CourtHeatmapProps {
  runId: string;
  courtSide: "near" | "far" | null;
  sourceWidth: number;
  sourceHeight: number;
  enabled: boolean;
  currentTimeMs: number;
  playerLabel?: string;
  /** Colour of the live position dot and label chip only. Not the heat. */
  playerColor?: string;
}

// ── Fixed thermal heat colour (blue → cyan → green → yellow → red) ───────────
// t = 0 (cool) → 1 (hot).  This scale is used regardless of playerColor.
function thermalColour(t: number): string {
  type Stop = [number, number, number, number, number]; // pos r g b a
  const stops: Stop[] = [
    [0.00,   0,   0, 200, 0.00],
    [0.20,   0, 160, 255, 0.45],
    [0.45,   0, 240, 120, 0.68],
    [0.70, 255, 220,   0, 0.85],
    [1.00, 255,  30,   0, 0.97],
  ];
  let s0 = stops[0], s1 = stops[1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { s0 = stops[i]; s1 = stops[i + 1]; break; }
  }
  const span = s1[0] - s0[0];
  const f = span === 0 ? 0 : (t - s0[0]) / span;
  const lr = (a: number, b: number) => Math.round(a + (b - a) * f);
  return `rgba(${lr(s0[1],s1[1])},${lr(s0[2],s1[2])},${lr(s0[3],s1[3])},${(s0[4]+(s1[4]-s0[4])*f).toFixed(3)})`;
}

// ── 3×3 Gaussian blur ─────────────────────────────────────────────────────────
function blurGrid(g: number[][], R: number, C: number): number[][] {
  const k = [[0.0625,0.125,0.0625],[0.125,0.25,0.125],[0.0625,0.125,0.0625]];
  const o: number[][] = Array.from({length:R}, () => new Array(C).fill(0));
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      let s = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        s += g[Math.max(0,Math.min(R-1,r+dr))][Math.max(0,Math.min(C-1,c+dc))] * k[dr+1][dc+1];
      }
      o[r][c] = s;
    }
  }
  return o;
}

// ── Coordinate mapping ────────────────────────────────────────────────────────
// Maps bbox centre (source pixels) → (courtX, courtY) in [0,1] canvas space.
//
// Canvas axes:
//   courtX = 0 → far baseline (left edge)
//   courtX = 1 → near baseline (right edge)
//   courtY = 0 → top doubles sideline
//   courtY = 1 → bottom doubles sideline
//
// Camera geometry (end-on landscape):
//   Video X = player's position along the baseline → court SHORT axis → canvas Y
//   Video Y = player's distance from camera        → court LONG  axis → canvas X
//
function mapToCourtXY(
  bboxX: number,
  bboxY: number,
  sw: number,
  sh: number,
  isPortrait: boolean,
  courtSide: "near" | "far" | null,
): [number, number] | null {
  const nx = bboxX / sw;
  const ny = bboxY / sh;

  if (isPortrait) {
    // Portrait end-on: Y = court long axis, X = short axis
    return [ny, nx];
  }

  // Landscape end-on:
  // Video X → canvas Y  (position along baseline, 0=left edge of court)
  // Video Y → canvas X  (depth: high Y = near baseline = right of canvas)

  if (courtSide === "near") {
    // Near player: frame Y in [NEAR_Y_NET, NEAR_Y_BASELINE]
    // courtX = 0.5 (net) when ny = NEAR_Y_NET
    // courtX = 1.0 (baseline) when ny = NEAR_Y_BASELINE
    const span = NEAR_Y_BASELINE - NEAR_Y_NET;
    const courtX = 0.5 + 0.5 * (ny - NEAR_Y_NET) / span;
    // canvas Y: flip so player's left (low video-X) → court top (y=0)
    const courtY = 1.0 - nx;
    return [
      Math.max(0.5, Math.min(1.0, courtX)),
      Math.max(0.0, Math.min(1.0, courtY)),
    ];
  }

  if (courtSide === "far") {
    // Far player: frame Y in [FAR_Y_BASELINE, FAR_Y_NET]
    // courtX = 0.0 (baseline) when ny = FAR_Y_BASELINE
    // courtX = 0.5 (net) when ny = FAR_Y_NET
    const span = FAR_Y_NET - FAR_Y_BASELINE;
    const courtX = 0.5 * (ny - FAR_Y_BASELINE) / span;
    // canvas Y: far player is seen from opposite side, so do NOT flip X
    const courtY = nx;
    return [
      Math.max(0.0, Math.min(0.5, courtX)),
      Math.max(0.0, Math.min(1.0, courtY)),
    ];
  }

  // null = both players: generic mapping (less accurate)
  return [ny, 1.0 - nx];
}

// ── Court surface + lines ─────────────────────────────────────────────────────
function drawCourtBase(ctx: CanvasRenderingContext2D) {
  const { x: CX, y: CY, w: CW, h: CH } = COURT;
  const px = (f: number) => CX + f * CW;
  const py = (f: number) => CY + f * CH;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };

  ctx.save();

  // ── Canvas background
  ctx.fillStyle = "#0e1a10";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // ── Subtle ambient glow
  const glow = ctx.createRadialGradient(CANVAS_W/2, CANVAS_H/2, 0, CANVAS_W/2, CANVAS_H/2, Math.max(CW, CH)*0.75);
  glow.addColorStop(0, "rgba(25,80,40,0.18)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // ── Court surface (two-tone: near half slightly lighter)
  const surf = ctx.createLinearGradient(CX, CY, CX+CW, CY);
  surf.addColorStop(0,    "#14381c");
  surf.addColorStop(0.49, "#1b4826");
  surf.addColorStop(0.51, "#1e5229");
  surf.addColorStop(1,    "#14381c");
  ctx.fillStyle = surf;
  ctx.fillRect(CX, CY, CW, CH);

  // ── Court lines
  ctx.strokeStyle = "rgba(255,255,255,0.88)";
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = "miter";

  // Outer doubles boundary
  ctx.strokeRect(px(0), py(0), CW, CH);

  // Singles sidelines
  line(px(0), py(SI),   px(1), py(SI));
  line(px(0), py(1-SI), px(1), py(1-SI));

  // Back service lines (run between singles sidelines)
  line(px(BSL),   py(SI), px(BSL),   py(1-SI));
  line(px(1-BSL), py(SI), px(1-BSL), py(1-SI));

  // Short service lines (full width — the "T" vertical arms)
  line(px(SSL),   py(0), px(SSL),   py(1));
  line(px(1-SSL), py(0), px(1-SSL), py(1));

  // Centre service lines (horizontal at y=0.5, connecting short-svc → back-svc each side)
  line(px(BSL),   py(0.5), px(SSL),   py(0.5));
  line(px(1-SSL), py(0.5), px(1-BSL), py(0.5));

  // ── Net (shadow pass then bright line)
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.40)";
  ctx.lineWidth   = 6;
  line(px(0.5)+1.5, py(0)+1.5, px(0.5)+1.5, py(1)+1.5);
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineWidth   = 3;
  line(px(0.5), py(0), px(0.5), py(1));
  ctx.restore();

  // Net post markers
  ctx.fillStyle = "#fff";
  ctx.fillRect(px(0.5)-2.5, py(0)-5, 5, 10);
  ctx.fillRect(px(0.5)-2.5, py(1)-5, 5, 10);

  // FAR / NEAR ghost text
  ctx.fillStyle    = "rgba(255,255,255,0.11)";
  ctx.font         = `bold ${Math.round(CH * 0.16)}px system-ui`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("FAR",  px(0.25), py(0.5));
  ctx.fillText("NEAR", px(0.75), py(0.5));

  ctx.restore();
}

// Re-draws only the lines (not the fill) — called after heat to keep them crisp.
function redrawLines(ctx: CanvasRenderingContext2D) {
  const { x: CX, y: CY, w: CW, h: CH } = COURT;
  const px = (f: number) => CX + f * CW;
  const py = (f: number) => CY + f * CH;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.82)";
  ctx.lineWidth   = 1.5;
  ctx.strokeRect(px(0), py(0), CW, CH);
  line(px(0), py(SI),   px(1), py(SI));
  line(px(0), py(1-SI), px(1), py(1-SI));
  line(px(BSL),   py(SI), px(BSL),   py(1-SI));
  line(px(1-BSL), py(SI), px(1-BSL), py(1-SI));
  line(px(SSL),   py(0),  px(SSL),   py(1));
  line(px(1-SSL), py(0),  px(1-SSL), py(1));
  line(px(BSL),   py(0.5), px(SSL),   py(0.5));
  line(px(1-SSL), py(0.5), px(1-BSL), py(0.5));
  // Net
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth   = 5;
  line(px(0.5)+1.5, py(0)+1.5, px(0.5)+1.5, py(1)+1.5);
  ctx.restore();
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineWidth   = 3;
  line(px(0.5), py(0), px(0.5), py(1));
  ctx.restore();
}

// ── Thermal legend ────────────────────────────────────────────────────────────
function drawLegend(ctx: CanvasRenderingContext2D) {
  const lx  = CANVAS_W - 12;
  const ly1 = COURT.y + 6;
  const ly2 = COURT.y + COURT.h - 6;
  const lh  = ly2 - ly1;
  const lw  = 7;

  const g = ctx.createLinearGradient(lx, ly2, lx, ly1);
  g.addColorStop(0,   thermalColour(0.05));
  g.addColorStop(0.3, thermalColour(0.35));
  g.addColorStop(0.7, thermalColour(0.70));
  g.addColorStop(1,   thermalColour(1.00));

  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(lx - lw, ly1, lw, lh);
  ctx.strokeStyle = "rgba(255,255,255,0.30)";
  ctx.lineWidth   = 0.5;
  ctx.strokeRect(lx - lw, ly1, lw, lh);
  ctx.fillStyle    = "rgba(255,255,255,0.60)";
  ctx.font         = "9px system-ui";
  ctx.textAlign    = "right";
  ctx.textBaseline = "middle";
  ctx.fillText("High", lx - lw - 3, ly1 + 5);
  ctx.fillText("Low",  lx - lw - 3, ly2 - 5);
  ctx.restore();
}

// ── Main draw ─────────────────────────────────────────────────────────────────
function drawHeatmap(
  canvas: HTMLCanvasElement,
  frames: PoseFrame[],
  upToMs: number,
  sw: number,
  sh: number,
  courtSide: "near" | "far" | null,
  playerLabel: string,
  playerColor: string,          // used for dot + label only
) {
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const isPortrait = sh > sw;

  // Filter to current video time
  const visible = upToMs > 0 ? frames.filter(f => f.timestamp_ms <= upToMs) : frames;

  // Track latest mapped position for the live dot
  let lastX = -1, lastY = -1;
  const latestTs = visible.length > 0
    ? visible.reduce((max, f) => f.timestamp_ms > max ? f.timestamp_ms : max, -1)
    : -1;

  // Build hit-count grid
  const grid: number[][] = Array.from({length: ROWS}, () => new Array(COLS).fill(0));
  for (const f of visible) {
    if (f.bbox_x == null || f.bbox_y == null) continue;
    const mapped = mapToCourtXY(f.bbox_x, f.bbox_y, sw, sh, isPortrait, courtSide);
    if (!mapped) continue;
    const [cx, cy] = mapped;
    const col = Math.max(0, Math.min(COLS-1, Math.floor(cx * COLS)));
    const row = Math.max(0, Math.min(ROWS-1, Math.floor(cy * ROWS)));
    grid[row][col]++;
    if (f.timestamp_ms === latestTs) { lastX = cx; lastY = cy; }
  }

  const smoothed = blurGrid(grid, ROWS, COLS);
  let maxCount = 0;
  for (const row of smoothed) for (const v of row) { if (v > maxCount) maxCount = v; }

  // ── 1. Court base (background + surface fill + initial lines) ────────────
  drawCourtBase(ctx);

  // ── 2. Heat cells clipped to court rect ──────────────────────────────────
  if (maxCount > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(COURT.x, COURT.y, COURT.w, COURT.h);
    ctx.clip();

    const cellW = COURT.w / COLS;
    const cellH = COURT.h / ROWS;
    const gamma = 0.50;   // power curve: sparse areas still show colour

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = smoothed[r][c];
        if (v < 0.001) continue;
        ctx.fillStyle = thermalColour(Math.pow(v / maxCount, gamma));
        ctx.fillRect(
          COURT.x + c * cellW,
          COURT.y + r * cellH,
          Math.ceil(cellW) + 0.5,
          Math.ceil(cellH) + 0.5,
        );
      }
    }
    ctx.restore();
  }

  // ── 3. Court lines redrawn on top of heat ────────────────────────────────
  redrawLines(ctx);

  // ── 4. Live position dot (uses playerColor) ───────────────────────────────
  if (lastX >= 0 && maxCount > 0) {
    const dotX = COURT.x + lastX * COURT.w;
    const dotY = COURT.y + lastY * COURT.h;

    // Parse #rrggbb → r,g,b for rgba()
    const hex = playerColor.replace("#", "");
    const dr = parseInt(hex.slice(0,2), 16);
    const dg = parseInt(hex.slice(2,4), 16);
    const db = parseInt(hex.slice(4,6), 16);

    ctx.save();
    // Outer glow
    const grad = ctx.createRadialGradient(dotX, dotY, 0, dotX, dotY, 18);
    grad.addColorStop(0,   `rgba(${dr},${dg},${db},0.80)`);
    grad.addColorStop(0.4, `rgba(${dr},${dg},${db},0.30)`);
    grad.addColorStop(1,   `rgba(${dr},${dg},${db},0.00)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 18, 0, Math.PI * 2);
    ctx.fill();
    // Core dot
    ctx.fillStyle   = playerColor;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ── 5. No-data placeholder ────────────────────────────────────────────────
  if (maxCount === 0) {
    ctx.save();
    ctx.fillStyle    = "rgba(180,180,180,0.50)";
    ctx.font         = "11px system-ui";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Play the video — heatmap builds as it plays", CANVAS_W/2, CANVAS_H/2);
    ctx.restore();
  }

  // ── 6. Player label chip (colour swatch + text) ───────────────────────────
  if (playerLabel) {
    const hex = playerColor.replace("#", "");
    const dr = parseInt(hex.slice(0,2), 16);
    const dg = parseInt(hex.slice(2,4), 16);
    const db = parseInt(hex.slice(4,6), 16);

    ctx.save();
    ctx.font         = "bold 10px system-ui";
    ctx.textBaseline = "middle";
    ctx.textAlign    = "left";

    const lx   = COURT.x + 7;
    const ly   = COURT.y + 7;
    const dotR = 5;
    const tw   = ctx.measureText(playerLabel).width;
    const chipW = dotR * 2 + 8 + tw + 6;
    const chipH = 16;

    // Background
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(lx, ly, chipW, chipH, 4);
      ctx.fill();
    } else {
      ctx.fillRect(lx, ly, chipW, chipH);
    }
    // Colour dot
    ctx.fillStyle = playerColor;
    ctx.beginPath();
    ctx.arc(lx + dotR + 4, ly + chipH / 2, dotR, 0, Math.PI * 2);
    ctx.fill();
    // White ring
    ctx.strokeStyle = `rgba(${dr},${dg},${db},0.40)`;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.arc(lx + dotR + 4, ly + chipH / 2, dotR + 1.5, 0, Math.PI * 2);
    ctx.stroke();
    // Text
    ctx.fillStyle = "rgba(255,255,255,0.93)";
    ctx.fillText(playerLabel, lx + dotR * 2 + 8, ly + chipH / 2);
    ctx.restore();
  }

  // ── 7. Thermal legend ─────────────────────────────────────────────────────
  if (maxCount > 0) drawLegend(ctx);
}

// ── Component ─────────────────────────────────────────────────────────────────
const DEFAULT_NEAR_COLOR = "#22c55e";
const DEFAULT_FAR_COLOR  = "#3b82f6";

export default function CourtHeatmap({
  runId,
  courtSide,
  sourceWidth,
  sourceHeight,
  enabled,
  currentTimeMs,
  playerLabel = "",
  playerColor,
}: CourtHeatmapProps) {
  const dotColor = playerColor
    ?? (courtSide === "near" ? DEFAULT_NEAR_COLOR : DEFAULT_FAR_COLOR);

  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const framesRef        = useRef<PoseFrame[]>([]);
  const [loading, setLoading] = useState(false);

  const currentTimeMsRef = useRef(currentTimeMs);
  const lastDrawnMsRef   = useRef(-1);
  const rafRef           = useRef<number | null>(null);
  const dataReadyRef     = useRef(false);

  currentTimeMsRef.current = currentTimeMs;

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
      try {
        while (true) {
          const result = await apiClient.getPoses(runId, {
            ...(courtSide ? { court_side: courtSide } : {}),
            limit: 1000,
            offset,
          });
          if (cancelled) return;
          all.push(...result.items);
          if (!result.has_more) break;
          offset += 1000;
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
        sourceWidth, sourceHeight,
        courtSide, playerLabel, dotColor,
      );
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceWidth, sourceHeight, courtSide, playerLabel, dotColor]);

  return (
    <div className="relative w-full rounded-lg overflow-hidden bg-[#0e1a10]">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-black/50 rounded-lg">
          <svg className="animate-spin h-5 w-5 text-green-400"
            xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-label="Loading">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          <span className="ml-2 text-xs text-gray-400">Loading…</span>
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

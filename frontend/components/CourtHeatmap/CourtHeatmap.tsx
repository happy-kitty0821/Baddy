"use client";

import { useEffect, useRef, useState } from "react";
import type { PoseFrame } from "@/types/api";
import apiClient from "@/lib/api";

// ── Canvas ────────────────────────────────────────────────────────────────────
// BWF doubles court: 13.4 m × 6.1 m  →  aspect ≈ 2.197
const CANVAS_W = 680;
const CANVAS_H = 360;

// Court surface rect inside the canvas (px).
const COURT = { x: 40, y: 28, w: CANVAS_W - 80, h: CANVAS_H - 56 };

// Heat grid — proportional to court dims.
const COLS = 44;
const ROWS = 20;

// ── BWF line fractions (of full-court length / width) ─────────────────────────
//
//  Court = 13.4 m long × 6.1 m wide.
//  Canvas is LANDSCAPE: long axis = horizontal (x), short axis = vertical (y).
//
//  Horizontal (x) fractions:
//    Back boundary     : 0  and  1
//    Back service line : BSL = 0.76/13.4 = 0.0567  from each end
//    Short service line: SSL = 1.98/6.7 of each half
//                             = (6.7-1.98)/13.4 from each end
//                             = 0.5 - 0.2955 = 0.2045 from each end
//    Net               : 0.5
//
//  Vertical (y) fractions:
//    Doubles sideline  : 0  and  1
//    Singles sideline  : SI = 0.46/6.1 = 0.0754  from each edge
//    Centre svc line   : 0.5
//
const SI  = 0.0754;
const BSL = 0.0567;
const SSL = 0.2045;

// ── Court-half mapping ────────────────────────────────────────────────────────
//
// For a back-corner / end-on camera the court occupies a sub-region of the
// video frame.  Instead of fitting per-player p3/p97 bounds (which compresses
// a single player's half into the full canvas and loses position information),
// we map the two known court halves to fixed canvas regions.
//
// Landscape video (1920×1080 typical):
//   "near" = player at the near baseline  →  bottom of frame, high Y values
//   "far"  = player at the far baseline   →  top of frame,   low  Y values
//
// Camera-frame → normalised [0,1]:
//   The court long-axis (left/right along baseline) maps to video X.
//   The court depth (near baseline → net → far baseline) maps to video Y.
//
// For the landscape case the two players typically span:
//   Near: Y ≈ 0.50 – 0.95  (bottom half of frame)
//   Far:  Y ≈ 0.05 – 0.50  (top half of frame)
//   X:    full width  ≈ 0.01 – 0.99 for both
//
// On the landscape canvas:
//   Court long-axis   = canvas X
//   Court depth near→far = canvas X also (left=near-baseline, right=far-baseline)?
//
// WAIT — the landscape canvas shows the court from ABOVE (bird's-eye), so:
//   Canvas X (horizontal) = court LONG axis = left baseline → net → right baseline
//   Canvas Y (vertical)   = court SHORT axis = one sideline → other sideline
//
// But the video camera is at one END, not above.  So in the video frame:
//   Video X = court short axis (player moves left/right along their baseline)
//   Video Y = court long axis (player moves toward/away from net)
//
// Therefore the correct mapping for landscape end-on camera is:
//   video bbox_x / source_width  → court SHORT axis → canvas Y
//   video bbox_y / source_height → court LONG axis  → canvas X
//
// And the court LONG axis on canvas:
//   near baseline is at canvas x = 1.0 (right side)
//   net           is at canvas x = 0.5
//   far baseline  is at canvas x = 0.0 (left side)
//
// So for the NEAR player (Y in frame ≈ 0.5..0.95):
//   canvas_x = 1.0 − (frame_y − 0.5) / 0.45   (maps near-baseline→1.0, net→0.5)
//   canvas_y = frame_x / 1.0                    (left→0, right→1)
//
// For the FAR player (Y in frame ≈ 0.05..0.50):
//   canvas_x = (0.5 − frame_y) / 0.45          (maps net→0.5, far-baseline→0.0)
//   canvas_y = 1.0 − frame_x / 1.0             (mirrored: far end looks opposite)
//
// These constants are tuned to the measured ranges from the real data.
// They can be overridden via props once we have court detection in Phase 3.
const NEAR_Y_MIN = 0.48;  // frame Y where near player is closest to net
const NEAR_Y_MAX = 0.97;  // frame Y where near player is at their baseline
const FAR_Y_MIN  = 0.03;  // frame Y where far player is at their baseline
const FAR_Y_MAX  = 0.52;  // frame Y where far player is closest to net

interface CourtHeatmapProps {
  runId: string;
  courtSide: "near" | "far" | null;
  sourceWidth: number;
  sourceHeight: number;
  enabled: boolean;
  currentTimeMs: number;
  playerLabel?: string;
  /** Hex or CSS colour for the heat and position dot.  Default: side-specific. */
  playerColor?: string;
}

// ── Colour ramp ───────────────────────────────────────────────────────────────
function heatColour(t: number, baseHex: string): string {
  // Parse baseHex (#rrggbb) → rgb
  const br = parseInt(baseHex.slice(1, 3), 16);
  const bg = parseInt(baseHex.slice(3, 5), 16);
  const bb = parseInt(baseHex.slice(5, 7), 16);

  // Low end: dark blue-ish version of the base colour, transparent
  // High end: bright saturated base colour, near-opaque
  type Stop = [number, number, number, number, number];
  const stops: Stop[] = [
    [0.00,  br*0.1,  bg*0.1,  bb*0.1, 0.00],
    [0.20,  br*0.4,  bg*0.4,  bb*0.4, 0.45],
    [0.55,  br*0.8,  bg*0.8,  bb*0.8, 0.70],
    [0.80,  br,      bg,      bb,      0.88],
    [1.00,  Math.min(255,br+60), Math.min(255,bg+40), Math.min(255,bb+40), 0.96],
  ];
  let s0 = stops[0], s1 = stops[1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i+1][0]) { s0 = stops[i]; s1 = stops[i+1]; break; }
  }
  const span = s1[0] - s0[0];
  const f = span === 0 ? 0 : (t - s0[0]) / span;
  const lr = (a: number, b: number) => Math.round(Math.max(0, Math.min(255, a + (b-a)*f)));
  return `rgba(${lr(s0[1],s1[1])},${lr(s0[2],s1[2])},${lr(s0[3],s1[3])},${(s0[4]+(s1[4]-s0[4])*f).toFixed(3)})`;
}

// ── 3×3 Gaussian blur ─────────────────────────────────────────────────────────
function blurGrid(g: number[][], R: number, C: number): number[][] {
  const k = [[0.0625,0.125,0.0625],[0.125,0.25,0.125],[0.0625,0.125,0.0625]];
  const o: number[][] = Array.from({length: R}, () => new Array(C).fill(0));
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
//
// Maps a raw (bbox_x, bbox_y) in source pixels to (courtX, courtY) in [0,1]
// canvas court coordinates, correctly accounting for camera angle.
//
// courtX = 0 → left  edge of canvas court (far  baseline)
// courtX = 1 → right edge of canvas court (near baseline)
// courtY = 0 → top   edge of canvas court (one doubles sideline)
// courtY = 1 → bottom edge               (other doubles sideline)
//
function mapToCourtXY(
  bboxX: number,
  bboxY: number,
  sw: number,
  sh: number,
  isPortrait: boolean,
  courtSide: "near" | "far" | null,
): [number, number] | null {
  const nx = bboxX / sw;  // [0,1] normalised X in source frame
  const ny = bboxY / sh;  // [0,1] normalised Y in source frame

  if (isPortrait) {
    // Portrait end-on camera: long axis of court = video Y, short axis = video X
    // (same mapping as before, percentile-free)
    const courtX = ny;          // depth from far→near
    const courtY = nx;          // left→right on baseline
    return [courtX, courtY];
  }

  // Landscape end-on camera:
  // Video X = left/right along the player's baseline → court short axis (canvas Y)
  // Video Y = distance from camera → court long axis (canvas X)
  //
  // Near player: high video-Y → near their baseline (canvas right, x≈1)
  //              low  video-Y → near the net         (canvas x≈0.5)
  // Far  player: low  video-Y → far baseline          (canvas left,  x≈0)
  //              high video-Y → near the net           (canvas x≈0.5)

  if (courtSide === "near" || courtSide === null) {
    // Near player: invert Y so baseline→right, net→0.5
    const ySpan = NEAR_Y_MAX - NEAR_Y_MIN;
    // courtX = 1.0 (baseline) when ny = NEAR_Y_MAX
    // courtX = 0.5 (net)      when ny = NEAR_Y_MIN
    const courtX = 0.5 + 0.5 * (ny - NEAR_Y_MIN) / ySpan;
    // courtY: video X spans across the player's side of the court.
    // Flip: player's left in frame = top of canvas (y=0), right = bottom (y=1)
    const courtY = 1.0 - nx;
    if (courtSide === "near") return [Math.max(0.5, Math.min(1.0, courtX)), Math.max(0, Math.min(1, courtY))];
  }

  if (courtSide === "far" || courtSide === null) {
    // Far player: low Y in frame = far baseline (canvas left, x=0)
    // net ≈ y=0.5 in frame
    const ySpan = FAR_Y_MAX - FAR_Y_MIN;
    // courtX = 0.0 (far baseline) when ny = FAR_Y_MIN
    // courtX = 0.5 (net)          when ny = FAR_Y_MAX
    const courtX = 0.5 * (ny - FAR_Y_MIN) / ySpan;
    // courtY: far player's video-X is seen from opposite end, so reverse
    const courtY = nx;
    if (courtSide === "far") return [Math.max(0, Math.min(0.5, courtX)), Math.max(0, Math.min(1, courtY))];
  }

  // courtSide=null: both players, just use full normalised Y
  const courtX = ny;
  const courtY = 1.0 - nx;
  return [courtX, courtY];
}

// ── Court surface + lines ─────────────────────────────────────────────────────
function drawCourt(ctx: CanvasRenderingContext2D) {
  const { x: CX, y: CY, w: CW, h: CH } = COURT;
  const px = (f: number) => CX + f * CW;
  const py = (f: number) => CY + f * CH;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };

  ctx.save();

  // Canvas background
  ctx.fillStyle = "#0e1a10";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Ambient glow
  const glow = ctx.createRadialGradient(CANVAS_W/2, CANVAS_H/2, 0, CANVAS_W/2, CANVAS_H/2, Math.max(CW, CH)*0.75);
  glow.addColorStop(0, "rgba(25,80,40,0.20)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Court surface — subtle gradient between the two halves
  const sg = ctx.createLinearGradient(CX, CY, CX+CW, CY);
  sg.addColorStop(0,    "#153a1f");
  sg.addColorStop(0.49, "#1c4c28");
  sg.addColorStop(0.51, "#1c4c28");
  sg.addColorStop(1,    "#153a1f");
  ctx.fillStyle = sg;
  ctx.fillRect(CX, CY, CW, CH);

  // Lines
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = "round";

  // Outer doubles boundary
  ctx.strokeRect(px(0), py(0), CW, CH);

  // Singles sidelines
  line(px(0), py(SI),     px(1), py(SI));
  line(px(0), py(1-SI),   px(1), py(1-SI));

  // Back service lines (between singles sidelines only)
  line(px(BSL),   py(SI), px(BSL),   py(1-SI));
  line(px(1-BSL), py(SI), px(1-BSL), py(1-SI));

  // Short service lines (full width)
  line(px(SSL),   py(0), px(SSL),   py(1));
  line(px(1-SSL), py(0), px(1-SSL), py(1));

  // Centre service lines (horizontal at y=0.5, between short-svc and back-svc)
  line(px(BSL),   py(0.5), px(SSL),   py(0.5));
  line(px(1-SSL), py(0.5), px(1-BSL), py(0.5));

  // Net shadow
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth   = 6;
  line(px(0.5)+1.5, py(0)+1.5, px(0.5)+1.5, py(1)+1.5);
  ctx.restore();

  // Net
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineWidth   = 3;
  line(px(0.5), py(0), px(0.5), py(1));

  // Net post markers
  ctx.fillStyle = "#fff";
  [[py(0)], [py(1)]].forEach(([y]) => {
    ctx.fillRect(px(0.5) - 2.5, y - 5, 5, 10);
  });

  // FAR / NEAR ghost text
  ctx.fillStyle    = "rgba(255,255,255,0.12)";
  ctx.font         = `bold ${Math.round(CH * 0.16)}px system-ui`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("FAR",  px(0.25), py(0.5));
  ctx.fillText("NEAR", px(0.75), py(0.5));

  ctx.restore();
}

// ── Legend ────────────────────────────────────────────────────────────────────
function drawLegend(ctx: CanvasRenderingContext2D, color: string) {
  const lx = CANVAS_W - 12;
  const ly1 = COURT.y + 6;
  const ly2 = COURT.y + COURT.h - 6;
  const lh  = ly2 - ly1;
  const lw  = 7;
  const g = ctx.createLinearGradient(lx, ly2, lx, ly1);
  g.addColorStop(0,   heatColour(0.05, color));
  g.addColorStop(0.4, heatColour(0.40, color));
  g.addColorStop(0.8, heatColour(0.80, color));
  g.addColorStop(1,   heatColour(1.00, color));
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(lx - lw, ly1, lw, lh);
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth   = 0.5;
  ctx.strokeRect(lx - lw, ly1, lw, lh);
  ctx.fillStyle    = "rgba(255,255,255,0.6)";
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
  playerColor: string,
) {
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const isPortrait = sh > sw;

  // Filter to current playback time
  const visible = upToMs > 0 ? frames.filter(f => f.timestamp_ms <= upToMs) : frames;

  // ── Build hit grid ────────────────────────────────────────────────────────
  const grid: number[][] = Array.from({length: ROWS}, () => new Array(COLS).fill(0));

  // Track latest position for the live dot
  let lastCourtX = -1, lastCourtY = -1;
  const latestTs = visible.reduce((max, f) => f.timestamp_ms > max ? f.timestamp_ms : max, -1);

  for (const f of visible) {
    if (f.bbox_x == null || f.bbox_y == null) continue;
    const mapped = mapToCourtXY(f.bbox_x, f.bbox_y, sw, sh, isPortrait, courtSide);
    if (!mapped) continue;
    const [cx, cy] = mapped;
    const col = Math.max(0, Math.min(COLS-1, Math.floor(cx * COLS)));
    const row = Math.max(0, Math.min(ROWS-1, Math.floor(cy * ROWS)));
    grid[row][col]++;
    if (f.timestamp_ms === latestTs) { lastCourtX = cx; lastCourtY = cy; }
  }

  const smoothed = blurGrid(grid, ROWS, COLS);
  let maxCount = 0;
  for (const row of smoothed) for (const v of row) { if (v > maxCount) maxCount = v; }

  // ── 1. Court surface + lines ──────────────────────────────────────────────
  drawCourt(ctx);

  // ── 2. Heat cells (clipped to court rect) ────────────────────────────────
  if (maxCount > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(COURT.x, COURT.y, COURT.w, COURT.h);
    ctx.clip();
    const cellW = COURT.w / COLS;
    const cellH = COURT.h / ROWS;
    const gamma = 0.5;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = smoothed[r][c];
        if (v < 0.001) continue;
        ctx.fillStyle = heatColour(Math.pow(v / maxCount, gamma), playerColor);
        ctx.fillRect(COURT.x + c*cellW, COURT.y + r*cellH, Math.ceil(cellW)+0.5, Math.ceil(cellH)+0.5);
      }
    }
    ctx.restore();
  }

  // ── 3. Court lines on top of heat ────────────────────────────────────────
  {
    const { x: CX, y: CY, w: CW, h: CH } = COURT;
    const px = (f: number) => CX + f * CW;
    const py = (f: number) => CY + f * CH;
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.80)";
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(px(0), py(0), CW, CH);
    line(px(0), py(SI),     px(1), py(SI));
    line(px(0), py(1-SI),   px(1), py(1-SI));
    line(px(BSL),   py(SI), px(BSL),   py(1-SI));
    line(px(1-BSL), py(SI), px(1-BSL), py(1-SI));
    line(px(SSL),   py(0),  px(SSL),   py(1));
    line(px(1-SSL), py(0),  px(1-SSL), py(1));
    line(px(BSL),   py(0.5), px(SSL),   py(0.5));
    line(px(1-SSL), py(0.5), px(1-BSL), py(0.5));
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth   = 5;
    line(px(0.5)+1.5, py(0)+1.5, px(0.5)+1.5, py(1)+1.5);
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.lineWidth   = 3;
    line(px(0.5), py(0), px(0.5), py(1));
    ctx.restore();
  }

  // ── 4. Live position dot ──────────────────────────────────────────────────
  if (lastCourtX >= 0 && maxCount > 0) {
    const dotX = COURT.x + lastCourtX * COURT.w;
    const dotY = COURT.y + lastCourtY * COURT.h;
    ctx.save();
    // Outer glow
    const grad = ctx.createRadialGradient(dotX, dotY, 0, dotX, dotY, 18);
    grad.addColorStop(0,   playerColor + "cc");
    grad.addColorStop(0.4, playerColor + "55");
    grad.addColorStop(1,   playerColor + "00");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 18, 0, Math.PI * 2);
    ctx.fill();
    // Dot core
    ctx.fillStyle   = playerColor;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ── 5. No-data message ────────────────────────────────────────────────────
  if (maxCount === 0) {
    ctx.save();
    ctx.fillStyle    = "rgba(180,180,180,0.50)";
    ctx.font         = "11px system-ui";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Play the video — heatmap builds as it plays", CANVAS_W/2, CANVAS_H/2);
    ctx.restore();
  }

  // ── 6. Player label chip ──────────────────────────────────────────────────
  if (playerLabel) {
    ctx.save();
    const lx = COURT.x + 7;
    const ly = COURT.y + 7;
    ctx.font = "bold 10px system-ui";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const tw = ctx.measureText(playerLabel).width;
    const dotR = 5;
    const chipW = dotR*2 + 6 + tw + 8;
    const chipH = 16;
    // Background pill
    ctx.fillStyle = "rgba(0,0,0,0.60)";
    ctx.beginPath();
    ctx.roundRect?.(lx, ly, chipW, chipH, 4) ?? ctx.fillRect(lx, ly, chipW, chipH);
    ctx.fill();
    // Colour dot
    ctx.fillStyle = playerColor;
    ctx.beginPath();
    ctx.arc(lx + dotR + 5, ly + chipH/2, dotR, 0, Math.PI*2);
    ctx.fill();
    // Label text
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(playerLabel, lx + dotR*2 + 9, ly + chipH/2);
    ctx.restore();
  }

  // ── 7. Legend ─────────────────────────────────────────────────────────────
  if (maxCount > 0) drawLegend(ctx, playerColor);
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
  const resolvedColor = playerColor
    ?? (courtSide === "near" ? DEFAULT_NEAR_COLOR : DEFAULT_FAR_COLOR);

  const canvasRef        = useRef<HTMLCanvasElement>(null);
  const framesRef        = useRef<PoseFrame[]>([]);
  const [loading, setLoading] = useState(false);

  const currentTimeMsRef = useRef(currentTimeMs);
  const lastDrawnMsRef   = useRef(-1);
  const rafRef           = useRef<number | null>(null);
  const dataReadyRef     = useRef(false);

  currentTimeMsRef.current = currentTimeMs;

  // Fetch all frames for this player side
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

  // rAF draw loop — redraws only when time or color changes
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
        courtSide, playerLabel, resolvedColor,
      );
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceWidth, sourceHeight, courtSide, playerLabel, resolvedColor]);

  return (
    <div className="relative w-full rounded-lg overflow-hidden bg-[#0e1a10]">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-black/50 rounded-lg">
          <svg className="animate-spin h-5 w-5 text-green-400"
            xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-label="Loading">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
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

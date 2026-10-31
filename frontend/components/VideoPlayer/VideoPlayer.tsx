/**
 * VideoPlayer — HTML5 video player with overlay canvas.
 *
 * Overlay rendering uses requestAnimationFrame (rAF) instead of React state,
 * so the skeleton is drawn at the browser's display refresh rate (60fps) using
 * the exact video.currentTime at draw time — not a stale React state value
 * that was set when timeupdate fired.
 *
 * At 1× speed, timeupdate fires ~4×/sec.  If we used React state for drawing,
 * the canvas would only update 4× per second and the skeleton would lag behind
 * the video.  rAF fires 60×/sec and always reads the freshest video time.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getStoredToken } from "@/lib/auth";
import { clamp, formatDuration } from "@/lib/utils";

interface VideoPlayerProps {
  assetId: string;
  /** Called on every timeupdate event with the current time in seconds. */
  onTimeUpdate?: (currentTime: number) => void;
  /**
   * Overlay renderer (Phase 2+).
   * Called by requestAnimationFrame at ~60fps with the EXACT current video time.
   * Must be fast — avoid heavy computation inside this function.
   */
  renderOverlay?: (ctx: CanvasRenderingContext2D, currentTime: number) => void;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const FRAME_DURATION_S = 1 / 30;

function buildStreamUrl(assetId: string): string {
  const base = `/api/assets/${assetId}/stream`;
  const token = getStoredToken();
  if (!token) return base;
  return `${base}?token=${encodeURIComponent(token)}`;
}

export default function VideoPlayer({
  assetId,
  onTimeUpdate,
  renderOverlay,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Keep a ref to the latest renderOverlay so the rAF loop always has the
  // freshest renderer without needing to restart the loop on every re-render.
  const renderOverlayRef = useRef(renderOverlay);
  const rafIdRef = useRef<number>(0);
  const lastDrawnTimeRef = useRef<number>(-1);

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(SPEEDS.indexOf(1));
  const [error, setError] = useState<string | null>(null);

  const streamUrl = buildStreamUrl(assetId);

  // Keep renderOverlayRef up to date whenever the prop changes.
  useEffect(() => {
    renderOverlayRef.current = renderOverlay;
  }, [renderOverlay]);

  // ── rAF draw loop ────────────────────────────────────────────────────────
  // Runs at ~60fps.  Reads video.currentTime directly (not from React state)
  // so it is always accurate regardless of playback speed.
  const startRafLoop = useCallback(() => {
    const draw = () => {
      rafIdRef.current = requestAnimationFrame(draw);

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      // Sync canvas pixel size to video rendered size when they differ.
      if (video.clientWidth > 0 && video.clientHeight > 0) {
        if (canvas.width !== video.clientWidth || canvas.height !== video.clientHeight) {
          canvas.width = video.clientWidth;
          canvas.height = video.clientHeight;
        }
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const t = video.currentTime;

      // Skip drawing if the video time hasn't changed (paused / no new frame).
      // Use a threshold of half a frame at 60fps (8ms) to avoid skipping when
      // the video is moving slowly.
      if (Math.abs(t - lastDrawnTimeRef.current) < 0.008 && lastDrawnTimeRef.current >= 0) {
        return;
      }
      lastDrawnTimeRef.current = t;

      if (renderOverlayRef.current) {
        renderOverlayRef.current(ctx, t);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };

    rafIdRef.current = requestAnimationFrame(draw);
  }, []);

  const stopRafLoop = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
    }
  }, []);

  // Start/stop the rAF loop with the component.
  useEffect(() => {
    startRafLoop();
    return () => stopRafLoop();
  }, [startRafLoop, stopRafLoop]);

  // When the overlay changes, reset lastDrawnTime so the new renderer fires
  // immediately even while the video is paused.
  useEffect(() => {
    lastDrawnTimeRef.current = -1;
  }, [renderOverlay]);

  // timeupdate: only used for the seek bar and the onTimeUpdate callback.
  // Do NOT drive the draw loop from here.
  const handleTimeUpdate = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;
    setCurrentTime(t);
    onTimeUpdate?.(t);
  }, [onTimeUpdate]);

  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v) return;
    setDuration(v.duration ?? 0);
    if (c) {
      c.width = v.clientWidth || v.videoWidth;
      c.height = v.clientHeight || v.videoHeight;
    }
    lastDrawnTimeRef.current = -1; // force a redraw after metadata loads
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch((e) => setError(e.message));
    } else {
      v.pause();
    }
  }, []);

  const stepFrame = useCallback((direction: 1 | -1) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = clamp(
      v.currentTime + direction * FRAME_DURATION_S,
      0,
      v.duration
    );
    // Force an immediate redraw after frame-stepping (video is paused so rAF
    // skips draws, but we need the canvas to update).
    lastDrawnTimeRef.current = -1;
  }, []);

  const cycleSpeed = useCallback(() => {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    if (videoRef.current) videoRef.current.playbackRate = SPEEDS[next];
  }, [speedIndex]);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const t = Number(e.target.value);
      if (videoRef.current) videoRef.current.currentTime = t;
      setCurrentTime(t);
      lastDrawnTimeRef.current = -1; // force redraw after seek
    },
    []
  );

  const handleVideoError = useCallback(() => {
    const v = videoRef.current;
    const code = v?.error?.code;
    if (code === MediaError.MEDIA_ERR_NETWORK || code === undefined) {
      setError(
        "Could not load video. Your session may have expired — try refreshing the page."
      );
    } else {
      setError("Video playback error. The file may be in an unsupported format.");
    }
  }, []);

  // Canvas size sync on window resize.
  useEffect(() => {
    const syncCanvasSize = () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (v && c && v.clientWidth > 0) {
        c.width = v.clientWidth;
        c.height = v.clientHeight;
        lastDrawnTimeRef.current = -1; // force redraw after resize
      }
    };
    window.addEventListener("resize", syncCanvasSize);
    const t = setTimeout(syncCanvasSize, 200);
    return () => {
      window.removeEventListener("resize", syncCanvasSize);
      clearTimeout(t);
    };
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      if (e.code === "ArrowRight") { e.preventDefault(); stepFrame(1); }
      if (e.code === "ArrowLeft") { e.preventDefault(); stepFrame(-1); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, stepFrame]);

  if (error) {
    return (
      <div className="rounded-md bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Video + overlay canvas stack */}
      <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
        <video
          ref={videoRef}
          src={streamUrl}
          className="w-full h-full"
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={handleVideoError}
          aria-label="Match video"
          playsInline
        />
        {/* Overlay canvas — drawn by rAF loop, not React state */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          aria-hidden="true"
        />
      </div>

      {/* Seek bar */}
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={FRAME_DURATION_S}
        value={currentTime}
        onChange={handleSeek}
        className="w-full accent-green-500"
        aria-label="Seek video"
      />

      {/* Controls */}
      <div className="flex items-center gap-3 text-sm">
        <button
          onClick={() => stepFrame(-1)}
          className="rounded bg-gray-700 px-2 py-1 hover:bg-gray-600 transition-colors"
          aria-label="Previous frame"
          title="Previous frame (←)"
        >
          ◀
        </button>

        <button
          onClick={togglePlay}
          className="rounded bg-gray-700 px-3 py-1 font-medium hover:bg-gray-600 transition-colors"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>

        <button
          onClick={() => stepFrame(1)}
          className="rounded bg-gray-700 px-2 py-1 hover:bg-gray-600 transition-colors"
          aria-label="Next frame"
          title="Next frame (→)"
        >
          ▶
        </button>

        <button
          onClick={cycleSpeed}
          className="rounded bg-gray-700 px-2 py-1 hover:bg-gray-600 transition-colors"
          aria-label={`Playback speed: ${SPEEDS[speedIndex]}×`}
          title="Cycle playback speed"
        >
          {SPEEDS[speedIndex]}×
        </button>

        <span className="ml-auto text-gray-400 tabular-nums text-xs">
          {formatDuration(currentTime * 1000)} /{" "}
          {formatDuration(duration * 1000)}
        </span>
      </div>

      {/* Phase 2+ overlay controls — stubs for future phases */}
      <div className="flex items-center gap-3 text-xs text-gray-500 border-t border-gray-800 pt-2">
        <span>Overlays:</span>
        <span className="italic">Skeleton — Phase 2</span>
        <span className="italic">Shuttle — Phase 4</span>
      </div>
    </div>
  );
}

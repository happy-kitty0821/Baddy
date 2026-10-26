/**
 * VideoPlayer — HTML5 video player with overlay canvas.
 *
 * Authentication:
 *   The native <video> element cannot set request headers.  We append the
 *   stored JWT as a ?token= query parameter.  The backend validates it
 *   identically to the Authorization: Bearer header.  The token is the same
 *   short-lived JWT used everywhere else — no special long-lived token is
 *   created for video playback.
 *
 *   If the token is absent (user not logged in), the src is set to an empty
 *   string and the player shows an error.  The AuthGuard in layout.tsx
 *   redirects to /login before this component can be rendered, so a missing
 *   token here is an edge case (e.g. token expired mid-session).
 *
 * Range requests:
 *   The ?token= approach preserves native browser range request support
 *   because the browser is making the HTTP requests directly.  A Blob URL
 *   approach would require pre-fetching the entire file, which is unsuitable
 *   for large videos.
 *
 * Phase 2+: skeleton overlay drawn on the canvas layer.
 * Phase 4+: shuttle marker and trail drawn on the canvas layer.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import apiClient from "@/lib/api";
import { getStoredToken } from "@/lib/auth";
import { clamp, formatDuration } from "@/lib/utils";

interface VideoPlayerProps {
  assetId: string;
  /** Called on every timeupdate event with the current time in seconds. */
  onTimeUpdate?: (currentTime: number) => void;
  /** Overlay canvas content (Phase 2+). Currently a no-op stub. */
  renderOverlay?: (ctx: CanvasRenderingContext2D, currentTime: number) => void;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const FRAME_DURATION_S = 1 / 30; // assume 30 fps; Phase 2+ will use actual fps

/**
 * Build an authenticated stream URL for the given asset.
 * Appends the stored JWT as ?token=<value> so the <video> element can
 * authenticate without needing to set a request header.
 */
function buildStreamUrl(assetId: string): string {
  const base = `/api/assets/${assetId}/stream`;
  const token = getStoredToken();
  if (!token) return base; // will get a 401; AuthGuard should have prevented this
  return `${base}?token=${encodeURIComponent(token)}`;
}

export default function VideoPlayer({
  assetId,
  onTimeUpdate,
  renderOverlay,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(SPEEDS.indexOf(1));
  const [error, setError] = useState<string | null>(null);

  // Build authenticated URL. If the token expires, we rebuild when the
  // component re-renders (e.g. after a page refresh that re-validates the token).
  const streamUrl = buildStreamUrl(assetId);

  // Draw overlay on canvas whenever currentTime changes.
  useEffect(() => {
    if (!renderOverlay || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    if (ctx) renderOverlay(ctx, currentTime);
  }, [currentTime, renderOverlay]);

  const handleTimeUpdate = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;
    setCurrentTime(t);
    onTimeUpdate?.(t);
  }, [onTimeUpdate]);

  const handleLoadedMetadata = useCallback(() => {
    setDuration(videoRef.current?.duration ?? 0);
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

  // Keyboard shortcuts
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
        {/* Overlay canvas (Phase 2+ content drawn here) */}
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

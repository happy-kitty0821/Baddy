/**
 * MatchDetail — client component for the match analysis page.
 *
 * Phase 1: video playback + match metadata + processing status.
 * Phase 2: player detection/pose analysis trigger + skeleton overlay + player identity.
 * Phase 4: shuttlecock tracking overlay.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnalysisRunRead, MatchRead } from "@/types/api";
import apiClient from "@/lib/api";
import VideoPlayer from "@/components/VideoPlayer/VideoPlayer";
import ProcessingStatus from "@/components/ProcessingStatus/ProcessingStatus";
import SkeletonOverlay from "@/components/SkeletonOverlay/SkeletonOverlay";
import ShuttleOverlay from "@/components/ShuttleOverlay/ShuttleOverlay";
import PlayerPanel from "@/components/PlayerPanel/PlayerPanel";
import CourtHeatmap from "@/components/CourtHeatmap/CourtHeatmap";
import {
  computeFps,
  formatDate,
  formatDuration,
  formatFileSize,
  matchStatusColor,
  matchStatusLabel,
} from "@/lib/utils";

interface MatchDetailProps {
  id: string;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export default function MatchDetail({ id }: MatchDetailProps) {
  const router = useRouter();
  const [match, setMatch] = useState<MatchRead | null>(null);
  const [latestRun, setLatestRun] = useState<AnalysisRunRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Phase 2 state.
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [showBoxes, setShowBoxes] = useState(true);
  const [showTrackIds, setShowTrackIds] = useState(true);
  const [visionStarted, setVisionStarted] = useState(false);
  // Which court side's skeleton to show: null = both, "near" or "far".
  const [selectedCourtSide, setSelectedCourtSide] = useState<"near" | "far" | null>(null);
  // Per-player display config — colour + label, editable by the user.
  const [nearColor, setNearColor] = useState("#22c55e");
  const [farColor,  setFarColor]  = useState("#3b82f6");
  const [nearLabel, setNearLabel] = useState("You");
  const [farLabel,  setFarLabel]  = useState("Opponent");

  // Phase 4 state.
  const [showShuttle, setShowShuttle] = useState(true);

  // Current video playback time — stored in a ref (not state) so it updates
  // at 60fps via VideoPlayer's rAF loop without triggering React re-renders.
  // The heatmap reads it via the getVideoTimeMs callback in its own rAF loop.
  const videoTimeMsRef = useRef(0);
  const handleTimeUpdate = useCallback((currentTime: number) => {
    videoTimeMsRef.current = Math.round(currentTime * 1000);
  }, []);
  const getVideoTimeMs = useCallback(() => videoTimeMsRef.current, []);

  // ── Combined overlay renderer registry ────────────────────────────────────
  // Each overlay registers itself via setSkeletonRenderer / setShuttleRenderer.
  // All renderer state lives in refs — no React state — so registering a new
  // renderer never triggers a re-render loop.
  // VideoPlayer's rAF loop reads renderOverlayRef.current directly, so it
  // always calls the latest combined renderer without any state bumps.
  type Renderer = (ctx: CanvasRenderingContext2D, t: number) => void;
  const skeletonRendererRef = useRef<Renderer | null>(null);
  const shuttleRendererRef  = useRef<Renderer | null>(null);

  // The combined renderer is a stable function that reads from the refs each
  // frame. It is created once (empty deps) and never recreated.
  const combinedRenderer = useCallback<Renderer>((ctx, t) => {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    skeletonRendererRef.current?.(ctx, t);
    shuttleRendererRef.current?.(ctx, t);
  }, []); // stable — no deps, reads refs at call time

  const setSkeletonRenderer = useCallback((fn: Renderer | null) => {
    skeletonRendererRef.current = fn;
  }, []);

  const setShuttleRenderer = useCallback((fn: Renderer | null) => {
    shuttleRendererRef.current = fn;
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const m = await apiClient.getMatch(id);
        if (cancelled) return;
        setMatch(m);
        try {
          const run = await apiClient.getLatestAnalysis(id);
          if (!cancelled) setLatestRun(run);
        } catch {
          // No run exists.
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id]);

  const handleRunComplete = useCallback(async (run: AnalysisRunRead) => {
    setLatestRun(run);
    try {
      const m = await apiClient.getMatch(id);
      setMatch(m);
    } catch { /* non-fatal */ }
  }, [id]);

  const handleRunError = useCallback((run: AnalysisRunRead) => {
    setLatestRun(run);
  }, []);

  const handleRetry = async () => {
    if (!latestRun) return;
    setRetrying(true);
    try {
      const newRun = await apiClient.retryAnalysis(latestRun.id);
      setLatestRun(newRun);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  };

  const handleCancel = async () => {
    if (!latestRun) return;
    setCancelling(true);
    try {
      const run = await apiClient.cancelAnalysis(latestRun.id);
      setLatestRun(run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  const handleStartVision = async () => {
    if (!latestRun) return;
    setVisionStarted(true);
    try {
      const run = await apiClient.startVision(latestRun.id);
      setLatestRun(run);
    } catch (e) {
      setError((e as Error).message);
      setVisionStarted(false);
    }
  };

  const handleDelete = async () => {
    if (!match) return;
    try {
      await apiClient.deleteMatch(match.id);
      router.push("/library");
    } catch (e) {
      const msg = (e as Error).message;
      // A 409 means the video file is locked (still streaming on Windows).
      setError(
        msg.includes("409") || msg.toLowerCase().includes("accessed")
          ? "The video is still open. Stop playback, wait a moment, then try deleting again."
          : msg
      );
    }
  };

  if (loading) {
    return (
      <div className="text-center py-20 text-gray-500 animate-pulse">Loading match…</div>
    );
  }
  if (error || !match) {
    return (
      <div className="rounded-md bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
        {error || "Match not found."}
      </div>
    );
  }

  const statusClass = matchStatusColor(match.status);
  const runIsActive = latestRun && !TERMINAL_STATUSES.has(latestRun.status);
  // Vision is available to start whenever ingestion completed.
  const visionAvailable = latestRun?.status === "completed" && match.source_asset_id;
  // Vision results exist when the run is completed and has tracks/poses
  // (we don't check current_stage/progress_pct as those may vary).
  const hasVisionResults = latestRun?.status === "completed";

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">{match.title}</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass}`}>
              {matchStatusLabel(match.status)}
            </span>
            {match.recorded_at && (
              <span className="text-sm text-gray-400">{formatDate(match.recorded_at)}</span>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {!deleteConfirm ? (
            <button onClick={() => setDeleteConfirm(true)}
              className="rounded border border-red-700 px-3 py-1 text-xs text-red-400 hover:bg-red-900/40 transition-colors">
              Delete
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-300">Delete permanently?</span>
              <button onClick={handleDelete}
                className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-500">Confirm</button>
              <button onClick={() => setDeleteConfirm(false)}
                className="rounded border border-gray-600 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700">Cancel</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Main two-column area ──────────────────────────────────────────────── */}
      <div className="flex gap-5 items-start">

        {/* ── LEFT — video + controls ───────────────────────────────────────── */}
        <div className="flex-1 min-w-0 space-y-2">

          {match.source_asset_id ? (
            <>
              <VideoPlayer
                assetId={match.source_asset_id}
                renderOverlay={combinedRenderer}
                onTimeUpdate={handleTimeUpdate}
              />

              {showSkeleton && latestRun && (
                <SkeletonOverlay
                  runId={latestRun.id}
                  enabled={showSkeleton}
                  showBoxes={showBoxes}
                  showTrackIds={showTrackIds}
                  courtSide={selectedCourtSide}
                  sourceWidth={match.width || 1920}
                  sourceHeight={match.height || 1080}
                  nearColor={nearColor}
                  farColor={farColor}
                  nearLabel={nearLabel}
                  farLabel={farLabel}
                  onRendererReady={(fn) => setSkeletonRenderer(fn)}
                />
              )}

              {showShuttle && hasVisionResults && latestRun && (
                <ShuttleOverlay
                  runId={latestRun.id}
                  enabled={showShuttle}
                  trailLength={15}
                  sourceWidth={match.width || 1920}
                  sourceHeight={match.height || 1080}
                  onRendererReady={(fn) => setShuttleRenderer(fn)}
                />
              )}

              {/* Overlay controls */}
              <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-gray-400 border-t border-gray-800">
                <span className="text-gray-600 font-medium">Overlay</span>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={showSkeleton}
                    onChange={e => setShowSkeleton(e.target.checked)} className="accent-green-500" />
                  Skeleton
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={showBoxes}
                    onChange={e => setShowBoxes(e.target.checked)} className="accent-green-500" />
                  Boxes
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={showTrackIds}
                    onChange={e => setShowTrackIds(e.target.checked)} className="accent-green-500" />
                  IDs
                </label>
                {hasVisionResults && (
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={showShuttle}
                      onChange={e => setShowShuttle(e.target.checked)} className="accent-yellow-400" />
                    Shuttle
                  </label>
                )}
                {selectedCourtSide && (
                  <button onClick={() => setSelectedCourtSide(null)}
                    className="ml-auto text-[10px] rounded border border-gray-700 px-2 py-0.5 text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-colors">
                    Showing {selectedCourtSide === "near" ? "Near" : "Far"} only — show both
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-gray-700 flex items-center justify-center aspect-video">
              <p className="text-gray-500 text-sm">No video available.</p>
            </div>
          )}

          {/* Processing banners */}
          {runIsActive && (
            <div className="space-y-2 pt-1">
              <ProcessingStatus runId={latestRun!.id} onComplete={handleRunComplete} onError={handleRunError} />
              <button onClick={handleCancel} disabled={cancelling}
                className="rounded border border-red-700 px-3 py-1 text-xs text-red-400 hover:bg-red-900/40 disabled:opacity-50 transition-colors">
                {cancelling ? "Cancelling…" : "Cancel processing"}
              </button>
            </div>
          )}
          {(latestRun?.status === "failed" || latestRun?.status === "cancelled") && (
            <div className={`rounded-lg border p-3 space-y-1.5 ${latestRun.status === "failed" ? "border-red-700 bg-red-900/20" : "border-gray-600 bg-gray-800/40"}`}>
              <p className={`text-sm font-medium ${latestRun.status === "failed" ? "text-red-300" : "text-gray-300"}`}>
                {latestRun.status === "failed" ? `Processing failed${latestRun.error_code ? ` (${latestRun.error_code})` : ""}` : "Processing cancelled"}
              </p>
              {latestRun.error_message && latestRun.status === "failed" && (
                <p className="text-xs text-red-400">{latestRun.error_message}</p>
              )}
              <button onClick={handleRetry} disabled={retrying}
                className="rounded border border-gray-600 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-50 transition-colors">
                {retrying ? "Retrying…" : "Re-run processing"}
              </button>
            </div>
          )}

          {/* ── Heatmap section — full width under video ─────────────────── */}
          {hasVisionResults && latestRun && (
            <div className="pt-2 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-200">Movement Heatmap</h2>
                <span className="text-[10px] text-gray-600">Builds as video plays</span>
              </div>
              {/* Two courts side-by-side — one per player */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <p className="text-[11px] text-center font-medium" style={{ color: nearColor }}>
                    Near End · {nearLabel}
                  </p>
                  <CourtHeatmap
                    runId={latestRun.id}
                    courtSide="near"
                    sourceWidth={match.width || 1920}
                    sourceHeight={match.height || 1080}
                    enabled={true}
                    getTimeMs={getVideoTimeMs}
                    playerLabel={nearLabel}
                    playerColor={nearColor}
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-[11px] text-center font-medium" style={{ color: farColor }}>
                    Far End · {farLabel}
                  </p>
                  <CourtHeatmap
                    runId={latestRun.id}
                    courtSide="far"
                    sourceWidth={match.width || 1920}
                    sourceHeight={match.height || 1080}
                    enabled={true}
                    getTimeMs={getVideoTimeMs}
                    playerLabel={farLabel}
                    playerColor={farColor}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Heatmap placeholder before vision */}
          {!hasVisionResults && visionAvailable && (
            <div className="rounded-lg border border-dashed border-gray-700 bg-gray-900/40 p-4 text-center mt-2">
              <p className="text-xs text-gray-500">Run Player & Pose Analysis to unlock movement heatmaps</p>
            </div>
          )}
        </div>

        {/* ── RIGHT — sidebar ───────────────────────────────────────────────── */}
        <div className="w-72 xl:w-80 shrink-0 space-y-3">

          {/* Vision trigger */}
          {visionAvailable && (
            <div className="rounded-lg border border-green-800/60 bg-green-950/30 p-3 space-y-2">
              <h2 className="text-xs font-semibold text-green-400 uppercase tracking-wide">
                Player & Pose Analysis
              </h2>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Detect players, estimate poses, build skeleton overlay and movement heatmaps.
              </p>
              <button onClick={handleStartVision} disabled={visionStarted}
                className="w-full rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {visionStarted ? "Starting…" : "Analyse Players"}
              </button>
            </div>
          )}

          {/* Player identity */}
          {hasVisionResults && latestRun && (
            <PlayerPanel
              runId={latestRun.id}
              sourceHeight={match.height || 1080}
              sourceWidth={match.width || 0}
              onSideSelected={setSelectedCourtSide}
            />
          )}

          {/* ── Player colour + label config ─────────────────────────────── */}
          {hasVisionResults && (
            <div className="rounded-lg border border-gray-700/60 bg-gray-900 p-3 space-y-3">
              <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                Player Display
              </h2>
              {/* Near player row */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: nearColor }} />
                  <span className="text-[11px] text-gray-400 shrink-0">Near End</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={nearColor}
                    onChange={e => setNearColor(e.target.value)}
                    className="w-7 h-7 rounded cursor-pointer border-0 bg-transparent p-0"
                    aria-label="Near player colour"
                    title="Near player colour"
                  />
                  <input
                    type="text"
                    value={nearLabel}
                    onChange={e => setNearLabel(e.target.value.slice(0, 20))}
                    placeholder="Label (e.g. You)"
                    className="flex-1 rounded bg-gray-800 border border-gray-700 px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                  />
                </div>
              </div>
              {/* Far player row */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: farColor }} />
                  <span className="text-[11px] text-gray-400 shrink-0">Far End</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={farColor}
                    onChange={e => setFarColor(e.target.value)}
                    className="w-7 h-7 rounded cursor-pointer border-0 bg-transparent p-0"
                    aria-label="Far player colour"
                    title="Far player colour"
                  />
                  <input
                    type="text"
                    value={farLabel}
                    onChange={e => setFarLabel(e.target.value.slice(0, 20))}
                    placeholder="Label (e.g. Opponent)"
                    className="flex-1 rounded bg-gray-800 border border-gray-700 px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                  />
                </div>
              </div>
              <p className="text-[10px] text-gray-700 leading-relaxed">
                Colours apply to skeleton, bounding box, and heatmap.
              </p>
            </div>
          )}

          {/* Match metadata */}
          <div className="rounded-lg border border-gray-700/60 bg-gray-900 p-3">
            <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2.5">
              Match Details
            </h2>
            <dl className="space-y-1.5 text-xs">
              {[
                ["Duration",   formatDuration(match.duration_ms)],
                ["Resolution", match.width ? `${match.width}×${match.height}` : "—"],
                ["Frame rate", computeFps(match.fps_num, match.fps_den) + " fps"],
                ["Codec",      match.codec ?? "—"],
                ["File size",  formatFileSize(match.file_size_bytes)],
                ["Uploaded",   formatDate(match.uploaded_at)],
                ["Opponent",   match.opponent_label ?? "—"],
                ["Session",    match.session_type ?? "—"],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-2 py-0.5 border-b border-gray-800/50 last:border-0">
                  <dt className="text-gray-500 shrink-0">{label}</dt>
                  <dd className="text-gray-300 text-right truncate">{value}</dd>
                </div>
              ))}
            </dl>
            {match.notes && (
              <div className="mt-3 pt-2 border-t border-gray-800">
                <p className="text-[10px] text-gray-500 mb-1">Notes</p>
                <p className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">{match.notes}</p>
              </div>
            )}
            {match.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {match.tags.map(tag => (
                  <span key={tag} className="rounded-full bg-gray-800 border border-gray-700 px-2 py-0.5 text-[10px] text-gray-400">{tag}</span>
                ))}
              </div>
            )}
          </div>

          {/* Phase 3+ placeholders — stacked in sidebar */}
          <div className="rounded-lg border border-dashed border-gray-800 p-3">
            <p className="text-[10px] text-gray-600 font-medium uppercase tracking-wide mb-2">Coming next</p>
            <div className="space-y-1.5">
              {[
                ["📊", "Shot Timeline",       "Phase 5"],
                ["🎯", "Coaching Analytics",  "Phase 6"],
              ].map(([icon, title, phase]) => (
                <div key={title} className="flex items-center justify-between">
                  <span className="text-xs text-gray-600">{icon} {title}</span>
                  <span className="text-[10px] text-gray-700">{phase}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

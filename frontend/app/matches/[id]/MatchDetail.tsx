/**
 * MatchDetail — client component for the match analysis page.
 *
 * Phase 1: video playback + match metadata + processing status.
 * Phase 2: player detection/pose analysis trigger + skeleton overlay + player identity.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnalysisRunRead, MatchRead } from "@/types/api";
import apiClient from "@/lib/api";
import VideoPlayer from "@/components/VideoPlayer/VideoPlayer";
import ProcessingStatus from "@/components/ProcessingStatus/ProcessingStatus";
import SkeletonOverlay from "@/components/SkeletonOverlay/SkeletonOverlay";
import PlayerPanel from "@/components/PlayerPanel/PlayerPanel";
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

  // Phase 2 state.
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [showBoxes, setShowBoxes] = useState(true);
  const [showTrackIds, setShowTrackIds] = useState(true);
  const [visionStarted, setVisionStarted] = useState(false);
  const [overlayRenderer, setOverlayRenderer] = useState<
    ((ctx: CanvasRenderingContext2D, currentTime: number) => void) | null
  >(null);

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
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
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
        <div className="flex gap-2">
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

      {/* Video player — shown as soon as the source asset exists, even before ingestion completes */}
      {match.source_asset_id ? (
        <div className="space-y-2">
          <VideoPlayer
            assetId={match.source_asset_id}
            renderOverlay={overlayRenderer ?? undefined}
          />
          {/* Phase 2 overlay controls */}
          {showSkeleton && latestRun && (
            <SkeletonOverlay
              runId={latestRun.id}
              enabled={showSkeleton}
              showBoxes={showBoxes}
              showTrackIds={showTrackIds}
              sourceWidth={match.width || 1920}
              sourceHeight={match.height || 1080}
              onRendererReady={setOverlayRenderer}
            />
          )}
          {/* Overlay toggles */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-gray-400">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={showSkeleton}
                onChange={(e) => setShowSkeleton(e.target.checked)}
                className="accent-green-500" />
              Skeleton
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={showBoxes}
                onChange={(e) => setShowBoxes(e.target.checked)}
                className="accent-green-500" />
              Bounding boxes
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={showTrackIds}
                onChange={(e) => setShowTrackIds(e.target.checked)}
                className="accent-green-500" />
              Track IDs
            </label>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-700 flex items-center justify-center aspect-video">
          <p className="text-gray-500 text-sm">No video available.</p>
        </div>
      )}

      {/* Active run progress */}
      {runIsActive && (
        <ProcessingStatus
          runId={latestRun!.id}
          onComplete={handleRunComplete}
          onError={handleRunError}
        />
      )}

      {/* Failed run */}
      {latestRun?.status === "failed" && (
        <div className="rounded-lg border border-red-700 bg-red-900/20 p-4 space-y-2">
          <p className="text-sm font-medium text-red-300">
            Processing failed{latestRun.error_code ? ` (${latestRun.error_code})` : ""}
          </p>
          {latestRun.error_message && (
            <p className="text-xs text-red-400">{latestRun.error_message}</p>
          )}
          <button onClick={handleRetry} disabled={retrying}
            className="mt-2 rounded border border-red-600 px-3 py-1 text-xs text-red-300 hover:bg-red-900/40 disabled:opacity-50 transition-colors">
            {retrying ? "Retrying…" : "Retry processing"}
          </button>
        </div>
      )}

      {/* Phase 2: Vision analysis trigger */}
      {visionAvailable && (
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-300">Player & Pose Analysis</h2>
          <p className="text-xs text-gray-500">
            Detect both players, estimate body poses, and display a green skeleton overlay.
            Processing happens in the background — you can leave this page.
          </p>
          <button
            onClick={handleStartVision}
            disabled={visionStarted}
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {visionStarted ? "Starting…" : "Analyse Players"}
          </button>
        </div>
      )}

      {/* Phase 2: Player identity panel */}
      {hasVisionResults && latestRun && (
        <PlayerPanel runId={latestRun.id} />
      )}

      {/* Match metadata */}
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-3">Match Details</h2>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          {[
            ["Duration", formatDuration(match.duration_ms)],
            ["Resolution", match.width ? `${match.width}×${match.height}` : "—"],
            ["Frame rate", computeFps(match.fps_num, match.fps_den) + " fps"],
            ["Codec", match.codec ?? "—"],
            ["File size", formatFileSize(match.file_size_bytes)],
            ["Uploaded", formatDate(match.uploaded_at)],
            ["Opponent", match.opponent_label ?? "—"],
            ["Session type", match.session_type ?? "—"],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-gray-500">{label}</dt>
              <dd className="text-gray-200">{value}</dd>
            </div>
          ))}
        </dl>
        {match.notes && (
          <div className="mt-4">
            <dt className="text-xs text-gray-500 mb-1">Notes</dt>
            <dd className="text-sm text-gray-300 whitespace-pre-wrap">{match.notes}</dd>
          </div>
        )}
        {match.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {match.tags.map((tag) => (
              <span key={tag} className="rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-300">{tag}</span>
            ))}
          </div>
        )}
      </div>

      {/* Phase 3+ placeholders */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[
          { title: "Court View & Movement", phase: "Phase 3" },
          { title: "Shuttle Tracking", phase: "Phase 4" },
          { title: "Shot Timeline", phase: "Phase 5" },
          { title: "Coaching & Analytics", phase: "Phase 6" },
        ].map(({ title, phase }) => (
          <div key={title} className="rounded-lg border border-dashed border-gray-700 p-6 text-center">
            <p className="text-sm font-medium text-gray-400">{title}</p>
            <p className="mt-1 text-xs text-gray-600">{phase}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

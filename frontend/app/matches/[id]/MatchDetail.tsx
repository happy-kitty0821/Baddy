/**
 * MatchDetail — client component for the match analysis page.
 * Receives the match ID as a prop from the server page component.
 *
 * Analysis run behaviour:
 *   - On mount, fetches the match and then its latest analysis run.
 *   - If the run is in a non-terminal state, ProcessingStatus polls for updates.
 *   - When the run completes, the match is refreshed to reflect the new status.
 *   - Opening a completed match does NOT create a new run.
 *   - The retry button is shown only for FAILED runs.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnalysisRunRead, MatchRead } from "@/types/api";
import apiClient from "@/lib/api";
import VideoPlayer from "@/components/VideoPlayer/VideoPlayer";
import ProcessingStatus from "@/components/ProcessingStatus/ProcessingStatus";
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

  // Fetch match + latest run on mount (and whenever id changes).
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const m = await apiClient.getMatch(id);
        if (cancelled) return;
        setMatch(m);

        // Fetch the latest analysis run.  A 404 means no run exists yet.
        try {
          const run = await apiClient.getLatestAnalysis(id);
          if (!cancelled) setLatestRun(run);
        } catch {
          // No run exists; leave latestRun as null.
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

  // Called when ProcessingStatus detects the run has completed.
  const handleRunComplete = useCallback(async (run: AnalysisRunRead) => {
    setLatestRun(run);
    // Refresh the match to pick up updated status and metadata.
    try {
      const m = await apiClient.getMatch(id);
      setMatch(m);
    } catch {
      // Non-fatal; match data will be stale but still displayed.
    }
  }, [id]);

  // Called when ProcessingStatus detects the run has failed.
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

  const handleDelete = async () => {
    if (!match) return;
    try {
      await apiClient.deleteMatch(match.id);
      router.push("/library");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-20 text-gray-500 animate-pulse">
        Loading match…
      </div>
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

  // Show the processing status block whenever there is an active (non-terminal) run.
  const runIsActive = latestRun && !TERMINAL_STATUSES.has(latestRun.status);

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
              <span className="text-sm text-gray-400">
                {formatDate(match.recorded_at)}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {!deleteConfirm ? (
            <button
              onClick={() => setDeleteConfirm(true)}
              className="rounded border border-red-700 px-3 py-1 text-xs text-red-400 hover:bg-red-900/40 transition-colors"
            >
              Delete
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-300">Delete this match permanently?</span>
              <button
                onClick={handleDelete}
                className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-500"
              >
                Confirm
              </button>
              <button
                onClick={() => setDeleteConfirm(false)}
                className="rounded border border-gray-600 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Video player — only shown when a source asset exists and not still pending */}
      {match.source_asset_id && match.status !== "pending" ? (
        <VideoPlayer assetId={match.source_asset_id} />
      ) : (
        <div className="rounded-lg border border-dashed border-gray-700 flex items-center justify-center aspect-video">
          <p className="text-gray-500 text-sm">
            {match.status === "pending"
              ? "Video is being prepared…"
              : "No video available."}
          </p>
        </div>
      )}

      {/* Active run: show live progress */}
      {runIsActive && (
        <ProcessingStatus
          runId={latestRun!.id}
          onComplete={handleRunComplete}
          onError={handleRunError}
        />
      )}

      {/* Failed run: show error and retry */}
      {latestRun?.status === "failed" && (
        <div className="rounded-lg border border-red-700 bg-red-900/20 p-4 space-y-2">
          <p className="text-sm font-medium text-red-300">
            Processing failed
            {latestRun.error_code ? ` (${latestRun.error_code})` : ""}
          </p>
          {latestRun.error_message && (
            <p className="text-xs text-red-400">{latestRun.error_message}</p>
          )}
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="mt-2 rounded border border-red-600 px-3 py-1 text-xs text-red-300 hover:bg-red-900/40 disabled:opacity-50 transition-colors"
          >
            {retrying ? "Retrying…" : "Retry processing"}
          </button>
        </div>
      )}

      {/* Match metadata */}
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-3">
          Match Details
        </h2>
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
              <span
                key={tag}
                className="rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-300"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Phase 2+ placeholders */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[
          { title: "Skeleton Overlay", phase: "Phase 2" },
          { title: "Court View & Movement", phase: "Phase 3" },
          { title: "Shuttle Tracking", phase: "Phase 4" },
          { title: "Shot Timeline & Coaching", phase: "Phases 5–6" },
        ].map(({ title, phase }) => (
          <div
            key={title}
            className="rounded-lg border border-dashed border-gray-700 p-6 text-center"
          >
            <p className="text-sm font-medium text-gray-400">{title}</p>
            <p className="mt-1 text-xs text-gray-600">{phase}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

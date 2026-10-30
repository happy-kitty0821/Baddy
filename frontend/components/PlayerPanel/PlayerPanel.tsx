/**
 * PlayerPanel — court-half player identity assignment.
 *
 * Instead of showing a list of 60+ ByteTrack IDs, this component:
 *   1. Calls POST /api/analyses/{run_id}/assign-court-halves which
 *      automatically groups all tracks into Near-End and Far-End using
 *      median vertical bounding-box position.
 *   2. Shows two clear buttons: "I am the Near-End player" and
 *      "I am the Far-End player".
 *   3. Marks the selected track as is_selected_player=true.
 *
 * Near End  = closer to the camera (larger in frame, bottom of overhead view)
 * Far End   = further from camera (smaller in frame, top of overhead view)
 *
 * For side-on footage, the axis switches to X (left vs right half).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { CourtHalfAssignment, PlayerTrack } from "@/types/api";
import apiClient from "@/lib/api";

interface PlayerPanelProps {
  runId: string;
  sourceHeight?: number;
  sourceWidth?: number;
  onSideSelected?: (side: "near" | "far" | null) => void;
  onTracksUpdated?: () => void;
}

export default function PlayerPanel({
  runId,
  sourceHeight = 1080,
  sourceWidth = 0,
  onSideSelected,
  onTracksUpdated,
}: PlayerPanelProps) {
  const [assignment, setAssignment] = useState<CourtHalfAssignment | null>(null);
  const [loading, setLoading] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAutoAssign = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiClient.assignCourtHalves(runId, sourceHeight, sourceWidth);
      setAssignment(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [runId, sourceHeight]);

  // Auto-assign on mount.
  useEffect(() => {
    runAutoAssign();
  }, [runAutoAssign]);

  const handleSelectMe = async (track: PlayerTrack | null | undefined) => {
    if (!track || !assignment) return;
    setSelecting(true);
    setError(null);
    try {
      // Mark selected track as "Me".
      await apiClient.updatePlayerIdentity(runId, track.id, {
        is_selected_player: true,
      });
      // Mark the other canonical track as not-me.
      const other =
        assignment.near_end?.id === track.id
          ? assignment.far_end
          : assignment.near_end;
      if (other && other.is_selected_player) {
        await apiClient.updatePlayerIdentity(runId, other.id, {
          is_selected_player: false,
        });
      }
      // Determine which court side was selected and notify parent.
      const side = assignment.near_end?.id === track.id ? "near" : "far";
      onSideSelected?.(side);
      // Refresh the assignment.
      await runAutoAssign();
      onTracksUpdated?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSelecting(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <p className="text-sm text-gray-500 animate-pulse">Identifying players…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-2">
        <p className="text-sm text-red-300">Could not identify players: {error}</p>
        <button
          onClick={runAutoAssign}
          className="text-xs text-gray-400 underline hover:text-gray-200"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!assignment || (!assignment.near_end && !assignment.far_end)) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <p className="text-sm text-gray-500">No player tracks found.</p>
        <p className="text-xs text-gray-600 mt-1">
          Run player analysis first.
        </p>
      </div>
    );
  }

  const axisLabel = assignment.axis === "x" ? "Left / Right" : "Near / Far";
  // Backend assigns: near_end = bottom half (landscape) or right_side (portrait)
  // far_end = top half (landscape) or left_side (portrait)
  const nearLabel = assignment.axis === "x" ? "Right Side" : "Near End";
  const farLabel = assignment.axis === "x" ? "Left Side" : "Far End";
  const nearSub = assignment.axis === "x"
    ? "Right half of frame"
    : "Closer to camera (larger in frame)";
  const farSub = assignment.axis === "x"
    ? "Left half of frame"
    : "Further from camera (smaller in frame)";

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-300">Which player are you?</h3>
        <p className="text-xs text-gray-500 mt-1">
          Players were automatically assigned by court position ({axisLabel}).
          Select the half you played from.
        </p>
        {assignment.ambiguous && (
          <p className="text-xs text-yellow-500 mt-1">
            ⚠ Could not clearly identify two players — assignment may be inaccurate.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Near End */}
        <CourtHalfButton
          label={nearLabel}
          sublabel={nearSub}
          track={assignment.near_end}
          isMe={assignment.near_end?.is_selected_player ?? false}
          disabled={selecting}
          onSelect={() => handleSelectMe(assignment.near_end)}
        />

        {/* Far End */}
        <CourtHalfButton
          label={farLabel}
          sublabel={farSub}
          track={assignment.far_end}
          isMe={assignment.far_end?.is_selected_player ?? false}
          disabled={selecting}
          onSelect={() => handleSelectMe(assignment.far_end)}
        />
      </div>

      <button
        onClick={runAutoAssign}
        disabled={loading || assigning}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        Re-detect players
      </button>
    </div>
  );
}

interface CourtHalfButtonProps {
  label: string;
  sublabel: string;
  track: PlayerTrack | null | undefined;
  isMe: boolean;
  disabled: boolean;
  onSelect: () => void;
}

function CourtHalfButton({
  label,
  sublabel,
  track,
  isMe,
  disabled,
  onSelect,
}: CourtHalfButtonProps) {
  if (!track) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-800 p-4 text-center opacity-50">
        <p className="text-sm text-gray-400">{label}</p>
        <p className="text-xs text-gray-600 mt-1">Not detected</p>
      </div>
    );
  }

  return (
    <button
      onClick={onSelect}
      disabled={disabled || isMe}
      className={`rounded-lg border p-4 text-center transition-colors w-full ${
        isMe
          ? "border-green-600 bg-green-900/30 cursor-default"
          : "border-gray-600 bg-gray-800 hover:border-green-700 hover:bg-gray-700"
      } disabled:opacity-60`}
      aria-pressed={isMe}
    >
      <div className="text-base font-semibold text-white">
        {label}
        {isMe && <span className="ml-2 text-green-400">✓</span>}
      </div>
      <div className="text-xs text-gray-400 mt-1">{sublabel}</div>
      {isMe ? (
        <div className="text-xs text-green-400 mt-2 font-medium">This is me</div>
      ) : (
        <div className="text-xs text-gray-500 mt-2">Tap to select</div>
      )}
    </button>
  );
}

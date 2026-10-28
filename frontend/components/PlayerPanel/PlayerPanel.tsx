/**
 * PlayerPanel — shows detected player tracks and lets the user mark
 * which track represents them ("Me").
 *
 * Calls PATCH /api/analyses/{run_id}/tracks/{track_id} to update
 * is_selected_player. Only one track can be "Me" at a time.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlayerTrack } from "@/types/api";
import apiClient from "@/lib/api";

interface PlayerPanelProps {
  runId: string;
  onTracksUpdated?: () => void;
}

export default function PlayerPanel({ runId, onTracksUpdated }: PlayerPanelProps) {
  const [tracks, setTracks] = useState<PlayerTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  const fetchTracks = useCallback(() => {
    apiClient
      .getTracks(runId)
      .then(setTracks)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [runId]);

  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  const handleSelectMe = async (trackId: string) => {
    setUpdating(true);
    try {
      // Set the selected track to true and all others to false.
      for (const t of tracks) {
        if (t.id === trackId) {
          await apiClient.updatePlayerIdentity(runId, t.id, {
            is_selected_player: true,
          });
        } else if (t.is_selected_player) {
          await apiClient.updatePlayerIdentity(runId, t.id, {
            is_selected_player: false,
          });
        }
      }
      fetchTracks();
      onTracksUpdated?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <p className="text-sm text-gray-500 animate-pulse">Loading player tracks…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <p className="text-sm text-red-300">Error: {error}</p>
      </div>
    );
  }

  if (tracks.length === 0) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <p className="text-sm text-gray-500">No player tracks detected yet.</p>
        <p className="text-xs text-gray-600 mt-1">
          Run player analysis to detect and track players.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-300">Player Identity</h3>
      <p className="text-xs text-gray-500">
        Select which tracked player is you. This assignment is used for
        future coaching analysis.
      </p>
      <div className="space-y-2">
        {tracks.map((t) => (
          <div
            key={t.id}
            className={`flex items-center justify-between rounded-md border px-3 py-2 ${
              t.is_selected_player
                ? "border-green-600 bg-green-900/20"
                : "border-gray-700 bg-gray-800"
            }`}
          >
            <div>
              <span className="text-sm text-gray-200">{t.track_label}</span>
              {t.is_selected_player && (
                <span className="ml-2 text-xs text-green-400 font-medium">✓ Me</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {t.identity_confidence != null && (
                <span className="text-xs text-gray-500">
                  conf: {(t.identity_confidence * 100).toFixed(0)}%
                </span>
              )}
              {!t.is_selected_player && (
                <button
                  onClick={() => handleSelectMe(t.id)}
                  disabled={updating}
                  className="rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-50 transition-colors"
                >
                  Mark as Me
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

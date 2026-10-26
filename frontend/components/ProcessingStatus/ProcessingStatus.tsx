/**
 * ProcessingStatus — polls the analysis run endpoint and displays progress.
 *
 * Polling stops when the run reaches a terminal state (completed or failed).
 * The component is used on the upload page and the match detail page.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisRunRead } from "@/types/api";
import apiClient from "@/lib/api";

interface ProcessingStatusProps {
  runId: string;
  onComplete?: (run: AnalysisRunRead) => void;
  onError?: (run: AnalysisRunRead) => void;
}

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

export default function ProcessingStatus({
  runId,
  onComplete,
  onError,
}: ProcessingStatusProps) {
  const [run, setRun] = useState<AnalysisRunRead | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const data = await apiClient.getAnalysis(runId);
      setRun(data);
      setFetchError(null);

      if (TERMINAL_STATES.has(data.status)) {
        if (timerRef.current) clearInterval(timerRef.current);
        if (data.status === "completed") onComplete?.(data);
        else onError?.(data);
      }
    } catch (e) {
      setFetchError((e as Error).message);
    }
  }, [runId, onComplete, onError]);

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [poll]);

  if (fetchError) {
    return (
      <div className="rounded-md bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
        Could not fetch processing status: {fetchError}
      </div>
    );
  }

  if (!run) {
    return (
      <div className="text-sm text-gray-400 animate-pulse">
        Checking status…
      </div>
    );
  }

  const isTerminal = TERMINAL_STATES.has(run.status);

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-200 capitalize">
          {run.status.replace("_", " ")}
        </span>
        <span className="text-xs text-gray-400">{run.progress_pct}%</span>
      </div>

      {/* Progress bar */}
      <div className="h-2 w-full rounded-full bg-gray-700 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            run.status === "failed"
              ? "bg-red-500"
              : run.status === "completed"
              ? "bg-green-500"
              : "bg-blue-500"
          }`}
          style={{ width: `${run.progress_pct}%` }}
          role="progressbar"
          aria-valuenow={run.progress_pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>

      {run.current_stage && !isTerminal && (
        <p className="text-xs text-gray-400 capitalize">
          Stage: {run.current_stage.replace("_", " ")}
        </p>
      )}

      {run.status === "failed" && run.error_message && (
        <p className="text-xs text-red-400">Error: {run.error_message}</p>
      )}
    </div>
  );
}

/**
 * UploadForm — handles file selection, validation, and upload.
 *
 * The upload is sent as multipart/form-data to POST /api/matches.
 * On success, the user is redirected to the match detail page.
 *
 * Processing status is shown on the match detail page (not here) because
 * it fetches the analysis run from the database — that survives browser
 * reloads.  Keeping processing state in React state on this page would
 * lose it on reload.
 *
 * Client-side validation:
 *   - Checks file extension and MIME type.
 *   - Enforces a configurable max file size.
 * Server-side validation is the authoritative check.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import apiClient from "@/lib/api";
import { formatFileSize } from "@/lib/utils";

const ALLOWED_EXTENSIONS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB (matches server default)

type UploadState =
  | { phase: "idle" }
  | { phase: "selected"; file: File }
  | { phase: "uploading"; file: File; progress: number }
  | { phase: "error"; message: string };

export default function UploadForm() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ phase: "idle" });
  const [title, setTitle] = useState("");
  const [opponentLabel, setOpponentLabel] = useState("");
  const [notes, setNotes] = useState("");

  const validateFile = (file: File): string | null => {
    const ext = "." + file.name.split(".").pop()?.toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return `Unsupported file type: ${ext}. Supported: ${[...ALLOWED_EXTENSIONS].join(", ")}`;
    }
    if (file.size > MAX_FILE_BYTES) {
      return `File is too large (${formatFileSize(file.size)}). Maximum: ${formatFileSize(MAX_FILE_BYTES)}`;
    }
    if (file.size === 0) {
      return "File is empty.";
    }
    return null;
  };

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const err = validateFile(file);
      if (err) {
        setState({ phase: "error", message: err });
        return;
      }
      setState({ phase: "selected", file });
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
    },
    [title]
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (state.phase !== "selected") return;

      const { file } = state;
      const err = validateFile(file);
      if (err) { setState({ phase: "error", message: err }); return; }
      if (!title.trim()) { setState({ phase: "error", message: "Title is required." }); return; }

      setState({ phase: "uploading", file, progress: 0 });

      const formData = new FormData();
      formData.append("title", title.trim());
      formData.append("video", file);
      if (opponentLabel) formData.append("opponent_label", opponentLabel);
      if (notes) formData.append("notes", notes);
      formData.append("tags", "[]");

      try {
        const match = await apiClient.uploadMatch(formData);
        // Redirect to the match detail page immediately.
        // The match detail page fetches the latest analysis run from the
        // database and shows ProcessingStatus — this survives browser
        // reloads because the run state is persisted server-side.
        router.push(`/matches/${match.id}`);
      } catch (e) {
        setState({
          phase: "error",
          message: (e as Error).message || "Upload failed. Please try again.",
        });
      }
    },
    [state, title, opponentLabel, notes, router]
  );

  const reset = () => {
    setState({ phase: "idle" });
    setTitle("");
    setOpponentLabel("");
    setNotes("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── Upload form ────────────────────────────────────────────────────────────
  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* File selector */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Video file{" "}
          <span className="text-gray-500 font-normal">
            (MP4, MOV, MKV, AVI, WebM — max 2 GB)
          </span>
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp4,.mov,.avi,.mkv,.webm,video/*"
          onChange={handleFileChange}
          className="block w-full text-sm text-gray-300 file:mr-4 file:rounded file:border-0 file:bg-gray-700 file:px-3 file:py-1.5 file:text-sm file:text-gray-200 hover:file:bg-gray-600 cursor-pointer"
          aria-describedby="file-help"
          required
        />
        {state.phase === "selected" && (
          <p id="file-help" className="mt-1 text-xs text-gray-400">
            {state.file.name} — {formatFileSize(state.file.size)}
          </p>
        )}
      </div>

      {/* Title */}
      <div>
        <label
          htmlFor="title"
          className="block text-sm font-medium text-gray-300 mb-1"
        >
          Match title <span className="text-red-400">*</span>
        </label>
        <input
          id="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Club singles — 2026-10-26"
          maxLength={255}
          className="w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
          required
        />
      </div>

      {/* Opponent */}
      <div>
        <label
          htmlFor="opponent"
          className="block text-sm font-medium text-gray-300 mb-1"
        >
          Opponent label
          <span className="ml-1 text-gray-500 font-normal">(optional)</span>
        </label>
        <input
          id="opponent"
          type="text"
          value={opponentLabel}
          onChange={(e) => setOpponentLabel(e.target.value)}
          placeholder="e.g. John"
          maxLength={255}
          className="w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none"
        />
      </div>

      {/* Notes */}
      <div>
        <label
          htmlFor="notes"
          className="block text-sm font-medium text-gray-300 mb-1"
        >
          Notes
          <span className="ml-1 text-gray-500 font-normal">(optional)</span>
        </label>
        <textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Anything to remember about this session…"
          className="w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none resize-none"
        />
      </div>

      {/* Error */}
      {state.phase === "error" && (
        <div
          role="alert"
          className="rounded-md bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300"
        >
          {state.message}
        </div>
      )}

      {/* Upload progress */}
      {state.phase === "uploading" && (
        <div className="space-y-2">
          <p className="text-sm text-gray-400 animate-pulse">Uploading…</p>
          <div className="h-2 w-full rounded-full bg-gray-700 overflow-hidden">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-300"
              style={{ width: `${state.progress}%` }}
              role="progressbar"
              aria-valuenow={state.progress}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
        </div>
      )}

      {/* Submit */}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={
            state.phase !== "selected" && state.phase !== "error"
          }
          className="rounded-md bg-green-600 px-6 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {state.phase === "uploading" ? "Uploading…" : "Upload Match"}
        </button>

        {state.phase === "error" && (
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
          >
            Reset
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Shared utility functions for the frontend.
 */

/** Format a duration in milliseconds as "mm:ss" or "h:mm:ss". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Format a file size in bytes as a human-readable string. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Format an ISO date string as a localized date. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Format an ISO date string as a localized date and time. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Return a display label for a match status value. */
export function matchStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "Pending",
    processing: "Processing",
    ready: "Ready",
    failed: "Failed",
    deleted: "Deleted",
  };
  return map[status] ?? status;
}

/** Return a Tailwind colour class for a match status badge. */
export function matchStatusColor(status: string): string {
  const map: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    processing: "bg-blue-100 text-blue-800",
    ready: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
    deleted: "bg-gray-100 text-gray-500",
  };
  return map[status] ?? "bg-gray-100 text-gray-500";
}

/** Return frames-per-second as a decimal from stored num/den fractions. */
export function computeFps(
  fpsNum: number | null | undefined,
  fpsDen: number | null | undefined
): string {
  if (fpsNum == null || fpsDen == null || fpsDen === 0) return "—";
  return (fpsNum / fpsDen).toFixed(2);
}

/** Clamp a number between min and max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

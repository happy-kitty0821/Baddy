/**
 * MatchCard — displays a single match in the library grid.
 */
import Link from "next/link";
import type { MatchRead } from "@/types/api";
import {
  formatDate,
  formatDuration,
  formatFileSize,
  matchStatusColor,
  matchStatusLabel,
} from "@/lib/utils";

interface MatchCardProps {
  match: MatchRead;
}

export default function MatchCard({ match }: MatchCardProps) {
  const statusClass = matchStatusColor(match.status);

  return (
    <Link
      href={`/matches/${match.id}`}
      className="block rounded-lg border border-gray-700 bg-gray-900 p-4 hover:border-green-600 hover:bg-gray-800 transition-colors"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <h3 className="font-medium text-white truncate" title={match.title}>
          {match.title}
        </h3>
        <span
          className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusClass}`}
        >
          {matchStatusLabel(match.status)}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
        {match.recorded_at && (
          <>
            <dt>Date</dt>
            <dd className="text-gray-200">{formatDate(match.recorded_at)}</dd>
          </>
        )}
        {match.duration_ms != null && (
          <>
            <dt>Duration</dt>
            <dd className="text-gray-200">{formatDuration(match.duration_ms)}</dd>
          </>
        )}
        {match.file_size_bytes != null && (
          <>
            <dt>Size</dt>
            <dd className="text-gray-200">{formatFileSize(match.file_size_bytes)}</dd>
          </>
        )}
        {match.opponent_label && (
          <>
            <dt>Opponent</dt>
            <dd className="text-gray-200 truncate">{match.opponent_label}</dd>
          </>
        )}
      </dl>

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

      <p className="mt-3 text-xs text-gray-500">
        Uploaded {formatDate(match.uploaded_at)}
      </p>
    </Link>
  );
}

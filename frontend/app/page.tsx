/**
 * Dashboard page — entry point of the application.
 *
 * Phase 1: shows recent matches and links to upload and library.
 * Phase 2+: will include processing job status and historical trends.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { MatchRead } from "@/types/api";
import apiClient from "@/lib/api";
import MatchCard from "@/components/MatchCard/MatchCard";
import { formatDateTime } from "@/lib/utils";

export default function DashboardPage() {
  const [recentMatches, setRecentMatches] = useState<MatchRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .listMatches({ page: 1, page_size: 6 })
      .then((res) => setRecentMatches(res.items))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-400">
            Your badminton analysis workspace.
          </p>
        </div>
        <Link
          href="/upload"
          className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 transition-colors"
        >
          Upload Match
        </Link>
      </div>

      {/* Recent matches */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-200">Recent Matches</h2>
          <Link href="/library" className="text-sm text-green-400 hover:text-green-300">
            View all →
          </Link>
        </div>

        {loading && (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        )}

        {error && (
          <div className="rounded-md bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
            Could not load matches: {error}
          </div>
        )}

        {!loading && !error && recentMatches.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-700 px-8 py-16 text-center">
            <p className="text-gray-400 mb-4">No matches yet.</p>
            <Link
              href="/upload"
              className="inline-flex rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500"
            >
              Upload your first match
            </Link>
          </div>
        )}

        {!loading && recentMatches.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {recentMatches.map((match) => (
              <MatchCard key={match.id} match={match} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

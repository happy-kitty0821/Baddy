/**
 * Match library page — searchable, paginated list of all uploaded matches.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { MatchListResponse, MatchRead } from "@/types/api";
import apiClient from "@/lib/api";
import MatchCard from "@/components/MatchCard/MatchCard";

export default function LibraryPage() {
  const [data, setData] = useState<MatchListResponse | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchMatches = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiClient.listMatches({
        page,
        page_size: 12,
        search: debouncedSearch || undefined,
      });
      setData(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch]);

  useEffect(() => {
    fetchMatches();
  }, [fetchMatches]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Match Library</h1>
        <Link
          href="/upload"
          className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 transition-colors"
        >
          Upload Match
        </Link>
      </div>

      {/* Search */}
      <input
        type="search"
        placeholder="Search by title or opponent…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full max-w-md rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none"
        aria-label="Search matches"
      />

      {/* Loading */}
      {loading && (
        <div className="text-center py-12 text-gray-500 animate-pulse">
          Loading matches…
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-md bg-red-900/40 border border-red-700 px-4 py-3 text-sm text-red-300">
          {error}
          <button
            onClick={fetchMatches}
            className="ml-3 underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Results */}
      {!loading && data && (
        <>
          <p className="text-xs text-gray-400">
            {data.total} {data.total === 1 ? "match" : "matches"}
            {debouncedSearch ? ` matching "${debouncedSearch}"` : ""}
          </p>

          {data.items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-700 py-16 text-center">
              <p className="text-gray-400 mb-4">
                {debouncedSearch
                  ? `No matches found for "${debouncedSearch}".`
                  : "No matches yet."}
              </p>
              {!debouncedSearch && (
                <Link
                  href="/upload"
                  className="inline-flex rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500"
                >
                  Upload your first match
                </Link>
              )}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {data.items.map((match) => (
                <MatchCard key={match.id} match={match} />
              ))}
            </div>
          )}

          {/* Pagination */}
          {data.total_pages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-40"
                aria-label="Previous page"
              >
                ← Prev
              </button>
              <span className="text-sm text-gray-400">
                Page {page} of {data.total_pages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(data.total_pages, p + 1))}
                disabled={page === data.total_pages}
                className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-40"
                aria-label="Next page"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

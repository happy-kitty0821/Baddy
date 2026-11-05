"use client";

import { useEffect } from "react";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error("Unhandled error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center px-4">
      <div className="rounded-lg border border-red-700 bg-red-900/20 p-6 max-w-md w-full">
        <h2 className="text-lg font-semibold text-red-300 mb-2">Something went wrong</h2>
        <p className="text-sm text-red-400 mb-4">
          {error.message || "An unexpected error occurred."}
        </p>
        <button
          onClick={reset}
          className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

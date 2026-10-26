/**
 * Login page.
 *
 * Calls POST /api/auth/login, stores the returned JWT, then redirects to
 * the dashboard.  The token is stored in localStorage via apiClient.
 *
 * Security notes:
 *   - Credentials are sent only over the configured API origin.
 *   - The token is never written to any log or error message.
 *   - An invalid credential message is deliberately generic.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import apiClient from "@/lib/api";
import { storeToken, validateToken } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const usernameRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingToken, setCheckingToken] = useState(true);

  // If a valid token is already stored, skip the login page.
  useEffect(() => {
    validateToken().then((user) => {
      if (user) {
        router.replace("/");
      } else {
        setCheckingToken(false);
        usernameRef.current?.focus();
      }
    });
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await apiClient.login(username, password);
      // apiClient.login already calls setToken internally; also use our helper
      // to keep lib/auth in sync.
      storeToken(result.access_token);
      router.replace("/");
    } catch (err) {
      // Use a generic message — never echo back credential details.
      setError("Invalid username or password.");
    } finally {
      setLoading(false);
    }
  };

  if (checkingToken) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-sm text-gray-500 animate-pulse">Checking session…</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-sm rounded-lg border border-gray-700 bg-gray-900 p-8 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-white">Sign in</h1>
          <p className="mt-1 text-sm text-gray-400">
            Badminton AI Coach — personal account
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="username"
              className="block text-sm font-medium text-gray-300 mb-1"
            >
              Username
            </label>
            <input
              ref={usernameRef}
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              disabled={loading}
              className="w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500 disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-300 mb-1"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
              className="w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500 disabled:opacity-50"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-md bg-red-900/40 border border-red-700 px-3 py-2 text-sm text-red-300"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full rounded-md bg-green-600 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="text-xs text-gray-600 text-center">
          Credentials are set in the server&apos;s <code>.env</code> file.
        </p>
      </div>
    </div>
  );
}

/**
 * AuthGuard — redirects to /login when no valid token is present.
 *
 * Rendered inside the root layout, wrapping every page except /login itself.
 * Uses validateToken() which calls /api/auth/me so stale/expired tokens are
 * caught before the user sees a broken API response.
 */
"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { validateToken } from "@/lib/auth";
import apiClient from "@/lib/api";

const PUBLIC_PATHS = new Set(["/login"]);

interface AuthGuardProps {
  children: React.ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (PUBLIC_PATHS.has(pathname)) {
      setReady(true);
      return;
    }

    validateToken().then((user) => {
      if (!user) {
        router.replace("/login");
      } else {
        setReady(true);
      }
    });
  }, [pathname, router]);

  if (!ready && !PUBLIC_PATHS.has(pathname)) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-sm text-gray-500 animate-pulse">Loading…</div>
      </div>
    );
  }

  return <>{children}</>;
}

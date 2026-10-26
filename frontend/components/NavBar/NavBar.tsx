/**
 * NavBar — top navigation with logout button.
 * Hidden on the /login page.
 */
"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import apiClient from "@/lib/api";
import { removeToken } from "@/lib/auth";

export default function NavBar() {
  const pathname = usePathname();
  const router = useRouter();

  // Don't render the nav on the login page.
  if (pathname === "/login") return null;

  const handleLogout = () => {
    apiClient.logout();
    removeToken();
    router.replace("/login");
  };

  return (
    <nav className="border-b border-gray-800 bg-gray-900">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/" className="text-lg font-semibold text-white">
              🏸 Badminton AI Coach
            </Link>
            <div className="hidden sm:flex items-center gap-6 text-sm">
              <Link
                href="/library"
                className="text-gray-300 hover:text-white transition-colors"
              >
                Library
              </Link>
              <Link
                href="/upload"
                className="text-gray-300 hover:text-white transition-colors"
              >
                Upload
              </Link>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="text-xs text-gray-400 hover:text-white transition-colors"
            aria-label="Sign out"
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}

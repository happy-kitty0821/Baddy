/**
 * Client-side authentication helpers.
 *
 * The JWT is stored in localStorage under TOKEN_KEY.
 * - setToken / clearToken are the only places that touch storage.
 * - isAuthenticated checks for a token and validates it against /api/auth/me.
 * - The token is never logged or included in error messages.
 */
import apiClient from "@/lib/api";

export const TOKEN_KEY = "bac_token";

/** Store the JWT returned by the login endpoint. */
export function storeToken(token: string): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(TOKEN_KEY, token);
  }
}

/** Remove the stored JWT (logout). */
export function removeToken(): void {
  if (typeof window !== "undefined") {
    localStorage.removeItem(TOKEN_KEY);
  }
}

/** Return the stored JWT, or null if none is present. */
export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Validate the stored token against the /api/auth/me endpoint.
 * Returns the username on success, or null if the token is absent or invalid.
 * Does NOT throw — callers should redirect to /login on null.
 */
export async function validateToken(): Promise<string | null> {
  const token = getStoredToken();
  if (!token) return null;
  try {
    apiClient.setToken(token);
    const user = await apiClient.getMe();
    return user.username;
  } catch {
    removeToken();
    return null;
  }
}

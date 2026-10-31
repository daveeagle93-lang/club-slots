import { noStore } from "./bookings";
import { errorResponse } from "./http";

/**
 * Defence in depth: the admin guard (src/worker/guards.ts) authenticates every /api/admin/* request and sets
 * `data.admin = { identity, csrfBinding }`. A handler calls this first and returns the response if
 * there is one, so a routing mistake can never expose it without a signed-in admin.
 */
export function refuseUnlessAdmin(data: unknown): Response | null {
  const admin = (data as { admin?: { identity?: unknown } } | null | undefined)?.admin;
  const identity = typeof admin === "object" && admin !== null ? admin.identity : undefined;
  if (typeof identity === "string" && identity !== "") return null;
  return errorResponse(401, "unauthenticated", "Sign in to continue.", {}, noStore);
}

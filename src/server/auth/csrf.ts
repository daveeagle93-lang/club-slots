import { errorResponse } from "../http";
import { noStore } from "../bookings";
import { base64urlEncode, sha256, timingSafeEqual, utf8 } from "./crypto";

export const CSRF_HEADER = "X-CSRF-Token";

/**
 * The token for a session: SHA-256 of a tagged copy of its csrfBinding, which is a secret the page's
 * JavaScript never sees (an HttpOnly cookie's session id, or the Access JWT header), so no extra secret is needed.
 */
export async function csrfToken(binding: string): Promise<string> {
  return base64urlEncode(await sha256(utf8(`slot-booker-csrf-v1:${binding}`)));
}

/** Admin is browser-only, so Origin must be present and ours; Sec-Fetch-Site, when sent, must say same-origin. */
export function hasSameOrigin(request: Request): boolean {
  if (request.headers.get("Origin") !== new URL(request.url).origin) return false;
  const site = request.headers.get("Sec-Fetch-Site");
  return site === null || site === "same-origin";
}

const rejected = () => errorResponse(403, "csrf_failed", "That request was refused. Reload the page and try again.", {}, noStore);

/**
 * For a state-changing admin request: null if it may proceed, else the response to send.
 * Origin, then the token (constant-time compare), then a JSON Content-Type, which a cross-site form cannot send.
 */
export async function csrfFailure(request: Request, csrfBinding: string): Promise<Response | null> {
  if (!hasSameOrigin(request)) return rejected();
  const sent = utf8(request.headers.get(CSRF_HEADER) ?? "");
  if (!timingSafeEqual(sent, utf8(await csrfToken(csrfBinding)))) return rejected();
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return errorResponse(415, "unsupported_media_type", "Send the request as application/json.", {}, noStore);
  }
  return null;
}

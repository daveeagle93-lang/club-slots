import { adminAuthFor, type AuthDeps } from "../../../server/auth";
import { trimAdminSecret } from "../../../server/auth/crypto";
import { csrfToken } from "../../../server/auth/csrf";
import { clearAttempts, countAttempt } from "../../../server/auth/ratelimit";
import { declaresOversizeBody, noStore, payloadTooLarge, readJsonObject } from "../../../server/bookings";
import type { RouteHandler } from "../../../server/env";
import { errorResponse, json } from "../../../server/http";

const MAX_BODY_BYTES = 1024;
// A generated secret is 43 characters. The cap is on the raw value (UTF-16 code units, before trimming) and only
// bounds the work: 256 leaves room for generous padding around a pasted secret, and 256 three-byte characters
// (768 bytes) still fit in MAX_BODY_BYTES. public/admin/login.html uses the same number as its maxlength.
const MAX_PASSWORD_LENGTH = 256;

/**
 * POST /api/admin/login, password provider only (guardAdminApi hides it otherwise and has already
 * checked the Origin). The attempt is counted before the password is checked, so a client over the
 * limit costs no HMAC check and parallel guesses cannot beat the limit. The same 401 answers every failure,
 * including a value that is not shaped like a generated secret (those are refused before any hashing).
 */
export const createLoginHandler = (deps: AuthDeps = {}): RouteHandler => async ({ request, env }) => {
  const resolved = await adminAuthFor(env, deps);
  if ("error" in resolved || resolved.auth.kind !== "password") return errorResponse(404, "not_found", "Not found.", {}, noStore);
  const { auth } = resolved;

  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) return payloadTooLarge();
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  const { password: submitted } = body;
  if (typeof submitted !== "string" || submitted.length > MAX_PASSWORD_LENGTH) {
    return errorResponse(400, "invalid_input", "Enter the admin secret.", {}, noStore);
  }
  // Whitespace and zero-width characters around the secret are ignored (a generated secret has none); a value that
  // is nothing but those counts as empty. Only here: the verifier itself stays strict.
  const password = trimAdminSecret(submitted);
  if (password === "") return errorResponse(400, "invalid_input", "Enter the admin secret.", {}, noStore);

  const key = await auth.clientKey(request.headers.get("CF-Connecting-IP"));
  const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  try {
    const attempt = await countAttempt(env.DB, key, nowSeconds);
    if (!attempt.allowed) {
      return errorResponse(429, "too_many_attempts", "Too many attempts. Try again later.", {}, {
        ...noStore, "Retry-After": String(attempt.retryAfterSeconds),
      });
    }
    // The secret was checked against the credentials loaded above. With credentials from D1, confirmSignIn records the
    // first sign-in (closing /setup) for exactly those, and refuses if setup replaced them since: the same 401, no session.
    if (!(await auth.checkPassword(password)) || !(await auth.confirmSignIn())) {
      return errorResponse(401, "invalid_credentials", "That admin secret isn't right.", {}, noStore);
    }
    await clearAttempts(env.DB, key);
  } catch (e) {
    console.error("login failed:", e instanceof Error ? e.message : String(e));
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
  }
  const { session, setCookie } = await auth.startSession();
  return json({ identity: session.identity, csrfToken: await csrfToken(session.csrfBinding) }, 200, { ...noStore, "Set-Cookie": setCookie });
};

export const onRequestPost = createLoginHandler();

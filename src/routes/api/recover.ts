import type { AuthDeps } from "../../server/auth";
import { recoverAdmin } from "../../server/auth/claim";
import { base64urlEncode, generateAdminSecret, hashAdminSecret, parseAdminSecretHash, trimAdminSecret, verifyAdminSecret } from "../../server/auth/crypto";
import { hasSameOrigin } from "../../server/auth/csrf";
import { envCredentialsSet } from "../../server/auth/password";
import { clearAttempts, countAttempt, recoveryClientKey } from "../../server/auth/ratelimit";
import { loadAuthState } from "../../server/auth/settings";
import { noStore, payloadTooLarge, readJsonObject } from "../../server/bookings";
import type { RouteHandler } from "../../server/env";
import { errorResponse, json } from "../../server/http";

const MAX_BODY_BYTES = 1024;
// Same bound as setup and the admin login: on the raw value (UTF-16 code units, before trimming), and 256 three-byte characters still fit in MAX_BODY_BYTES.
const MAX_CODE_LENGTH = 256;
const SESSION_SECRET_BYTES = 32; // 43 base64url characters, over the 32 the session signature needs

const notFound = (): Response => errorResponse(404, "not_found", "Not found.", {}, noStore);

/**
 * POST /api/recover: a new admin secret and a new recovery code, for whoever holds the current recovery code. Public, so it
 * guards itself, in this order: 404 unless a recovery code is stored and the credentials are not set by environment variables
 * (a closed route is the same 404 as any unknown path, and reads nothing from the request); same-origin; a small JSON body;
 * the code trimmed like the admin secret; the client's attempt counted (5 per 15 minutes, its own key, NO cap across clients:
 * a global one would let anyone lock the owner out of the one route meant for the worst day); only then the constant-time
 * check. The attempt is counted before the check, never after, so parallel guesses cannot slip past the limit.
 * A right code makes the new pair and swaps it in with a compare-and-set on the old recovery hash (recoverAdmin), so one
 * code works once: of two simultaneous uses the loser gets 409. Both new values are returned in this response only: they
 * are never stored (only salted hashes) or logged. envPinned tells the page the environment still says ADMIN_AUTH=access,
 * which wins over the mode recovery just put back to the password.
 */
export const createRecoverHandler = (deps: AuthDeps = {}): RouteHandler => async ({ request, env }) => {
  if (envCredentialsSet(env)) return notFound();
  try {
    const { settings } = await loadAuthState(env.DB);
    const storedHash = settings.recoveryHash;
    if (storedHash === null) return notFound();
    if (!hasSameOrigin(request)) return errorResponse(403, "csrf_failed", "That request was refused. Reload the page and try again.", {}, noStore);

    if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) return payloadTooLarge();
    const body = await readJsonObject(request, MAX_BODY_BYTES);
    if (body instanceof Response) return body;
    const { code: submitted } = body;
    if (typeof submitted !== "string" || submitted.length > MAX_CODE_LENGTH) {
      return errorResponse(400, "invalid_input", "Enter the recovery code.", {}, noStore);
    }
    const code = trimAdminSecret(submitted);
    if (code === "") return errorResponse(400, "invalid_input", "Enter the recovery code.", {}, noStore);

    const now = (deps.now ?? Date.now)();
    const key = await recoveryClientKey(request.headers.get("CF-Connecting-IP"), storedHash);
    const attempt = await countAttempt(env.DB, key, Math.floor(now / 1000));
    if (!attempt.allowed) {
      return errorResponse(429, "too_many_attempts", "Too many attempts. Try again later.", {}, {
        ...noStore, "Retry-After": String(attempt.retryAfterSeconds),
      });
    }
    const stored = parseAdminSecretHash(storedHash);
    if (stored === null || !(await verifyAdminSecret(code, stored))) {
      return errorResponse(401, "invalid_recovery_code", "That recovery code isn't right.", {}, noStore);
    }

    const secret = generateAdminSecret();
    const recoveryCode = generateAdminSecret();
    const recovered = await recoverAdmin(env.DB, {
      secretHash: await hashAdminSecret(secret),
      sessionSecret: base64urlEncode(crypto.getRandomValues(new Uint8Array(SESSION_SECRET_BYTES))),
      recoveryHash: await hashAdminSecret(recoveryCode),
      nowIso: new Date(now).toISOString(),
      oldRecoveryHash: storedHash,
    });
    if (!recovered) return errorResponse(409, "recovery_code_used", "That recovery code has already been used.", {}, noStore);
    try {
      await clearAttempts(env.DB, key);
    } catch (e) {
      // The new credentials are stored: failing now would lose the only copy of them, and the leftover count expires by itself.
      console.error("recover: could not clear attempts:", e instanceof Error ? e.message : String(e));
    }
    return json({ secret, recoveryCode, envPinned: env.ADMIN_AUTH === "access" }, 200, noStore);
  } catch (e) {
    console.error("recover failed:", e instanceof Error ? e.message : String(e));
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
  }
};

export const onRequestPost = createRecoverHandler();

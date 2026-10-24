import type { AuthDeps } from "../../server/auth";
import { saveCredentials } from "../../server/auth/credentials";
import { base64urlEncode, generateAdminSecret, hashAdminSecret, trimAdminSecret } from "../../server/auth/crypto";
import { hasSameOrigin } from "../../server/auth/csrf";
import { clearAttempts, countAttempt, SETUP_GLOBAL_KEY, SETUP_GLOBAL_LIMIT, setupClientKey } from "../../server/auth/ratelimit";
import { noStore, payloadTooLarge, readJsonObject } from "../../server/bookings";
import type { RouteHandler } from "../../server/env";
import { errorResponse, json } from "../../server/http";
import { expectedSetupCode, setupCodeMatches, setupState } from "../../server/setup";

const MAX_BODY_BYTES = 1024;
// Same bound as the admin login: on the raw value (UTF-16 code units, before trimming), and 256 three-byte characters still fit in MAX_BODY_BYTES.
const MAX_CODE_LENGTH = 256;
const SESSION_SECRET_BYTES = 32; // 43 base64url characters, over the 32 the session signature needs

const notFound = (): Response => errorResponse(404, "not_found", "Not found.", {}, noStore);

/**
 * POST /api/setup: the first-run step of the password provider. Public, so it guards itself: nothing happens unless
 * setupState says "open" (a closed setup is the same 404 as any unknown path), the request is same-origin JSON, and the
 * client is within its attempt limit, and so are all clients together (a fixed key, 30 per 15 minutes), both counted before
 * the code is compared (own keyspace, the per-client key keyed with the code).
 * A right code makes the admin secret, stores its hash with a new session secret in one guarded statement, and returns
 * the secret in this response only: it is never stored or logged.
 */
export const createSetupHandler = (deps: AuthDeps = {}): RouteHandler => async ({ request, env }) => {
  const state = await setupState(env);
  if (state === "closed") return notFound();
  if (state !== "open") { // not_ready, and (until the claim flow exists) claim and claimed
    return errorResponse(503, "setup_not_ready", "Setup isn't ready: set SETUP_CODE to a phrase of at least 12 characters.", {}, noStore);
  }
  if (!hasSameOrigin(request)) return errorResponse(403, "csrf_failed", "That request was refused. Reload the page and try again.", {}, noStore);

  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) return payloadTooLarge();
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  const { code: submitted } = body;
  if (typeof submitted !== "string" || submitted.length > MAX_CODE_LENGTH) {
    return errorResponse(400, "invalid_input", "Enter the setup code.", {}, noStore);
  }
  const code = trimAdminSecret(submitted);
  if (code === "") return errorResponse(400, "invalid_input", "Enter the setup code.", {}, noStore);

  const expected = expectedSetupCode(env)!; // "open" means it is set and long enough
  const key = await setupClientKey(request.headers.get("CF-Connecting-IP"), expected);
  const now = (deps.now ?? Date.now)();
  try {
    const nowSeconds = Math.floor(now / 1000);
    // The visitor's own limit first, then the cap across everyone (so a visitor already refused adds nothing to it).
    const attempt = await countAttempt(env.DB, key, nowSeconds);
    const overall = attempt.allowed ? await countAttempt(env.DB, SETUP_GLOBAL_KEY, nowSeconds, SETUP_GLOBAL_LIMIT) : attempt;
    if (!overall.allowed) {
      return errorResponse(429, "too_many_attempts", "Too many attempts. Try again later.", {}, {
        ...noStore, "Retry-After": String(overall.retryAfterSeconds),
      });
    }
    if (!(await setupCodeMatches(code, expected))) {
      return errorResponse(401, "invalid_setup_code", "That setup code isn't right.", {}, noStore);
    }
    const secret = generateAdminSecret();
    const saved = await saveCredentials(env.DB, {
      secretHash: await hashAdminSecret(secret),
      sessionSecret: base64urlEncode(crypto.getRandomValues(new Uint8Array(SESSION_SECRET_BYTES))),
      createdAt: new Date(now).toISOString(),
    });
    if (!saved) return notFound(); // the first sign-in closed setup while this request was running; nothing was written
    await clearAttempts(env.DB, key);
    return json({ secret }, 200, noStore);
  } catch (e) {
    console.error("setup failed:", e instanceof Error ? e.message : String(e));
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
  }
};

export const onRequestPost = createSetupHandler();

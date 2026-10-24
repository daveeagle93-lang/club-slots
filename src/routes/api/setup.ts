import type { AuthDeps } from "../../server/auth";
import { claimAdmin, claimCookie, hashClaimToken, makeAdmin, newClaimToken, readClaimToken, reissueClaim } from "../../server/auth/claim";
import { saveCredentials } from "../../server/auth/credentials";
import { timingSafeEqual, trimAdminSecret, utf8 } from "../../server/auth/crypto";
import { hasSameOrigin } from "../../server/auth/csrf";
import { clearAttempts, countAttempt, SETUP_GLOBAL_KEY, SETUP_GLOBAL_LIMIT, setupClientKey } from "../../server/auth/ratelimit";
import { noStore, payloadTooLarge, readJsonObject } from "../../server/bookings";
import type { RouteHandler } from "../../server/env";
import { errorResponse, json } from "../../server/http";
import { expectedSetupCode, readSetup, setupCodeMatches, setupNotReadyMessage, type SetupRead } from "../../server/setup";

const MAX_BODY_BYTES = 1024;
// Same bound as the admin login: on the raw value (UTF-16 code units, before trimming), and 256 three-byte characters still fit in MAX_BODY_BYTES.
const MAX_CODE_LENGTH = 256;
// What newClaimToken makes. Anything else in the cookie is treated as no cookie, before it is hashed.
const CLAIM_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const notFound = (): Response => errorResponse(404, "not_found", "Not found.", {}, noStore);
const notReady = ({ reason }: SetupRead): Response => errorResponse(503, "setup_not_ready", setupNotReadyMessage(reason!), {}, noStore); // a not_ready read has a reason
const alreadySetUp = (): Response => errorResponse(409, "already_set_up", "This site has already been set up. Sign in instead.", {}, noStore);

const claimTokenOf = (request: Request): string | null => {
  const token = readClaimToken(request.headers.get("Cookie"));
  return token !== null && CLAIM_TOKEN_SHAPE.test(token) ? token : null;
};

/**
 * POST /api/setup: the first-run step of the password provider. Public, so it guards itself: nothing happens unless
 * readSetup says the setup is open, claim or claimed (a closed setup is the same 404 as any unknown path), and the request
 * is same-origin JSON.
 * State "open" (SETUP_CODE set): the client must be within its attempt limit, and so must all clients together (a fixed key,
 * 30 per 15 minutes), both counted before the code is compared (own keyspace, the per-client key keyed with the code).
 * A right code makes the admin secret and a recovery code, stores their hashes with a new session secret, and returns
 * both in this response only: they are never stored or logged.
 * State "claim" (no SETUP_CODE, window open): the same without a code, once; the claimer gets a claim cookie. There is
 * nothing to guess, so no attempt is counted. State "claimed": the same browser (the cookie) may have both replaced.
 * The window is checked here, before the write, because claimAdmin does not check it.
 */
export const createSetupHandler = (deps: AuthDeps = {}): RouteHandler => async ({ request, env }) => {
  const now = (deps.now ?? Date.now)();
  const read = await readSetup(env, now);
  if (read.state === "closed") return notFound();
  if (read.state === "not_ready") return notReady(read);
  if (!hasSameOrigin(request)) return errorResponse(403, "csrf_failed", "That request was refused. Reload the page and try again.", {}, noStore);

  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) return payloadTooLarge();
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (body instanceof Response) return body;

  const nowIso = new Date(now).toISOString();
  if (read.state !== "open") {
    try {
      if (read.state === "claim") {
        const token = newClaimToken();
        const { secret, recoveryCode, admin } = await makeAdmin(nowIso);
        if (!(await claimAdmin(env.DB, { ...admin, claimTokenHash: await hashClaimToken(token) }))) return alreadySetUp();
        return json({ secret, recoveryCode }, 200, { ...noStore, "Set-Cookie": claimCookie(token) });
      }
      const token = claimTokenOf(request);
      if (token === null) return alreadySetUp();
      const { secret, recoveryCode, admin } = await makeAdmin(nowIso);
      if (!(await reissueClaim(env.DB, { ...admin, claimTokenHash: await hashClaimToken(token) }))) return alreadySetUp();
      return json({ secret, recoveryCode }, 200, noStore);
    } catch (e) {
      console.error("setup failed:", e instanceof Error ? e.message : String(e));
      return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
    }
  }

  const { code: submitted } = body;
  if (typeof submitted !== "string" || submitted.length > MAX_CODE_LENGTH) {
    return errorResponse(400, "invalid_input", "Enter the setup code.", {}, noStore);
  }
  const code = trimAdminSecret(submitted);
  if (code === "") return errorResponse(400, "invalid_input", "Enter the setup code.", {}, noStore);

  const expected = expectedSetupCode(env)!; // "open" means it is set and long enough
  const key = await setupClientKey(request.headers.get("CF-Connecting-IP"), expected);
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
    const { secret, recoveryCode, admin } = await makeAdmin(nowIso);
    const saved = await saveCredentials(env.DB, {
      secretHash: admin.secretHash, sessionSecret: admin.sessionSecret, createdAt: nowIso, recoveryHash: admin.recoveryHash,
    });
    if (!saved) return notFound(); // the first sign-in closed setup while this request was running; nothing was written
    await clearAttempts(env.DB, key);
    return json({ secret, recoveryCode }, 200, noStore);
  } catch (e) {
    console.error("setup failed:", e instanceof Error ? e.message : String(e));
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
  }
};

/**
 * GET /api/setup: which form the setup page should show. Strictly read-only (no write, no attempt counted): code, claim,
 * reissue (the claim cookie is this site's claim, so the page may offer a new secret) or taken (someone else claimed).
 */
export const createSetupStatusHandler = (deps: AuthDeps = {}): RouteHandler => async ({ request, env }) => {
  const read = await readSetup(env, (deps.now ?? Date.now)());
  if (read.state === "closed") return notFound();
  if (read.state === "not_ready") return notReady(read);
  if (read.state === "open") return json({ state: "code" }, 200, noStore);
  if (read.state === "claim") return json({ state: "claim" }, 200, noStore);
  const token = claimTokenOf(request);
  const mine = token !== null && timingSafeEqual(utf8(await hashClaimToken(token)), utf8(read.settings.claimTokenHash ?? ""));
  return json({ state: mine ? "reissue" : "taken" }, 200, noStore);
};

export const onRequestGet = createSetupStatusHandler();
export const onRequestPost = createSetupHandler();

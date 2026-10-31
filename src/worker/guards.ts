import { adminAuthFor, type AdminData, type AuthDeps } from "../server/auth";
import { csrfFailure, hasSameOrigin } from "../server/auth/csrf";
import { noStore } from "../server/bookings";
import type { AppEnv } from "../server/env";
import { errorResponse, plain } from "../server/http";
import { setupState } from "../server/setup";

const LOGIN_PATH = "/api/admin/login";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Only the password provider has a sign-in page, so only then may these be fetched unauthenticated.
const LOGIN_PAGES = new Set(["/admin/login", "/admin/login.html", "/admin/login.js"]);

/**
 * The single choke point for /api/admin/*, including paths no route handles: every request must be
 * authenticated, and every state-changing one must pass the CSRF checks, before anything else runs.
 * The only exemption is POST /api/admin/login with the password provider, which gets the origin check but no token.
 * Returns the refusal, or what the handlers get as `data`: `{ admin }`, or `{}` for the login exemption.
 */
export async function guardAdminApi(request: Request, env: AppEnv, deps?: AuthDeps): Promise<Response | Partial<AdminData>> {
  const resolved = await adminAuthFor(env, deps);
  if ("error" in resolved) {
    console.error(`Admin auth is not configured: ${resolved.reason}`);
    return errorResponse(503, "admin_not_configured", "Admin sign-in isn't set up.", {}, noStore);
  }
  const { auth } = resolved;
  if (new URL(request.url).pathname === LOGIN_PATH) {
    if (auth.kind === "access") return errorResponse(404, "not_found", "Not found.", {}, noStore);
    if (request.method === "POST") {
      if (!hasSameOrigin(request)) return errorResponse(403, "csrf_failed", "That request was refused. Reload the page and try again.", {}, noStore);
      return {};
    }
  }
  const session = await auth.authenticate(request);
  if (!session) return errorResponse(401, "unauthenticated", "Sign in to continue.", { provider: auth.kind }, noStore);
  if (!SAFE_METHODS.has(request.method)) {
    const refused = await csrfFailure(request, session.csrfBinding);
    if (refused) return refused;
  }
  return { admin: session };
}

/**
 * Guards the static admin pages (/admin and /admin/*). The pages hold no data and /api/admin/* is protected on its own,
 * so this is defence in depth, but a stranger should not get the admin UI either. Returns the refusal, or null to
 * let the request on to the static files.
 */
export async function guardAdminPage(request: Request, env: AppEnv, deps?: AuthDeps): Promise<Response | null> {
  const resolved = await adminAuthFor(env, deps);
  if ("error" in resolved) {
    console.error(`Admin auth is not configured: ${resolved.reason}`);
    // A new deployment with no admin secret yet: the way forward is /setup, if a code is in place or the claim window is open.
    if (resolved.awaitingSetup && ["open", "claim"].includes(await setupState(env))) {
      return new Response(null, { status: 302, headers: { Location: "/setup", "Cache-Control": "no-store" } });
    }
    return plain(503, "Admin sign-in isn't set up.");
  }
  const { auth } = resolved;
  if (auth.kind === "password" && LOGIN_PAGES.has(new URL(request.url).pathname)) return null;
  if (await auth.authenticate(request)) return null;
  if (auth.kind === "password") return new Response(null, { status: 302, headers: { Location: "/admin/login", "Cache-Control": "no-store" } });
  return plain(401, "Sign in with Cloudflare Access to use the admin pages.");
}

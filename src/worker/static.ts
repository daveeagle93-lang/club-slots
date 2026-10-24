import { envCredentialsSet } from "../server/auth/password";
import { loadAuthState } from "../server/auth/settings";
import { noStore } from "../server/bookings";
import type { AppEnv, RouteHandler } from "../server/env";
import { plain } from "../server/http";
import { claimOpenCached, readSetup, setupNotReadyMessage } from "../server/setup";
import { serveWithTags } from "./open-graph";

/** The static files (the ASSETS binding), or an error if the Worker is deployed without it. */
export const assets = (env: AppEnv): Fetcher => {
  if (!env.ASSETS) throw new Error("The ASSETS binding is missing (wrangler.jsonc assets.binding).");
  return env.ASSETS;
};

/**
 * "/": the landing page (public/index.html) with the club's title and link-preview tags written in. See open-graph.ts.
 * While the claim window is open, GET of exactly "/" goes to /setup instead, so the first visitor finds the claim page. Only HEAD
 * and other paths are left alone: a GET crawler during the window gets the redirect and the /setup page but cannot claim,
 * because a GET never writes.
 */
export const serveLandingPage: RouteHandler = async ({ request, env }) => {
  if (request.method === "GET" && new URL(request.url).pathname === "/") {
    let claimable = false;
    try {
      claimable = await claimOpenCached(env);
    } catch (e) {
      // The redirect is a convenience: a database error must not take the landing page down (the tags fall back the same way).
      console.error("Setup state unavailable for /:", e instanceof Error ? e.message : "unknown error");
    }
    if (claimable) return new Response(null, { status: 302, headers: { Location: "/setup", ...noStore } });
  }
  return serveWithTags(assets(env), env.DB, request, "/", null);
};

/**
 * /e/<slug>: the event page, with the event's title and link-preview tags written in (generic ones for an unknown, invalid or
 * archived slug). It is one file (public/event.html) for every slug, which reads the slug from the address.
 */
export const serveEventPage: RouteHandler<"slug"> = ({ request, env, params }) =>
  serveWithTags(assets(env), env.DB, request, "/event", String(params.slug));

/**
 * Any other path under /e/ that no route matched (/e/x/, /e/a/b, ...): the event page too, as it always
 * was for everything under /e/. The page's script shows "not found" for these. The tags are the generic ones, by
 * the same code path as an unknown slug (so the bodies are identical), except for `/e/<slug>/` with one trailing slash,
 * which is that slug's page. The caller leaves out /e/ itself, which is not an event path.
 */
export const serveEventFallbackPage: RouteHandler = ({ request, env }) => {
  const trailing = /^\/e\/([^/]+)\/$/.exec(new URL(request.url).pathname);
  let slug = ""; // not a valid slug: the generic tags
  try {
    if (trailing) slug = decodeURIComponent(trailing[1]);
  } catch { /* malformed percent-encoding: generic */ }
  return serveWithTags(assets(env), env.DB, request, "/event", slug);
};

/** A static page by its clean URL without the visitor's conditional headers, sent no-store. */
const servePage = async (env: AppEnv, request: Request, path: string): Promise<Response> => {
  const page = await assets(env).fetch(new Request(new URL(path, request.url), { method: "GET" }));
  const out = new Response(page.body, page);
  for (const [name, value] of Object.entries(noStore)) out.headers.set(name, value);
  return out;
};

/**
 * /setup: the first-run page (public/setup.html), while setup is open, claimable or claimed (src/server/setup.ts). Fetched by
 * its clean URL without the visitor's conditional headers, so a cached copy can never answer once setup has closed, and sent
 * no-store. Closed is a plain 404; a too-short SETUP_CODE or an expired window gets a one-line explanation instead of the page.
 */
export const serveSetupPage: RouteHandler = async ({ request, env }) => {
  const { state, reason } = await readSetup(env);
  if (state === "closed") return plain(404, "Not found.");
  if (state === "not_ready") return plain(503, setupNotReadyMessage(reason!)); // a not_ready read always has a reason
  return servePage(env, request, "/setup");
};

/**
 * /recover: the recovery page (public/recover.html), only while a recovery code is stored and the credentials are not set by
 * environment variables (the same test as POST /api/recover, which has no stored credentials to replace otherwise). Served like
 * /setup: by its clean URL without the visitor's conditional headers, and no-store. A GET reads and never writes.
 */
export const serveRecoverPage: RouteHandler = async ({ request, env }) => {
  if (envCredentialsSet(env) || (await loadAuthState(env.DB)).settings.recoveryHash === null) return plain(404, "Not found.");
  return servePage(env, request, "/recover");
};

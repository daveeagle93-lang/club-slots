import { noStore } from "../server/bookings";
import type { AppEnv, RouteHandler } from "../server/env";
import { plain } from "../server/http";
import { setupState } from "../server/setup";
import { serveWithTags } from "./open-graph";

/** The static files (the ASSETS binding), or an error if the Worker is deployed without it. */
export const assets = (env: AppEnv): Fetcher => {
  if (!env.ASSETS) throw new Error("The ASSETS binding is missing (wrangler.jsonc assets.binding).");
  return env.ASSETS;
};

/** "/": the landing page (public/index.html) with the club's title and link-preview tags written in. See open-graph.ts. */
export const serveLandingPage: RouteHandler = ({ request, env }) => serveWithTags(assets(env), env.DB, request, "/", null);

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

/**
 * /setup: the first-run page (public/setup.html), only while setup is open (src/server/setup.ts). Fetched by its clean
 * URL without the visitor's conditional headers, so a cached copy can never answer once setup has closed, and sent no-store.
 * Closed is a plain 404; a missing or too-short SETUP_CODE gets a one-line explanation instead of the page.
 */
export const serveSetupPage: RouteHandler = async ({ request, env }) => {
  const state = await setupState(env);
  if (state === "closed") return plain(404, "Not found.");
  if (state !== "open") return plain(503, "Setup isn't ready: set SETUP_CODE (a phrase of at least 12 characters) as a Worker secret, then reload this page.");
  const page = await assets(env).fetch(new Request(new URL("/setup", request.url), { method: "GET" }));
  const out = new Response(page.body, page);
  for (const [name, value] of Object.entries(noStore)) out.headers.set(name, value);
  return out;
};

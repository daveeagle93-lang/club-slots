import type { AuthDeps } from "./server/auth";
import { noStore } from "./server/bookings";
import type { AppEnv } from "./server/env";
import { errorResponse } from "./server/http";
import { guardAdminApi, guardAdminPage } from "./worker/guards";
import { withSecurityHeaders } from "./worker/headers";
import { resolveRoute } from "./worker/router";
import { createRoutes } from "./worker/routes";
import { assets, serveEventFallbackPage } from "./worker/static";

/** Whether `pathname` is `prefix` or below it. Exact text, like the router: no case folding, decoding or slash tolerance. */
const under = (pathname: string, prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`);

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Hosts where the plain-http refusal does not apply, for local development (`wrangler dev` on localhost, or on a LAN address
 * from a phone): localhost, *.localhost, and IP literals (dotted-quad IPv4; IPv6 in brackets, as URL.hostname gives it).
 * A deployed Worker is reached by hostname, never a raw IP, so this never exempts a real site.
 */
const isLocalHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname.endsWith(".localhost") || IPV4.test(hostname) || (hostname.startsWith("[") && hostname.endsWith("]"));

const methodNotAllowed = (allow: string[]): Response =>
  errorResponse(405, "method_not_allowed", "Method not allowed.", {}, { ...noStore, Allow: allow.join(", ") });

/**
 * The whole app as one Worker: the guards, then the route table, then the static files (the ASSETS binding).
 * `deps` are for tests only (a fixed clock and a stubbed Access key fetch for the admin sign-in checks).
 */
export function createWorker(deps?: AuthDeps) {
  const routes = createRoutes(deps);

  async function handle(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    // Plain http is refused before anything else (a sign-in cookie or the setup code must never travel in clear): readers are sent
    // to https, anything else is refused outright rather than redirected (a redirected POST would already have leaked its body).
    if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
      if (request.method === "GET" || request.method === "HEAD") {
        url.protocol = "https:";
        return new Response(null, { status: 308, headers: { Location: url.toString(), ...noStore } });
      }
      return errorResponse(403, "https_required", "Use https.", {}, noStore);
    }
    const readOnly = request.method === "GET" || request.method === "HEAD";
    const data: Record<string, unknown> = {};

    // Who may reach what is decided here, from the path, before any route is matched: the whole of /api/admin
    // (unknown paths included) and of /admin, whatever the table says.
    const adminApi = under(pathname, "/api/admin");
    if (adminApi) {
      const guarded = await guardAdminApi(request, env, deps);
      if (guarded instanceof Response) return guarded;
      Object.assign(data, guarded);
    } else if (under(pathname, "/admin")) {
      const refused = await guardAdminPage(request, env, deps);
      if (refused) return refused;
      if (!readOnly) return methodNotAllowed(["GET", "HEAD"]);
      // The original request, not a copy: the asset service's redirects (clean URLs) have a relative Location that a fresh Request would lose.
      return assets(env).fetch(request);
    }

    const found = resolveRoute(routes, request.method, pathname);
    if (found.kind === "method_not_allowed") return methodNotAllowed(found.allow);
    if (found.kind === "match") {
      // The table and the path test above must agree; if not, fail closed rather than run an admin handler unguarded.
      // Deliberate defence in depth against a future table edit (routes.test.ts pins the same invariant).
      if (found.route.access === "admin" && !adminApi) throw new Error(`Admin route ${found.route.pattern} was reached without the admin guard.`);
      const response = await found.route.handler({ request, env, params: found.params, data });
      return request.method === "HEAD" && found.route.method === "GET" ? new Response(null, response) : response;
    }

    // Everything under /e/ is the event page (the static files have no /e/ directory), but /e/ alone is not an event path.
    if (readOnly && pathname.startsWith("/e/") && pathname !== "/e/") {
      return serveEventFallbackPage({ request, env, params: {}, data });
    }
    if (readOnly && !under(pathname, "/api")) return assets(env).fetch(request);
    return errorResponse(404, "not_found", "Not found.", {}, noStore);
  }

  return {
    async fetch(request: Request, env: AppEnv): Promise<Response> {
      try {
        return withSecurityHeaders(await handle(request, env));
      } catch (e) {
        console.error("Unhandled error:", e instanceof Error ? e.message : "unknown error");
        return withSecurityHeaders(new Response("Something went wrong.", {
          status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        }));
      }
    },
  } satisfies ExportedHandler<AppEnv>;
}

export default createWorker();

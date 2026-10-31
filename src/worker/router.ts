import type { RouteContext } from "../server/env";

export type Method = "GET" | "POST" | "PUT" | "DELETE" | "*";
/** "admin" routes sit behind the admin guard (see worker.ts, which decides that from the path alone); the field is what the tests pin. */
export type Access = "public" | "admin";

export interface Route {
  /** "*" is any method: the handler checks for itself (the `onRequest` exports). A GET route also answers HEAD. */
  method: Method;
  /** Literal segments and `:name` segments, each `:name` matching exactly one non-empty segment. */
  pattern: string;
  // Handlers declare their own params and data, so the context is deliberately loose here.
  handler: (context: RouteContext<any, any>) => Response | Promise<Response>;
  access: Access;
}

export type Resolution =
  | { kind: "match"; route: Route; params: Record<string, string> }
  | { kind: "method_not_allowed"; allow: string[] }
  | { kind: "not_found" };

/**
 * The params if `pathname` matches `pattern`, else null. Works on the raw path text: literal segments must be equal
 * character for character (no case folding, no percent-decoding, no trailing-slash or double-slash tolerance), and only
 * a captured `:param` is percent-decoded. That keeps this and worker.ts's `/api/admin` and `/admin` prefix tests
 * agreeing on what a path is. A param that is empty or not valid percent-encoding does not match.
 */
export function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/");
  const have = pathname.split("/");
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) {
      if (have[i] === "") return null;
      try {
        params[want[i].slice(1)] = decodeURIComponent(have[i]);
      } catch {
        return null;
      }
    } else if (want[i] !== have[i]) {
      return null;
    }
  }
  return params;
}

const METHOD_ORDER = ["GET", "HEAD", "POST", "PUT", "DELETE"];

/** Negative if pattern `a` is more specific than `b` (a literal segment beats a :param at the first difference). Both match one path. */
function bySpecificity(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < x.length; i++) {
    const px = x[i].startsWith(":");
    const py = y[i].startsWith(":");
    if (px !== py) return px ? 1 : -1;
  }
  return 0;
}

const accepts = (route: Route, method: string): boolean =>
  route.method === "*" || route.method === method || (method === "HEAD" && route.method === "GET");

/**
 * The route for a request, trying the most specific matching pattern first (so `/bookings/swap` beats `/bookings/:id`)
 * and falling back to a less specific one only for a method the more specific one lacks. When the path matches some
 * pattern but no route takes the method, says which methods are allowed.
 */
export function resolveRoute(routes: readonly Route[], method: string, pathname: string): Resolution {
  const candidates = routes
    .flatMap((route) => {
      const params = matchPattern(route.pattern, pathname);
      return params ? [{ route, params }] : [];
    })
    .sort((a, b) => bySpecificity(a.route.pattern, b.route.pattern));
  if (candidates.length === 0) return { kind: "not_found" };
  const found = candidates.find((c) => accepts(c.route, method));
  if (found) return { kind: "match", ...found };
  const allowed = new Set(candidates.flatMap((c) => (c.route.method === "GET" ? ["GET", "HEAD"] : [c.route.method])));
  return { kind: "method_not_allowed", allow: METHOD_ORDER.filter((m) => allowed.has(m)) };
}

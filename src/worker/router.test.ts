import { describe, expect, it } from "vitest";
import { matchPattern, resolveRoute, type Method, type Route } from "./router";

const handler = () => new Response("x");
const route = (method: Method, pattern: string): Route => ({ method, pattern, handler, access: "public" });

describe("matchPattern", () => {
  it("matches literal segments exactly and captures :params", () => {
    expect(matchPattern("/api/health", "/api/health")).toEqual({});
    expect(matchPattern("/api/events/:slug", "/api/events/summer-show")).toEqual({ slug: "summer-show" });
    expect(matchPattern("/api/events/:slug/bookings/:token/ics", "/api/events/a/bookings/b/ics")).toEqual({ slug: "a", token: "b" });
    expect(matchPattern("/", "/")).toEqual({});
    expect(matchPattern("/api/health", "/api/healthz")).toBeNull();
    expect(matchPattern("/api/events/:slug", "/api/events")).toBeNull();
    expect(matchPattern("/api/events/:slug", "/api/events/a/b")).toBeNull();
  });

  it("compares literals with the raw path: no case folding, no percent-decoding, no slash tolerance", () => {
    expect(matchPattern("/api/admin/events", "/API/admin/events")).toBeNull();
    expect(matchPattern("/api/admin/events", "/api/%61dmin/events")).toBeNull();
    expect(matchPattern("/api/admin/events", "/api/admin%2Fevents")).toBeNull();
    expect(matchPattern("/api/admin/events", "/api/admin/events/")).toBeNull();
    expect(matchPattern("/api/admin/events", "//api/admin/events")).toBeNull();
    expect(matchPattern("/api/admin/events", "/api//admin/events")).toBeNull();
    expect(matchPattern("/api/health", "/api/health/")).toBeNull();
  });

  it("percent-decodes only captured params, and does not match an empty or malformed one", () => {
    expect(matchPattern("/api/events/:slug", "/api/events/a%20b")).toEqual({ slug: "a b" });
    expect(matchPattern("/api/events/:slug", "/api/events/a%2Fb")).toEqual({ slug: "a/b" });
    expect(matchPattern("/api/events/:slug", "/api/events/")).toBeNull();
    expect(matchPattern("/api/events/:slug", "/api/events/%E0%A4%A")).toBeNull();
  });
});

describe("resolveRoute", () => {
  const routes = [
    route("GET", "/api/things/:id"),
    route("PUT", "/api/things/:id"),
    route("POST", "/api/things/swap"),
    route("DELETE", "/api/things/:id"),
    route("*", "/api/any"),
    route("POST", "/api/post-only"),
    route("GET", "/api/get-only"),
  ];

  it("finds the route for a path and method, with its params", () => {
    expect(resolveRoute(routes, "PUT", "/api/things/7")).toEqual({ kind: "match", route: routes[1], params: { id: "7" } });
    expect(resolveRoute(routes, "GET", "/api/things/7")).toMatchObject({ kind: "match", route: routes[0] });
  });

  it("answers a HEAD with the GET route, and a * route for any method", () => {
    expect(resolveRoute(routes, "HEAD", "/api/get-only")).toMatchObject({ kind: "match", route: routes[6] });
    for (const m of ["GET", "HEAD", "POST", "PATCH", "OPTIONS"]) expect(resolveRoute(routes, m, "/api/any"), m).toMatchObject({ kind: "match", route: routes[4] });
    expect(resolveRoute(routes, "HEAD", "/api/post-only")).toEqual({ kind: "method_not_allowed", allow: ["POST"] });
  });

  it("prefers the literal route to the :param one, and falls back to the :param route for a method the literal lacks", () => {
    expect(resolveRoute(routes, "POST", "/api/things/swap")).toMatchObject({ kind: "match", route: routes[2] });
    expect(resolveRoute(routes, "DELETE", "/api/things/swap")).toMatchObject({ kind: "match", route: routes[3], params: { id: "swap" } });
  });

  it("lists the allowed methods (HEAD with GET) when the path matches but the method does not", () => {
    expect(resolveRoute(routes, "POST", "/api/get-only")).toEqual({ kind: "method_not_allowed", allow: ["GET", "HEAD"] });
    expect(resolveRoute(routes, "PATCH", "/api/things/7")).toEqual({ kind: "method_not_allowed", allow: ["GET", "HEAD", "PUT", "DELETE"] });
    expect(resolveRoute(routes, "GET", "/api/post-only")).toEqual({ kind: "method_not_allowed", allow: ["POST"] });
  });

  it("is not_found when no pattern matches the path", () => {
    expect(resolveRoute(routes, "GET", "/api/nothing")).toEqual({ kind: "not_found" });
    expect(resolveRoute(routes, "GET", "/api/things/7/")).toEqual({ kind: "not_found" });
  });
});

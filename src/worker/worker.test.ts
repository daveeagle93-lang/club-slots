import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accessEnv, ageWindow, claimEnv, d1Env, NOW, ORIGIN, passwordEnv, SETUP_CODE, TEST_PASSWORD, writeHeaders } from "../server/auth/test-harness";
import type { AppEnv } from "../server/env";
import { setupNotReadyMessage } from "../server/setup";
import { createTestEnv, type TestEnv } from "../test/db";
import { pageAssets, publicAssets } from "../test/assets";
import { createWorker } from "../worker";
import { SECURITY_HEADERS } from "./headers";
import { createRoutes } from "./routes";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

const worker = createWorker({ now: () => NOW });
const table = createRoutes();
const adminRoutes = table.filter((r) => r.access === "admin");
const PUBLIC_DIR = join(import.meta.dirname, "../../public");

/**
 * A database that fails the test if anything but the guard's one batch read of the sign-in mode and credentials uses it
 * (it answers that with no rows): an unguarded handler would reach for it.
 */
const noDb = {
  batch: async () => [{ results: [] }, { results: [] }],
  prepare: () => ({}),
} as unknown as D1Database;

/** An ASSETS stub that records every request it is given and answers 200 `asset:<path>`. */
const recordingAssets = () => {
  const seen: Request[] = [];
  const fetcher = { fetch: async (request: Request) => { seen.push(request); return new Response(`asset:${new URL(request.url).pathname}`, { headers: { "Content-Type": "text/html" } }); } };
  return { seen, fetcher: fetcher as unknown as Fetcher };
};

const send = (env: AppEnv, path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);

/** The path of a route with a made-up value for each :param. */
const fill = (pattern: string) => pattern.replace(/:\w+/g, "x");

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const hasSecurityHeaders = (res: Response) => Object.entries(SECURITY_HEADERS).every(([k, v]) => res.headers.get(k) !== null && (k === "Content-Security-Policy" || res.headers.get(k) === v));

/** Every file under public/admin/ the way a browser could ask for it: the file, its clean URL, and the directory for index.html. */
const adminPageUrls = (): string[] => {
  const files = readdirSync(join(PUBLIC_DIR, "admin"), { recursive: true, encoding: "utf8" }).map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.endsWith(".test.ts") && /\.\w+$/.test(f));
  const urls = new Set<string>();
  for (const f of files) {
    urls.add(`/admin/${f}`);
    if (f.endsWith(".html")) urls.add(`/admin/${f.slice(0, -".html".length)}`);
    if (f === "index.html") { urls.add("/admin/"); urls.add("/admin"); }
  }
  return [...urls].sort();
};
const LOGIN_PAGES = ["/admin/login", "/admin/login.html", "/admin/login.js"];

describe("the admin API is guarded whatever the route table says", () => {
  it("answers every admin route and every method with 401 when not signed in, before routing (so never 404 or 405)", async () => {
    const env = await passwordEnv(noDb);
    const { fetcher } = recordingAssets();
    let n = 0;
    for (const route of adminRoutes) {
      for (const method of METHODS) {
        if (route.pattern === "/api/admin/login" && method === "POST") continue; // the one exemption; below
        const res = await send({ ...env, ASSETS: fetcher }, fill(route.pattern), { method, headers: writeHeaders("anything") });
        expect(res.status, `${method} ${route.pattern}`).toBe(401);
        if (method !== "HEAD") expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" }, provider: "password" });
        expect(hasSecurityHeaders(res)).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(150);
  });

  it("treats POST /api/admin/login as the only exemption: Origin is checked, the handler is reached, and it is the handler that refuses", async () => {
    const env = await passwordEnv(t.env.DB);
    expect((await send(env, "/api/admin/login", { method: "POST", body: "{}" })).status).toBe(403);
    const res = await send(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.1" }, body: JSON.stringify({ password: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_credentials" } });
  });

  it("answers every admin route and method with 401 under the Access provider (login does not exist there: 404 for any method)", async () => {
    const env = { ...accessEnv(noDb), ASSETS: recordingAssets().fetcher };
    const deaf = createWorker({ now: () => NOW, fetch: (async () => Response.json({ keys: [] })) as unknown as typeof fetch });
    for (const route of adminRoutes) {
      for (const method of METHODS) {
        const res = await deaf.fetch(new Request(`${ORIGIN}${fill(route.pattern)}`, { method, headers: writeHeaders("anything") }), env);
        expect(res.status, `${method} ${route.pattern}`).toBe(route.pattern === "/api/admin/login" ? 404 : 401);
      }
    }
  });

  it("answers 503 for every admin route and method when ADMIN_AUTH is empty", async () => {
    const env = { ...(await passwordEnv(noDb)), ADMIN_AUTH: "" };
    for (const route of adminRoutes) {
      for (const method of METHODS) {
        const res = await send(env, fill(route.pattern), { method, headers: writeHeaders("anything") });
        expect(res.status, `${method} ${route.pattern}`).toBe(503);
      }
    }
  });

  it("guards unknown paths and the bare prefix too: 401, never 404", async () => {
    const env = await passwordEnv(noDb);
    for (const path of ["/api/admin", "/api/admin/", "/api/admin/zzz", "/api/admin/zzz/yyy", "/api/admin/events/", "/api/admin/events/x/zzz", "/api/admin//events"]) {
      for (const method of ["GET", "POST", "DELETE"]) expect((await send(env, path, { method, headers: writeHeaders("x") })).status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("the admin pages are guarded whatever is in public/admin/", () => {
  const urls = adminPageUrls();

  it("sees the files it expects", () => {
    expect(urls).toEqual(expect.arrayContaining(["/admin", "/admin/", "/admin/index.html", "/admin/login.html", "/admin/login", "/admin/login.js", "/admin/settings", "/admin/api.js"]));
  });

  it("redirects every page to /admin/login when not signed in, except the three login pages, which go to ASSETS as the original request", async () => {
    const env = await passwordEnv(noDb);
    for (const path of urls) {
      const { seen, fetcher } = recordingAssets();
      const request = new Request(`${ORIGIN}${path}`);
      const res = await worker.fetch(request, { ...env, ASSETS: fetcher });
      if (LOGIN_PAGES.includes(path)) {
        expect(res.status, path).toBe(200);
        expect(seen, path).toHaveLength(1);
        expect(seen[0], path).toBe(request);
      } else {
        expect(res.status, path).toBe(302);
        expect(res.headers.get("location"), path).toBe("/admin/login");
        expect(seen, path).toHaveLength(0);
      }
      expect(hasSecurityHeaders(res), path).toBe(true);
    }
  });

  it("answers 401 for every page, the login pages included, under the Access provider", async () => {
    const deaf = createWorker({ now: () => NOW, fetch: (async () => Response.json({ keys: [] })) as unknown as typeof fetch });
    for (const path of urls) {
      const { seen, fetcher } = recordingAssets();
      const res = await deaf.fetch(new Request(`${ORIGIN}${path}`), { ...accessEnv(noDb), ASSETS: fetcher });
      expect(res.status, path).toBe(401);
      expect(seen, path).toHaveLength(0);
    }
  });

  it("answers 503 for every page when ADMIN_AUTH is empty", async () => {
    const env = { ...(await passwordEnv(noDb)), ADMIN_AUTH: "" };
    for (const path of [...urls, "/admin/zzz"]) {
      const { seen, fetcher } = recordingAssets();
      expect((await send({ ...env, ASSETS: fetcher }, path)).status, path).toBe(503);
      expect(seen, path).toHaveLength(0);
    }
  });

  it("guards unknown paths too: a redirect, never a 404 or a file", async () => {
    const env = await passwordEnv(noDb);
    for (const path of ["/admin/zzz", "/admin/zzz/yyy", "/admin//settings", "/admin/settings/", "/admin/login/", "/admin/login.html/", "/admin/LOGIN"]) {
      const { seen, fetcher } = recordingAssets();
      const res = await send({ ...env, ASSETS: fetcher }, path);
      expect(res.status, path).toBe(302);
      expect(seen, path).toHaveLength(0);
    }
  });

  it("lets only GET and HEAD through to the files, once signed in or not", async () => {
    const env = await passwordEnv(noDb);
    const { seen, fetcher } = recordingAssets();
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await send({ ...env, ASSETS: fetcher }, "/admin/login", { method })).status, method).toBe(405);
      expect((await send({ ...env, ASSETS: fetcher }, "/admin/settings", { method })).status, method).toBe(302);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("variants of an admin path do not get past the guard", () => {
  // Each is guarded, or ends at the static files or a JSON 404; none may reach an admin handler. noDb makes a handler that did fail loudly.
  const variants = [
    "/api/admin", "/api/admin/", "/api/admin/events/", "//api/admin/events", "/api//admin/events", "/api/admin//events",
    "/api/%61dmin/events", "/api/%41dmin/events", "/api/admin%2Fevents", "/api%2Fadmin/events", "/api/admin%2fevents/x",
    "/API/admin/events", "/Api/Admin/Events", "/api/ADMIN/events",
    "/Admin/settings", "/ADMIN/settings.html", "/admin%2Fsettings", "/%61dmin/settings", "/%2561dmin/settings", "//admin/settings", "/admin//settings",
    "/api/events/../admin/events", "/api/events/%2e%2e/admin/events", "/api/events/%2E%2E/admin/events", "/api/./admin/events", "/admin/../admin/settings",
    "/api\\admin/events", "/admin\\settings", "/api/admin/events;x", "/api/admin/events%00", "/api/admin/events%20", "/admin/settings%00",
    "/api/admin/session/", "/api/admin/events/x/", "/api/admin/settings/logo/", "/api/events/x/../../admin/session",
  ];

  it.each(["GET", "HEAD", "POST", "DELETE"])("%s", async (method) => {
    const env = await passwordEnv(noDb);
    for (const path of variants) {
      const { seen, fetcher } = recordingAssets();
      const res = await send({ ...env, ASSETS: fetcher }, path, { method, headers: writeHeaders("x") });
      const guarded = (res.status === 401 && method !== "HEAD" && ((await res.clone().json()) as { error?: { code?: string } }).error?.code === "unauthenticated")
        || (res.status === 401 && method === "HEAD") || (res.status === 302 && res.headers.get("location") === "/admin/login");
      if (guarded) continue;
      // Not guarded, so it must not have reached a handler: the static files (which 404 an unknown name) or a JSON 404/405.
      expect(res.status, `${method} ${path}`).not.toBe(500);
      expect([200, 404, 405], `${method} ${path}`).toContain(res.status);
      if (res.status === 200) {
        expect(seen, `${method} ${path}`).toHaveLength(1);
        expect(new URL(seen[0].url).pathname, `${method} ${path}`).not.toMatch(/^\/(api\/)?admin(\/|$)/);
        expect(await res.text(), `${method} ${path}`).toMatch(/^asset:/);
      } else if (method !== "HEAD") {
        expect(await res.json(), `${method} ${path}`).toMatchObject({ error: { code: expect.stringMatching(/^(not_found|method_not_allowed)$/) } });
      }
    }
  });

  it("the URL parser's own normalisation is what makes the dot-segment forms guarded", () => {
    expect(new URL("https://x.example/api/events/../admin/events").pathname).toBe("/api/admin/events");
    expect(new URL("https://x.example/api/events/%2e%2e/admin/events").pathname).toBe("/api/admin/events");
    expect(new URL("https://x.example/api%5Cadmin/events").pathname).toBe("/api%5Cadmin/events");
  });
});

describe("with a valid password session", () => {
  it("gets past the guard on every admin route and method it declares", async () => {
    const env = { ...(await passwordEnv(t.env.DB)), ASSETS: recordingAssets().fetcher };
    const login = await send(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.77" }, body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    let n = 0;
    for (const route of adminRoutes.filter((r) => r.pattern !== "/api/admin/login")) {
      const res = await send(env, fill(route.pattern), {
        method: route.method, headers: { ...writeHeaders(csrfToken), Cookie: cookie }, body: route.method === "GET" || route.method === "DELETE" ? undefined : "{}",
      });
      expect([401, 403, 405, 503], `${label(route)} -> ${res.status}`).not.toContain(res.status);
      expect(res.status, label(route)).toBeLessThan(500);
      n++;
    }
    expect(n).toBe(adminRoutes.length - 1);
    expect((await send(env, "/api/admin/session", { headers: { Cookie: cookie } })).status).toBe(200);
    // Without the token a write is still refused by the guard, session or not.
    expect((await send(env, "/api/admin/events", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  });

  it("serves the admin pages to the files", async () => {
    const env = await passwordEnv(t.env.DB);
    const login = await send(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.78" }, body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    for (const path of ["/admin", "/admin/", "/admin/settings", "/admin/zzz"]) {
      const { seen, fetcher } = recordingAssets();
      const res = await send({ ...env, ASSETS: fetcher }, path, { headers: { Cookie: cookie } });
      expect(res.status, path).toBe(200);
      expect(seen, path).toHaveLength(1);
    }
  });
});

const label = (r: { method: string; pattern: string }) => `${r.method} ${r.pattern}`;

describe("routing", () => {
  it("answers a path that matches a route but not its method with 405, an Allow header and no-store", async () => {
    const env = { DB: t.env.DB } as AppEnv;
    const res = await send(env, "/api/health", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: { code: "method_not_allowed" } });
    expect((await send(env, "/api/events/x/bookings", { method: "GET" })).headers.get("allow")).toBe("POST");
    expect((await send(env, "/api/events", { method: "DELETE" })).status).toBe(405);
  });

  it("answers HEAD for a GET route with the same status and headers and no body", async () => {
    const env = { DB: t.env.DB } as AppEnv;
    const get = await send(env, "/api/health");
    const head = await send(env, "/api/health", { method: "HEAD" });
    expect(get.status).toBe(200);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(await head.text()).toBe("");
    expect(await get.json()).toEqual({ ok: true });
  });

  it("answers a JSON 404 for an unknown /api/ path, any method", async () => {
    const env = { DB: t.env.DB } as AppEnv;
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
      const res = await send(env, "/api/nothing/here", { method });
      expect(res.status, method).toBe(404);
      if (method !== "HEAD") expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    }
    for (const path of ["/api", "/api/", "/api/events/", "/api/events/x/bookings/", "/api/health/"]) expect((await send(env, path)).status, path).toBe(404);
  });

  it("passes the original request to ASSETS for any unmatched GET or HEAD (/ is the rewritten landing page: open-graph.test.ts), and answers other methods with JSON", async () => {
    const { seen, fetcher } = recordingAssets();
    const env = { DB: t.env.DB, ASSETS: fetcher } as AppEnv;
    for (const path of ["/style.css", "/lib.js", "/e/", "/e", "/nothing"]) {
      const request = new Request(`${ORIGIN}${path}`);
      const res = await worker.fetch(request, env);
      expect(res.status, path).toBe(200);
      expect(seen.at(-1), path).toBe(request);
    }
    expect((await send(env, "/nothing", { method: "POST" })).status).toBe(404);
    expect((await send(env, "/", { method: "POST" })).status).toBe(405);
    expect((await send(env, "/", { method: "HEAD" })).status).toBe(200);
  });

  it("serves /e/<slug> from the event page, keeping the method and headers", async () => {
    const { seen, fetcher } = recordingAssets();
    const env = { DB: t.env.DB, ASSETS: fetcher } as AppEnv;
    const res = await send(env, "/e/summer-show?x=1", { headers: { "Accept-Language": "en-GB" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset:/event");
    expect(seen[0].method).toBe("GET");
    expect(seen[0].headers.get("accept-language")).toBe("en-GB");
    await send(env, "/e/summer-show", { method: "HEAD" });
    expect(seen[1].method).toBe("HEAD");
  });

  describe("every other path under /e/ is the event page with generic tags (everything under /e/ always was)", () => {
    const eventPageEnv = () => { const assets = pageAssets(); return { assets, env: { DB: t.env.DB, ASSETS: assets } as AppEnv }; };
    const unknownSlugPage = async () => (await send(eventPageEnv().env, "/e/never-existed0000000")).text();

    it("serves /e/x/, /e/a/b, /e/a/b/c, /e// and /e/x// as that page, byte for byte the page of an unknown slug, from the /event asset", async () => {
      const expected = await unknownSlugPage();
      expect(expected).toContain("<title>");
      for (const path of ["/e/x/", "/e/a/b", "/e/a/b/c", "/e//", "/e/x//", "/e/never-existed0000000/extra", "/e/a%2Fb"]) {
        const { assets, env } = eventPageEnv();
        const res = await send(env, `${path}?utm=1`);
        expect(res.status, path).toBe(200);
        expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
        expect(await res.text(), path).toBe(expected);
        expect(assets.requests.map((r) => new URL(r.url).pathname), path).toEqual(["/event"]);
        expect(hasSecurityHeaders(res), path).toBe(true);
      }
    });

    it("answers HEAD with the headers and no body, and every other method with the JSON 404", async () => {
      const { env } = eventPageEnv();
      const head = await send(env, "/e/a/b", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await send(env, "/e/a/b", { method });
        expect(res.status, method).toBe(404);
        expect(await res.json(), method).toMatchObject({ error: { code: "not_found" } });
      }
    });

    it("does not treat /e/ (nothing after it) or /e as an event path: they go to the static files as the original request", async () => {
      for (const path of ["/e/", "/e"]) {
        const { seen, fetcher } = recordingAssets();
        const request = new Request(`${ORIGIN}${path}`);
        const res = await worker.fetch(request, { DB: noDb, ASSETS: fetcher } as AppEnv);
        expect(res.status, path).toBe(200);
        expect(await res.text(), path).toBe(`asset:${path}`);
        expect(seen, path).toEqual([request]);
      }
    });

    it("does not let an encoded or dotted variant reach the admin pages or API", async () => {
      const env = await passwordEnv(t.env.DB);
      const { assets } = eventPageEnv();
      const withAssets = { ...env, ASSETS: assets };
      // Encoded slashes and dots stay under /e/ and are only ever the generic event page.
      for (const path of ["/e/..%2Fadmin%2Findex.html", "/e/%2e%2e%2fadmin/", "/e/a/..%2f..%2fadmin/settings", "/e/%2e%2e%2f%2e%2e%2fapi%2fadmin%2fsession"]) {
        const res = await send(withAssets, path);
        expect(res.status, path).toBe(200);
        expect(await res.text(), path).not.toContain("admin");
      }
      expect(new Set(assets.requests.map((r) => new URL(r.url).pathname))).toEqual(new Set(["/event"]));
      // The URL parser resolves real dot segments first, so these are /admin paths and meet the guard.
      for (const path of ["/e/%2e%2e/admin/index.html", "/e/../admin/settings", "/e/a/../../admin/"]) {
        const res = await send(withAssets, path);
        expect(res.status, path).toBe(302);
        expect(res.headers.get("location"), path).toBe("/admin/login");
      }
      expect((await send(withAssets, "/e/%2e%2e/api/admin/session")).status).toBe(401);
    });
  });

  it("hands a route its decoded params", async () => {
    const env = { DB: t.env.DB } as AppEnv;
    const res = await send(env, "/api/events/not%20a%20real%20slug");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("response headers", () => {
  it("are on every kind of response, and a route's own CSP wins", async () => {
    const env = { ...(await passwordEnv(t.env.DB)), ASSETS: publicAssets() };
    for (const [path, init] of [
      ["/api/health", {}], ["/api/nothing", {}], ["/api/health", { method: "POST" }], ["/api/admin/session", {}], ["/admin/", {}],
      ["/", {}], ["/e/x", {}], ["/api/theme.css", {}], ["/favicon.ico", {}], ["/api/icon/180", {}], ["/api/logo", {}],
    ] as [string, RequestInit][]) {
      const res = await send(env, path, init);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        if (name === "Content-Security-Policy" && ["/favicon.ico", "/api/icon/180"].includes(path)) expect(res.headers.get(name), path).toBe("default-src 'none'; sandbox");
        else expect(res.headers.get(name), `${path} ${name}`).toBe(value);
      }
    }
  });

  it("are kept on a redirect from ASSETS, with its Location", async () => {
    const env = { DB: t.env.DB, ASSETS: { fetch: async () => Response.redirect(`${ORIGIN}/event`, 307) } } as unknown as AppEnv;
    const res = await send(env, "/lib.js");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/event`);
    expect(hasSecurityHeaders(res)).toBe(true);
  });
});

describe("plain http is refused outside loopback", () => {
  const env = () => ({ DB: t.env.DB, ASSETS: publicAssets() }) as AppEnv;
  const sendUrl = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init), env());

  it("redirects GET and HEAD to the same URL over https with 308, keeping path, query and port", async () => {
    for (const method of ["GET", "HEAD"]) {
      const res = await sendUrl("http://club.example/e/some-slug?a=1&b=%20x", { method });
      expect(res.status, method).toBe(308);
      expect(res.headers.get("location"), method).toBe("https://club.example/e/some-slug?a=1&b=%20x");
    }
    expect((await sendUrl("http://club.example:8080/admin/")).headers.get("location")).toBe("https://club.example:8080/admin/");
    expect((await sendUrl("http://club.example/")).headers.get("location")).toBe("https://club.example/");
    expect((await sendUrl("http://club.example.workers.dev/api/health")).status).toBe(308);
  });

  it("refuses every other method with 403 https_required (JSON, no-store), without reaching the database or the files", async () => {
    const guarded = { DB: noDb, ASSETS: { fetch: async () => { throw new Error("assets used"); } } } as unknown as AppEnv;
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await worker.fetch(new Request("http://club.example/api/setup", { method, headers: { Origin: "http://club.example" }, body: method === "POST" || method === "PUT" || method === "PATCH" ? "{}" : undefined }), guarded);
      expect(res.status, method).toBe(403);
      expect(res.headers.get("content-type"), method).toContain("application/json");
      expect(res.headers.get("cache-control"), method).toBe("no-store");
      expect(await res.json(), method).toMatchObject({ error: { code: "https_required" } });
      expect(hasSecurityHeaders(res), method).toBe(true);
    }
  });

  it("lets https through", async () => {
    expect((await sendUrl("https://club.example/api/health")).status).toBe(200);
    expect((await sendUrl("https://club.example/api/health", { method: "POST" })).status).toBe(405);
  });

  it("leaves loopback alone, whatever the method: localhost, *.localhost, 127.0.0.1 and [::1], with or without a port", async () => {
    for (const origin of ["http://localhost", "http://localhost:8787", "http://club.localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const get = await sendUrl(`${origin}/api/health`);
      expect(get.status, origin).toBe(200);
      expect(get.headers.get("location"), origin).toBeNull();
      expect((await sendUrl(`${origin}/api/health`, { method: "POST" })).status, origin).toBe(405); // routed, not refused as http
      expect((await sendUrl(`${origin}/lib.js`)).status, origin).toBe(200);
    }
  });

  it("leaves IP-literal hosts alone too (phone testing over the LAN): any dotted-quad IPv4 and any bracketed IPv6, with or without a port", async () => {
    for (const origin of ["http://192.168.1.20:8787", "http://10.0.0.5", "http://172.16.0.1:8787", "http://127.0.0.2:8787", "http://[fe80::1]:8787", "http://[2001:db8::1]:8787", "http://[::ffff:192.168.1.20]:8787"]) {
      const get = await sendUrl(`${origin}/api/health`);
      expect(get.status, origin).toBe(200);
      expect(get.headers.get("location"), origin).toBeNull();
      expect((await sendUrl(`${origin}/api/health`, { method: "POST" })).status, origin).toBe(405);
    }
  });

  it("does not take a look-alike host for loopback or an IP address", async () => {
    // (The URL parser already turns "1.2.3" into 1.2.0.3 and rejects "256.1.1.1", so neither reaches the Worker as a name.)
    for (const host of ["notlocalhost", "localhost.example", "localhost.example.com", "127.0.0.1.example", "127.0.0.1.evil.test", "192.168.1.20.example.com", "1.2.3.example", "club.example"]) {
      expect((await sendUrl(`http://${host}/api/health`)).status, host).toBe(308);
    }
  });

  it("sends Strict-Transport-Security (a year, nothing more) on every kind of response: JSON, a file, a redirect, a 404, a 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const redirecting = { DB: t.env.DB, ASSETS: { fetch: async () => Response.redirect(`${ORIGIN}/event`, 307) } } as unknown as AppEnv;
      const responses = [
        await send(env(), "/api/health"),
        await send(env(), "/lib.js"),
        await send(redirecting, "/lib.js"),
        await sendUrl("http://club.example/lib.js"),
        await sendUrl("http://club.example/api/setup", { method: "POST", body: "{}" }),
        await send(env(), "/api/nothing"),
        await send({ DB: t.env.DB } as AppEnv, "/"), // no ASSETS binding: 500
      ];
      expect(responses.map((r) => r.status)).toEqual([200, 200, 307, 308, 403, 404, 500]);
      for (const res of responses) expect(res.headers.get("strict-transport-security"), String(res.status)).toBe("max-age=31536000");
    } finally {
      log.mockRestore();
    }
  });
});

describe("failures", () => {
  it("answers an unexpected error with a plain 500 that says nothing about it, and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await send({ DB: t.env.DB } as AppEnv, "/"); // no ASSETS binding
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("Something went wrong.");
      expect(hasSecurityHeaders(res)).toBe(true);
      expect(log).toHaveBeenCalled();
      const throwing = { fetch: async () => { throw new Error("SECRET internals"); } } as unknown as Fetcher;
      const res2 = await send({ DB: t.env.DB, ASSETS: throwing } as AppEnv, "/style.css");
      expect(res2.status).toBe(500);
      expect(await res2.text()).not.toContain("SECRET");
    } finally {
      log.mockRestore();
    }
  });
});

describe("what the catch-all logs", () => {
  it("is the error's message only: not the error object, whose cause or properties can carry SQL and bound values", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = Object.assign(new Error("D1_ERROR: boom"), { cause: { sql: "INSERT INTO bookings VALUES (?)", params: ["jane@example.com"] } });
      const env = { DB: t.env.DB, ASSETS: { fetch: async () => { throw failing; } } } as unknown as AppEnv;
      expect((await send(env, "/style.css")).status).toBe(500);
      expect(log).toHaveBeenCalledTimes(1);
      const args = log.mock.calls[0];
      expect(args.every((a) => typeof a === "string")).toBe(true);
      expect(args.join(" ")).toContain("D1_ERROR: boom");
      expect(args.join(" ")).not.toMatch(/jane@example\.com|INSERT INTO/);
      log.mockClear();
      const odd = { fetch: async () => { throw "a string, not an Error"; } } as unknown as Fetcher;
      expect((await send({ DB: t.env.DB, ASSETS: odd } as AppEnv, "/style.css")).status).toBe(500);
      expect(log.mock.calls[0]).toEqual(["Unhandled error:", "unknown error"]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("first-run setup through the Worker", () => {
  const ip = (n: number) => `203.0.113.${n}`;
  const postJson = (env: AppEnv, path: string, body: unknown, n = 1, headers: Record<string, string> = {}) =>
    send(env, path, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip(n), ...headers }, body: JSON.stringify(body) });
  const reset = async () => {
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    await t.env.DB.prepare("DELETE FROM login_attempts").run();
  };
  const fresh = (): AppEnv => ({ ...d1Env(t.env.DB), ASSETS: recordingAssets().fetcher });

  it("serves GET /setup from the clean /setup asset when setup is open: no conditional headers, no-store, security headers", async () => {
    await reset();
    const { seen, fetcher } = recordingAssets();
    const res = await send({ ...d1Env(t.env.DB), ASSETS: fetcher }, "/setup", { headers: { "If-None-Match": '"x"', "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT", Cookie: "a=b" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset:/setup");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(hasSecurityHeaders(res)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(new URL(seen[0].url).pathname).toBe("/setup");
    expect(seen[0].headers.get("if-none-match")).toBeNull();
    expect(seen[0].headers.get("if-modified-since")).toBeNull();
    expect((await send({ ...d1Env(t.env.DB), ASSETS: fetcher }, "/setup", { method: "HEAD" })).status).toBe(200);
  });

  it("answers GET /setup with 404 when it is closed, without touching the assets: env mode, Access, any other ADMIN_AUTH, or after the first sign-in", async () => {
    await reset();
    const full = await passwordEnv(t.env.DB);
    const { seen, fetcher } = recordingAssets();
    for (const e of [{ ...full, SETUP_CODE }, d1Env(t.env.DB, { ADMIN_AUTH: "access" }), d1Env(t.env.DB, { ADMIN_PASSWORD_HASH: full.ADMIN_PASSWORD_HASH })]) {
      const res = await send({ ...e, ASSETS: fetcher }, "/setup");
      expect(res.status, String(e.ADMIN_AUTH)).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(hasSecurityHeaders(res)).toBe(true);
    }
    await t.env.DB.prepare("INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at, first_login_at) VALUES (1, ?, ?, ?, ?)")
      .bind(full.ADMIN_PASSWORD_HASH, "s".repeat(43), "2026-10-05T10:00:00.000Z", "2026-10-05T10:01:00.000Z").run();
    expect((await send({ ...d1Env(t.env.DB), ASSETS: fetcher }, "/setup")).status).toBe(404);
    expect(seen).toHaveLength(0);
    await reset();
  });

  it("answers GET /setup with the 503 text of setupNotReadyMessage, not the page, for a too-short SETUP_CODE and for an expired window", async () => {
    await reset();
    const { seen, fetcher } = recordingAssets();
    const short = await send({ ...d1Env(t.env.DB, { SETUP_CODE: "short" }), ASSETS: fetcher }, "/setup");
    expect(short.status).toBe(503);
    expect(short.headers.get("content-type")).toContain("text/plain");
    expect(short.headers.get("cache-control")).toBe("no-store");
    expect(await short.text()).toBe(setupNotReadyMessage("short_code"));
    await ageWindow(t.env.DB, 31 * 60_000);
    try {
      const expired = await send({ ...claimEnv(t.env.DB), ASSETS: fetcher }, "/setup");
      expect(expired.status).toBe(503);
      expect(expired.headers.get("content-type")).toContain("text/plain");
      expect(expired.headers.get("cache-control")).toBe("no-store");
      expect(await expired.text()).toBe(setupNotReadyMessage("expired"));
    } finally {
      await ageWindow(t.env.DB, 0);
    }
    expect(seen).toHaveLength(0);
  });

  it("serves GET /setup in the claim state (no SETUP_CODE, window open) and once a secret has been made but not used (claimed)", async () => {
    await reset();
    await ageWindow(t.env.DB, 0);
    for (const phase of ["claim", "claimed"]) {
      if (phase === "claimed") {
        await t.env.DB.prepare("INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at) VALUES (1, ?, ?, ?)")
          .bind((await passwordEnv(t.env.DB)).ADMIN_PASSWORD_HASH, "s".repeat(43), "2026-10-05T10:00:00.000Z").run();
      }
      const { seen, fetcher } = recordingAssets();
      const res = await send({ ...claimEnv(t.env.DB), ASSETS: fetcher }, "/setup");
      expect(res.status, phase).toBe(200);
      expect(await res.text(), phase).toBe("asset:/setup");
      expect(res.headers.get("cache-control"), phase).toBe("no-store");
      expect(seen, phase).toHaveLength(1);
    }
    await reset();
  });

  it("allows only GET and HEAD on /setup, and only GET, HEAD and POST on /api/setup", async () => {
    const env = fresh();
    for (const method of ["POST", "PUT", "DELETE"]) expect((await send(env, "/setup", { method })).status, method).toBe(405);
    expect((await send(env, "/setup", { method: "POST" })).headers.get("allow")).toBe("GET, HEAD");
    for (const method of ["PUT", "DELETE"]) expect((await send(env, "/api/setup", { method })).status, method).toBe(405);
    expect((await send(env, "/api/setup", { method: "PUT" })).headers.get("allow")).toBe("GET, HEAD, POST");
  });

  it("does not treat variants of the path as the page (no case folding, trailing slash or encoding)", async () => {
    await reset();
    const { seen, fetcher } = recordingAssets();
    const env = { ...d1Env(t.env.DB), ASSETS: fetcher };
    for (const path of ["/Setup", "/setup/", "/%73etup"]) {
      seen.length = 0;
      await send(env, path);
      // At most a plain pass-through of the request as asked: never the clean /setup page fetched on its behalf.
      expect(seen.map((r) => new URL(r.url).pathname), path).toEqual([path]);
    }
  });

  it("goes from nothing to a signed-in admin, then closes for good", async () => {
    await reset();
    const env = fresh();
    expect((await postJson(env, "/api/setup", { code: "wrong code here" })).status).toBe(401);
    const made = await postJson(env, "/api/setup", { code: SETUP_CODE });
    expect(made.status).toBe(200);
    expect(made.headers.get("set-cookie")).toBeNull(); // setup itself signs nobody in
    expect(hasSecurityHeaders(made)).toBe(true);
    const { secret } = (await made.json()) as { secret: string };
    expect((await send(env, "/api/admin/session")).status).toBe(401); // credentials exist, but no session yet

    const login = await postJson(env, "/api/admin/login", { password: secret }, 2);
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect((await send(env, "/api/admin/session", { headers: { Cookie: cookie } })).status).toBe(200);

    expect((await send(env, "/setup")).status).toBe(404);
    expect((await postJson(env, "/api/setup", { code: SETUP_CODE }, 3)).status).toBe(404);
    expect((await send(env, "/api/admin/session", { headers: { Cookie: cookie } })).status).toBe(200);
    const row = await t.env.DB.prepare("SELECT secret_hash, session_secret FROM admin_credentials").first<Record<string, string>>();
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("makes the old secret stop working when setup is run again before anyone has signed in", async () => {
    await reset();
    const env = fresh();
    const first = ((await (await postJson(env, "/api/setup", { code: SETUP_CODE })).json()) as { secret: string }).secret;
    const second = ((await (await postJson(env, "/api/setup", { code: SETUP_CODE })).json()) as { secret: string }).secret;
    expect((await postJson(env, "/api/admin/login", { password: first }, 4)).status).toBe(401);
    expect((await postJson(env, "/api/admin/login", { password: second }, 5)).status).toBe(200);
    expect((await postJson(env, "/api/admin/login", { password: first }, 6)).status).toBe(401);
  });

  it("answers 503 admin_not_configured on every admin route and method while there are no credentials, and 401 once there are (never a 200)", async () => {
    await reset();
    const env = fresh();
    for (const route of adminRoutes) {
      for (const method of METHODS) {
        const res = await send(env, fill(route.pattern), { method, headers: writeHeaders("anything") });
        expect(res.status, `${method} ${route.pattern}`).toBe(503);
        if (method !== "HEAD") expect(await res.json()).toMatchObject({ error: { code: "admin_not_configured" } });
      }
    }
    await postJson(env, "/api/setup", { code: SETUP_CODE });
    let n = 0;
    for (const route of adminRoutes) {
      for (const method of METHODS) {
        if (route.pattern === "/api/admin/login" && method === "POST") continue;
        const res = await send(env, fill(route.pattern), { method, headers: writeHeaders("anything") });
        expect(res.status, `${method} ${route.pattern}`).toBe(401);
        n++;
      }
    }
    expect(n).toBeGreaterThan(150);
    await reset();
  });

  it("sends the admin pages to /setup while there are no credentials and setup is open or claimable, and to a 503 when it is not ready", async () => {
    await reset();
    await ageWindow(t.env.DB, 0);
    for (const path of ["/admin", "/admin/", "/admin/login", "/admin/settings"]) {
      const { seen, fetcher } = recordingAssets();
      for (const env of [d1Env(t.env.DB), claimEnv(t.env.DB)]) {
        const res = await send({ ...env, ASSETS: fetcher }, path);
        expect(res.status, path).toBe(302);
        expect(res.headers.get("location"), path).toBe("/setup");
        expect(res.headers.get("cache-control"), path).toBe("no-store");
      }
      expect(seen, path).toHaveLength(0);
      const short = await send({ ...d1Env(t.env.DB, { SETUP_CODE: "short" }), ASSETS: fetcher }, path);
      expect(short.status, path).toBe(503);
      expect(short.headers.get("location"), path).toBeNull();
    }
    await ageWindow(t.env.DB, 31 * 60_000);
    try {
      for (const path of ["/admin", "/admin/login"]) {
        const res = await send({ ...claimEnv(t.env.DB), ASSETS: recordingAssets().fetcher }, path);
        expect(res.status, path).toBe(503);
        expect(res.headers.get("location"), path).toBeNull();
      }
    } finally {
      await ageWindow(t.env.DB, 0);
    }
  });

  it("keeps env mode exactly as it was: /setup and /api/setup are 404 and the admin sign-in is unaffected", async () => {
    await reset();
    const env = { ...(await passwordEnv(t.env.DB)), SETUP_CODE, ASSETS: recordingAssets().fetcher };
    expect((await send(env, "/setup")).status).toBe(404);
    expect((await postJson(env, "/api/setup", { code: SETUP_CODE })).status).toBe(404);
    expect((await postJson(env, "/api/admin/login", { password: TEST_PASSWORD }, 7)).status).toBe(200);
    expect(await t.env.DB.prepare("SELECT COUNT(*) AS n FROM admin_credentials").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("the landing page and the claim redirect", () => {
  /** The test database seen through a wrapper that records its SQL; a new object each time, so claimOpenCached's memo starts empty. */
  const spied = () => {
    const sql: string[] = [];
    const db = {
      prepare: (text: string) => { sql.push(text); return t.env.DB.prepare(text); },
      batch: (list: D1PreparedStatement[]) => t.env.DB.batch(list),
    } as unknown as D1Database;
    return { db, authReads: () => sql.filter((q) => q.includes("auth_settings")).length };
  };
  const open = async () => {
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    await ageWindow(t.env.DB, 0);
  };

  it("redirects GET / to /setup, no-store, while the claim window is open, without fetching the page", async () => {
    await open();
    const assets = pageAssets();
    const res = await send({ ...claimEnv(spied().db), ASSETS: assets }, "/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/setup");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(hasSecurityHeaders(res)).toBe(true);
    expect(assets.requests).toHaveLength(0);
  });

  it("answers HEAD / with the page's 200 and no redirect in the claim state, without reading auth_settings", async () => {
    await open();
    const { db, authReads } = spied();
    const res = await send({ ...claimEnv(db), ASSETS: pageAssets() }, "/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(authReads()).toBe(0);
  });

  it("leaves /e/<anything> and /api/events alone in the claim state, and reads auth_settings for neither", async () => {
    await open();
    const { db, authReads } = spied();
    const env = { ...claimEnv(db), ASSETS: pageAssets() };
    for (const path of ["/e/anything", "/e/a/b", "/api/events"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await send(env, path, { method });
        expect(res.status, `${method} ${path}`).not.toBe(302);
        expect(res.headers.get("location"), `${method} ${path}`).toBeNull();
      }
    }
    expect(authReads()).toBe(0);
  });

  it("serves the landing page again as soon as a secret has been made (a claimable result is never remembered)", async () => {
    await open();
    const env = { ...claimEnv(spied().db), ASSETS: pageAssets() };
    expect((await send(env, "/")).status).toBe(302);
    await t.env.DB.prepare("INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at) VALUES (1, ?, ?, ?)")
      .bind((await passwordEnv(t.env.DB)).ADMIN_PASSWORD_HASH, "s".repeat(43), "2026-10-05T10:00:00.000Z").run();
    const res = await send(env, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
  });

  it("does not redirect GET / when the site is not claimable, and reads auth_settings once for two requests in a row", async () => {
    await open();
    const { db, authReads } = spied();
    const env = { ...d1Env(db), ASSETS: pageAssets() }; // a SETUP_CODE is set: state open, not claim
    expect((await send(env, "/")).status).toBe(200);
    expect(authReads()).toBe(1);
    expect((await send(env, "/")).status).toBe(200);
    expect(authReads()).toBe(1);
  });
});

describe("the recovery page through the Worker", () => {
  const CODE_HASH = "hmac-sha256$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const setRecoveryHash = (hash: string | null) => t.env.DB.prepare("UPDATE auth_settings SET recovery_hash = ? WHERE id = 1").bind(hash).run();
  const state = async () => JSON.stringify([
    (await t.env.DB.prepare("SELECT * FROM auth_settings").all()).results,
    (await t.env.DB.prepare("SELECT * FROM admin_credentials").all()).results,
    (await t.env.DB.prepare("SELECT * FROM login_attempts").all()).results,
  ]);

  it("serves GET /recover from the clean /recover asset when a recovery code is stored: no conditional headers, no-store, security headers", async () => {
    await setRecoveryHash(CODE_HASH);
    try {
      const { seen, fetcher } = recordingAssets();
      const res = await send({ ...d1Env(t.env.DB), ASSETS: fetcher }, "/recover", { headers: { "If-None-Match": '"x"', "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT", Cookie: "a=b" } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("asset:/recover");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(hasSecurityHeaders(res)).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0].method).toBe("GET");
      expect(new URL(seen[0].url).pathname).toBe("/recover");
      expect(seen[0].headers.get("if-none-match")).toBeNull();
      expect(seen[0].headers.get("cookie")).toBeNull();
      expect((await send({ ...d1Env(t.env.DB), ASSETS: fetcher }, "/recover", { method: "HEAD" })).status).toBe(200);
    } finally {
      await setRecoveryHash(null);
    }
  });

  it("serves it in Access mode too, and with ADMIN_AUTH=access in the environment", async () => {
    await setRecoveryHash(CODE_HASH);
    try {
      const { fetcher } = recordingAssets();
      expect((await send({ ...d1Env(t.env.DB, { ADMIN_AUTH: "access" }), ASSETS: fetcher }, "/recover")).status).toBe(200);
    } finally {
      await setRecoveryHash(null);
    }
  });

  it("answers GET /recover with 404, without touching the assets, when no recovery code is stored or the credentials come from the environment", async () => {
    const { seen, fetcher } = recordingAssets();
    const full = await passwordEnv(t.env.DB);
    const res = await send({ ...d1Env(t.env.DB), ASSETS: fetcher }, "/recover");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(hasSecurityHeaders(res)).toBe(true);
    await setRecoveryHash(CODE_HASH);
    try {
      for (const over of [{ ADMIN_PASSWORD_HASH: full.ADMIN_PASSWORD_HASH }, { ADMIN_SESSION_SECRET: "s".repeat(43) }]) {
        const blocked = await send({ ...d1Env(t.env.DB, over), ASSETS: fetcher }, "/recover");
        expect(blocked.status, JSON.stringify(Object.keys(over))).toBe(404);
        expect(blocked.headers.get("cache-control")).toBe("no-store");
      }
    } finally {
      await setRecoveryHash(null);
    }
    expect(seen).toHaveLength(0);
  });

  it("never changes anything on GET or HEAD", async () => {
    await setRecoveryHash(CODE_HASH);
    try {
      const before = await state();
      const { fetcher } = recordingAssets();
      for (const method of ["GET", "HEAD"]) await send({ ...d1Env(t.env.DB), ASSETS: fetcher }, "/recover", { method });
      expect(await state()).toBe(before);
    } finally {
      await setRecoveryHash(null);
    }
  });

  it("allows only GET and HEAD on /recover, and only POST on /api/recover", async () => {
    const env = { ...d1Env(t.env.DB), ASSETS: recordingAssets().fetcher };
    for (const method of ["POST", "PUT", "DELETE"]) expect((await send(env, "/recover", { method })).status, method).toBe(405);
    expect((await send(env, "/recover", { method: "POST" })).headers.get("allow")).toBe("GET, HEAD");
    expect((await send(env, "/api/recover", { method: "GET" })).status).toBe(405);
    expect((await send(env, "/api/recover", { method: "GET" })).headers.get("allow")).toBe("POST");
  });

  it("does not treat variants of the path as the page", async () => {
    await setRecoveryHash(CODE_HASH);
    try {
      const { seen, fetcher } = recordingAssets();
      const env = { ...d1Env(t.env.DB), ASSETS: fetcher };
      for (const path of ["/Recover", "/recover/", "/%72ecover"]) {
        seen.length = 0;
        await send(env, path);
        expect(seen.map((r) => new URL(r.url).pathname), path).toEqual([path]);
      }
    } finally {
      await setRecoveryHash(null);
    }
  });
});

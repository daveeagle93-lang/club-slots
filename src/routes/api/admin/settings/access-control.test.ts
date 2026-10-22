import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../../../../server/env";
import {
  accessClaims, accessEnv, accessJwt, adminApp, jwksFetch, NOW, newAccessKey, ORIGIN, passwordEnv, TEST_PASSWORD, writeHeaders,
} from "../../../../server/auth/test-harness";
import { createTestEnv, type TestEnv } from "../../../../test/db";
import { makePng, toBase64 } from "../../../../test/images";
import { saveLogo } from "../../../../server/settings";
import { createHash } from "node:crypto";
import * as index from "./index";
import * as icons from "./icons/[size]";
import * as logo from "./logo";
import * as theme from "./theme";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

const GOOD_THEME = { primary: "#1b6b3a", accent: "#a1235f" };
const LOGO = makePng(8, 8);
const GOOD_ICON = { data: toBase64(makePng(32, 32)), background: "#0b5cad", logoSha256: createHash("sha256").update(LOGO).digest("hex") };
const GOOD_SETTINGS = { clubName: "Example Dog Club", privacyContact: { name: "Pat", email: "pat@example.org" }, website: "https://example.org/" };

interface Route {
  /** The file in this directory that holds the handler. */
  file: string;
  module: Record<string, unknown>;
  path: string;
  method: "GET" | "PUT" | "DELETE";
  /** The exported handler's name. */
  handler: string;
  body?: unknown;
  /** Route parameters, as the router extracts them from the pattern. */
  params?: Record<string, string>;
  /** What the database needs to hold for a signed-in request to this route to succeed. */
  prepare?: () => Promise<unknown>;
}

// Every route under src/routes/api/admin/settings/. The test further down fails if a file or an exported handler is missing here.
const ROUTES: Route[] = [
  { file: "index.ts", module: index, path: "/api/admin/settings", method: "GET", handler: "onRequestGet" },
  { file: "index.ts", module: index, path: "/api/admin/settings", method: "PUT", handler: "onRequestPut", body: GOOD_SETTINGS },
  { file: "logo.ts", module: logo, path: "/api/admin/settings/logo", method: "PUT", handler: "onRequestPut", body: { data: toBase64(makePng(8, 8)) } },
  { file: "logo.ts", module: logo, path: "/api/admin/settings/logo", method: "DELETE", handler: "onRequestDelete" },
  { file: "theme.ts", module: theme, path: "/api/admin/settings/theme", method: "PUT", handler: "onRequestPut", body: GOOD_THEME },
  { file: "theme.ts", module: theme, path: "/api/admin/settings/theme", method: "DELETE", handler: "onRequestDelete" },
  {
    file: "icons/[size].ts", module: icons, path: "/api/admin/settings/icons/32", method: "PUT", handler: "onRequestPut",
    params: { size: "32" }, body: GOOD_ICON, prepare: () => saveLogo(t.env.DB, LOGO, { type: "image/png", width: 8, height: 8 }),
  },
];

/** Puts the real handlers behind the real guard, as the Worker routes them. */
const routes = (context: { request: Request }): Response | Promise<Response> | undefined => {
  const { pathname } = new URL(context.request.url);
  const route = ROUTES.find((r) => r.path === pathname && r.method === context.request.method);
  return route ? (route.module[route.handler] as (c: unknown) => Response | Promise<Response>)({ ...context, params: route.params ?? {} }) : undefined;
};

interface Provider {
  name: "password" | "access";
  env: AppEnv;
  app: ReturnType<typeof adminApp>;
  auth(n?: number): Promise<Record<string, string>>;
}

async function passwordProvider(): Promise<Provider> {
  const env = await passwordEnv(t.env.DB);
  const app = adminApp({ now: () => NOW }, routes);
  return {
    name: "password", env, app,
    async auth(n = 0) {
      const res = await app(env, "/api/admin/login", {
        method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": `192.0.2.${150 + n}` },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      });
      expect(res.status).toBe(200);
      return { Cookie: res.headers.get("set-cookie")!.split(";")[0] };
    },
  };
}

async function accessProvider(): Promise<Provider> {
  const key = await newAccessKey("kid-1");
  const env = accessEnv(t.env.DB);
  const app = adminApp({ now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch }, routes);
  return {
    name: "access", env, app,
    async auth(n = 0) {
      return { "Cf-Access-Jwt-Assertion": await accessJwt(key, accessClaims({ exp: NOW / 1000 + 600 + n })) };
    },
  };
}

const csrfOf = async (p: Provider, auth: Record<string, string>): Promise<string> =>
  ((await (await p.app(p.env, "/api/admin/session", { headers: auth })).json()) as { csrfToken: string }).csrfToken;

const stateOf = async () => ({
  settings: await t.env.DB.prepare("SELECT club_name, website_url, theme_primary, theme_accent, updated_at FROM site_settings").first(),
  logos: (await t.env.DB.prepare("SELECT COUNT(*) AS n FROM site_logo").first<{ n: number }>())!.n,
  icons: (await t.env.DB.prepare("SELECT COUNT(*) AS n FROM site_icons").first<{ n: number }>())!.n,
});

describe("settings routes are admin-only and CSRF-protected", () => {
  describe.each([["password", passwordProvider], ["access", accessProvider]] as const)("with the %s provider", (_name, make) => {
    let p: Provider;
    beforeAll(async () => { p = await make(); });

    const send = (r: Route, headers: Record<string, string>, over: { env?: AppEnv; body?: string } = {}) =>
      p.app(over.env ?? p.env, r.path, {
        method: r.method, headers, body: r.method === "GET" ? undefined : (over.body ?? (r.body === undefined ? undefined : JSON.stringify(r.body))),
      });
    const writes = ROUTES.filter((r) => r.method !== "GET");

    it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))("%s: unauthenticated is 401, even with a token, Origin and JSON", async (_label, r) => {
      const res = await send(r, writeHeaders("anything"));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" }, provider: p.name });
    });

    it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))("%s: a signed-in admin succeeds", async (_label, r) => {
      const auth = await p.auth();
      await r.prepare?.();
      const res = await send(r, r.method === "GET" ? auth : writeHeaders(await csrfOf(p, auth), auth));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it.each(writes.map((r) => [`${r.method} ${r.path}`, r] as const))("%s: refused without the CSRF token, with a wrong one, or from another session", async (_label, r) => {
      const auth = await p.auth(1);
      const token = await csrfOf(p, auth);
      const before = await stateOf();
      const attempts: [string, Record<string, string>, number][] = [
        ["no token", { ...auth, Origin: ORIGIN, "Content-Type": "application/json" }, 403],
        ["wrong token", writeHeaders("wrong", auth), 403],
        ["another session's token", writeHeaders(await csrfOf(p, await p.auth(2)), auth), 403],
        ["wrong Origin", writeHeaders(token, { ...auth, Origin: "https://evil.example" }), 403],
        ["no Origin", { ...auth, "Content-Type": "application/json", "X-CSRF-Token": token }, 403],
        ["cross-site fetch metadata", writeHeaders(token, { ...auth, "Sec-Fetch-Site": "cross-site" }), 403],
        ["text/plain", writeHeaders(token, { ...auth, "Content-Type": "text/plain" }), 415],
        ["a form post", writeHeaders(token, { ...auth, "Content-Type": "application/x-www-form-urlencoded" }), 415],
        ["an image type", writeHeaders(token, { ...auth, "Content-Type": "image/png" }), 415],
        ["no Content-Type", { ...auth, Origin: ORIGIN, "X-CSRF-Token": token }, 415],
      ];
      for (const [label, headers, status] of attempts) {
        const res = await send(r, headers);
        expect(res.status, label).toBe(status);
        expect(res.headers.get("cache-control"), label).toBe("no-store");
      }
      expect(await stateOf()).toEqual(before);
    });

    it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))("%s: 503 when ADMIN_AUTH is empty or wrong, even with credentials", async (_label, r) => {
      const headers = r.method === "GET" ? { ...(await p.auth()) } : writeHeaders("x", await p.auth());
      for (const ADMIN_AUTH of ["", "none", "Password"]) {
        const res = await send(r, headers, { env: { ...p.env, ADMIN_AUTH } });
        expect(res.status, String(ADMIN_AUTH)).toBe(503);
        expect(await res.json()).toMatchObject({ error: { code: "admin_not_configured" } });
      }
    });

    it("refused requests change nothing, and an accepted PUT then DELETE does", async () => {
      const before = await stateOf();
      for (const r of ROUTES) await send(r, r.method === "GET" ? {} : writeHeaders("x"));
      expect(await stateOf()).toEqual(before);

      const auth = await p.auth();
      const headers = writeHeaders(await csrfOf(p, auth), auth);
      const [, putSettings, putLogo, deleteLogo, putTheme, deleteTheme, putIcon] = ROUTES;
      expect((await send(putSettings, headers)).status).toBe(200);
      expect((await send(putLogo, headers)).status).toBe(200);
      expect((await send(putTheme, headers)).status).toBe(200);
      expect((await stateOf())).toMatchObject({ settings: { club_name: "Example Dog Club", theme_primary: "#1b6b3a", theme_accent: "#a1235f" }, logos: 1 });
      expect((await send(deleteTheme, headers)).status).toBe(200);
      expect((await stateOf())).toMatchObject({ settings: { theme_primary: null, theme_accent: null } });
      expect((await send(putIcon, headers)).status).toBe(200);
      expect((await stateOf())).toMatchObject({ logos: 1, icons: 1 });
      expect((await send(deleteLogo, headers)).status).toBe(200);
      expect((await stateOf())).toMatchObject({ logos: 0, icons: 0 });
    });
  });

  describe("handlers called directly, with no admin set by the guard", () => {
    it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))("%s answers 401 and changes nothing", async (_label, r) => {
      const before = await stateOf();
      for (const data of [undefined, {}, { admin: null }, { admin: { identity: "" } }, { admin: { csrfBinding: "x" } }]) {
        const res = await Promise.resolve((r.module[r.handler] as (c: unknown) => Response | Promise<Response>)({
          request: new Request(`${ORIGIN}${r.path}`, {
            method: r.method, headers: { "Content-Type": "application/json" }, body: r.method === "GET" ? undefined : JSON.stringify(r.body ?? {}),
          }),
          env: t.env, data, params: r.params ?? {},
        }));
        expect(res.status, JSON.stringify(data)).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
      expect(await stateOf()).toEqual(before);
    });
  });

  describe("the list above is complete", () => {
    it("names every file under src/routes/api/admin/settings/", () => {
      const dir = dirname(fileURLToPath(import.meta.url));
      const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => f.replaceAll("\\", "/"))
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
      expect(files).toEqual([...new Set(ROUTES.map((r) => r.file))].sort());
    });

    it("names every request handler each file exports", () => {
      const exported = (m: Record<string, unknown>) => Object.keys(m).filter((k) => k.startsWith("onRequest")).sort();
      for (const file of new Set(ROUTES.map((r) => r.file))) {
        const module = ROUTES.find((r) => r.file === file)!.module;
        expect(exported(module), file).toEqual(ROUTES.filter((r) => r.file === file).map((r) => r.handler).sort());
      }
    });
  });
});

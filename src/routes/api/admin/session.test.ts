import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminAuthFor } from "../../../server/auth";
import {
  ACCESS_AUD, ACCESS_TEAM, accessClaims, accessEnv, accessJwt, adminApp, jwksFetch, NOW, newAccessKey, ORIGIN, passwordEnv, TEST_PASSWORD,
} from "../../../server/auth/test-harness";
import { csrfToken } from "../../../server/auth/csrf";
import { createTestEnv, type TestEnv } from "../../../test/db";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });
// Tests here pin Access into the shared settings row; each starts from the password default.
beforeEach(async () => {
  await t.env.DB.prepare(
    "UPDATE auth_settings SET mode = 'password', access_team_domain = NULL, access_aud = NULL, access_hostname = NULL, changed_at = NULL, changed_by = NULL WHERE id = 1",
  ).run();
});

describe("GET /api/admin/session", () => {
  it("with Access: the verified email, the provider and a token bound to the JWT", async () => {
    const key = await newAccessKey("k");
    const app = adminApp({ now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch });
    const jwt = await accessJwt(key);
    const res = await app(accessEnv(t.env.DB), "/api/admin/session", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ identity: "admin@club.example", provider: "access", storedMode: "access", csrfToken: await csrfToken(jwt) });
    // A refreshed JWT is a new binding, so the token changes: clients re-fetch on csrf_failed.
    const refreshed = await accessJwt(key, accessClaims({ exp: NOW / 1000 + 900 }));
    const again = (await (await app(accessEnv(t.env.DB), "/api/admin/session", { headers: { "Cf-Access-Jwt-Assertion": refreshed } })).json()) as { csrfToken: string };
    expect(again.csrfToken).not.toBe(await csrfToken(jwt));
  });

  it("with a password: 401 with no cookie", async () => {
    const app = adminApp({ now: () => NOW });
    const res = await app(await passwordEnv(t.env.DB), "/api/admin/session");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" }, provider: "password" });
  });

  it("with no session: the 401 does not say the stored mode", async () => {
    const app = adminApp({ now: () => NOW });
    const res = await app(await passwordEnv(t.env.DB), "/api/admin/session");
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("storedMode");
  });
});

describe("GET /api/admin/session: pinning env Access into auth_settings", () => {
  const settings = () => t.env.DB.prepare(
    "SELECT mode, access_team_domain, access_aud, access_hostname, changed_at, changed_by FROM auth_settings WHERE id = 1",
  ).first();

  it("writes the pin on a verified Access sign-in, once, and then Access holds without ADMIN_AUTH", async () => {
    const key = await newAccessKey("k");
    const deps = { now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch };
    const app = adminApp(deps);
    const headers = { "Cf-Access-Jwt-Assertion": await accessJwt(key) };
    expect((await app(accessEnv(t.env.DB), "/api/admin/session", { headers })).status).toBe(200);
    const pinned = await settings();
    expect(pinned).toMatchObject({ mode: "access", access_team_domain: ACCESS_TEAM, access_aud: ACCESS_AUD, access_hostname: "club.example", changed_by: "import" });
    expect((await app(accessEnv(t.env.DB), "/api/admin/session", { headers })).status).toBe(200);
    expect(await settings()).toEqual(pinned); // identical values: nothing written, changed_at kept

    // The env line is lost: D1 alone now selects Access, with the pinned values.
    const lost = await adminAuthFor({ DB: t.env.DB }, deps);
    expect("auth" in lost && lost.auth.kind).toBe("access");
    const viaApp = await app({ DB: t.env.DB }, "/api/admin/session", { headers });
    expect(viaApp.status).toBe(200);
    expect(await viaApp.json()).toMatchObject({ identity: "admin@club.example", provider: "access" });
  });

  it("never writes with the password provider", async () => {
    const app = adminApp({ now: () => NOW });
    const env = await passwordEnv(t.env.DB);
    const login = await app(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.18.0.1" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect((await app(env, "/api/admin/session", { headers: { Cookie: cookie } })).status).toBe(200);
    expect(await settings()).toMatchObject({ mode: "password", access_team_domain: null, changed_by: null });
  });

  it("reports the stored mode for a password sign-in", async () => {
    const app = adminApp({ now: () => NOW });
    const env = await passwordEnv(t.env.DB);
    const login = await app(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.18.0.1" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const res = await app(env, "/api/admin/session", { headers: { Cookie: cookie } });
    expect(await res.json()).toMatchObject({ provider: "password", storedMode: "password" });
  });

  it("reports null when the auth_settings row is gone", async () => {
    const key = await newAccessKey("k");
    const app = adminApp({ now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch });
    const jwt = await accessJwt(key);
    await t.env.DB.prepare("DELETE FROM auth_settings").run();
    try {
      const res = await app(accessEnv(t.env.DB), "/api/admin/session", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ provider: "access", storedMode: null });
    } finally {
      await t.env.DB.prepare("INSERT INTO auth_settings (id, setup_opened_at) VALUES (1, '2026-10-22T10:00:00.000Z')").run();
    }
  });

  it("still answers with a null stored mode when reading it fails, and logs the message only", async () => {
    const key = await newAccessKey("k");
    const app = adminApp({ now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch });
    const jwt = await accessJwt(key);
    const db = new Proxy(t.env.DB, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop).bind(target);
        return (sql: string) => {
          if (sql.startsWith("SELECT mode FROM auth_settings")) throw new Error("read blocked");
          return target.prepare(sql);
        };
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app(accessEnv(db), "/api/admin/session", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ identity: "admin@club.example", provider: "access", storedMode: null });
      expect(logged.mock.calls).toEqual([["Stored mode read failed: read blocked"]]);
    } finally {
      logged.mockRestore();
    }
  });

  it("still answers when the pin fails, and logs the message only", async () => {
    const key = await newAccessKey("k");
    const app = adminApp({ now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch });
    const jwt = await accessJwt(key);
    await t.env.DB.prepare("DROP TRIGGER IF EXISTS fail_pin").run();
    await t.env.DB.prepare("CREATE TRIGGER fail_pin BEFORE UPDATE ON auth_settings BEGIN SELECT RAISE(ABORT, 'pin blocked'); END").run();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app(accessEnv(t.env.DB), "/api/admin/session", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
      expect(res.status).toBe(200);
      // The provider follows the env line, the stored mode is what D1 holds: they differ here.
      expect(await res.json()).toMatchObject({ identity: "admin@club.example", provider: "access", storedMode: "password" });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logged.mock.calls)).not.toContain(jwt);
    } finally {
      logged.mockRestore();
      await t.env.DB.prepare("DROP TRIGGER fail_pin").run();
    }
    expect(await settings()).toMatchObject({ mode: "password" });
  });
});

describe("POST /api/admin/logout", () => {
  it("with a password: clears the cookie with the same attributes and Max-Age=0", async () => {
    const app = adminApp({ now: () => NOW });
    const env = await passwordEnv(t.env.DB);
    const login = await app(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.18.0.1" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const { csrfToken: token } = (await login.json()) as { csrfToken: string };
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const headers = { Origin: ORIGIN, "Content-Type": "application/json", Cookie: cookie };
    expect((await app(env, "/api/admin/logout", { method: "POST", headers, body: "{}" })).status).toBe(403); // no token
    const res = await app(env, "/api/admin/logout", { method: "POST", headers: { ...headers, "X-CSRF-Token": token }, body: "{}" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBe("__Host-sb_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("with Access: points at the Access logout URL and sets no cookie", async () => {
    const key = await newAccessKey("k");
    const app = adminApp({ now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch });
    const env = accessEnv(t.env.DB);
    const jwt = await accessJwt(key);
    const res = await app(env, "/api/admin/logout", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt, "X-CSRF-Token": await csrfToken(jwt) },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ logoutUrl: "/cdn-cgi/access/logout" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("requires a session", async () => {
    const app = adminApp({ now: () => NOW });
    const res = await app(await passwordEnv(t.env.DB), "/api/admin/logout", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});

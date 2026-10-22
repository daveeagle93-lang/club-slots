import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../server/env";
import {
  accessClaims, accessEnv, accessJwt, adminApp, d1Env, jwksFetch, NOW, newAccessKey, ORIGIN, passwordEnv, TEST_PASSWORD,
  writeHeaders,
} from "../server/auth/test-harness";
import { createTestEnv, type TestEnv } from "../test/db";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });
// A verified Access sign-in pins Access into the shared settings row; each test starts from the password default.
beforeEach(async () => {
  await t.env.DB.prepare(
    "UPDATE auth_settings SET mode = 'password', access_team_domain = NULL, access_aud = NULL, access_hostname = NULL, changed_at = NULL, changed_by = NULL WHERE id = 1",
  ).run();
});

interface Provider {
  name: "password" | "access";
  env: AppEnv;
  app: ReturnType<typeof adminApp>;
  /** Headers that authenticate one particular session; `n` picks which. */
  auth(n?: number): Promise<Record<string, string>>;
  identity: string;
}

async function passwordProvider(): Promise<Provider> {
  const env = await passwordEnv(t.env.DB);
  const app = adminApp({ now: () => NOW });
  return {
    name: "password", env, app, identity: "admin",
    async auth(n = 0) {
      const res = await app(env, "/api/admin/login", {
        method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": `192.0.2.${100 + n}` },
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
  const app = adminApp({ now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch });
  return {
    name: "access", env, app, identity: "admin@club.example",
    async auth(n = 0) {
      return { "Cf-Access-Jwt-Assertion": await accessJwt(key, accessClaims({ exp: NOW / 1000 + 600 + n })) };
    },
  };
}

const csrfOf = async (p: Provider, auth: Record<string, string>): Promise<string> =>
  ((await (await p.app(p.env, "/api/admin/session", { headers: auth })).json()) as { csrfToken: string }).csrfToken;

describe.each([["password", passwordProvider], ["access", accessProvider]] as const)("admin API guard with the %s provider", (_name, make) => {
  let p: Provider;
  beforeAll(async () => { p = await make(); });

  it("answers an unauthenticated request with 401, no-store, whatever the path or method", async () => {
    for (const [path, method] of [
      ["/api/admin/session", "GET"], ["/api/admin/events", "GET"], ["/api/admin/nope", "GET"], ["/api/admin", "GET"],
      ["/api/admin/nope", "POST"], ["/api/admin/nope", "DELETE"], ["/api/admin/whoami", "PATCH"], ["/api/admin/logout", "POST"],
      ["/api/admin/nope", "HEAD"], ["/api/admin/nope", "OPTIONS"],
    ]) {
      const res = await p.app(p.env, path, { method, headers: writeHeaders("anything") });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      if (method !== "HEAD") {
        expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" }, provider: p.name });
      }
    }
  });

  it("does not reach the handler unauthenticated, but does when authenticated (unknown paths included)", async () => {
    expect((await p.app(p.env, "/api/admin/nope")).status).toBe(401);
    const res = await p.app(p.env, "/api/admin/nope", { headers: await p.auth() });
    expect(res.status).toBe(404); // from the harness stand-in for the router's 404, so the guard let it through
    expect(await res.text()).toBe("not found");
  });

  it("sets data.admin for downstream handlers", async () => {
    const res = await p.app(p.env, "/api/admin/whoami", { headers: await p.auth() });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { admin: { identity: string; csrfBinding: string } } };
    expect(data.admin.identity).toBe(p.identity);
    expect(data.admin.csrfBinding.length).toBeGreaterThan(10);
  });

  it("lets safe methods through without a token", async () => {
    const auth = await p.auth();
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect((await p.app(p.env, "/api/admin/whoami", { method, headers: auth })).status, method).toBe(200);
    }
  });

  it("requires the full CSRF set on every state-changing method", async () => {
    const auth = await p.auth(1);
    const token = await csrfOf(p, auth);
    const send = (headers: Record<string, string>, method = "POST") =>
      p.app(p.env, "/api/admin/whoami", { method, headers: { ...auth, ...headers }, body: method === "DELETE" ? undefined : "{}" });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await send(writeHeaders(token), method)).status, method).toBe(200);
      expect((await send({ Origin: ORIGIN, "Content-Type": "application/json" }, method)).status, `${method} without token`).toBe(403);
    }
    const bad = (await send(writeHeaders("wrong"))).status;
    const crossSite = (await send(writeHeaders(token, { "Sec-Fetch-Site": "cross-site" }))).status;
    const foreign = (await send(writeHeaders(token, { Origin: "https://evil.example" }))).status;
    const noOrigin = (await p.app(p.env, "/api/admin/whoami", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-CSRF-Token": token }, body: "{}",
    })).status;
    const wrongType = (await send(writeHeaders(token, { "Content-Type": "text/plain" }))).status;
    const otherSession = (await send(writeHeaders(await csrfOf(p, await p.auth(2))))).status;
    expect({ bad, crossSite, foreign, noOrigin, wrongType, otherSession }).toEqual({
      bad: 403, crossSite: 403, foreign: 403, noOrigin: 403, wrongType: 415, otherSession: 403,
    });
    expect((await send(writeHeaders(token, { "Sec-Fetch-Site": "same-origin" }))).status).toBe(200);
  });

  it("checks authentication before CSRF", async () => {
    expect((await p.app(p.env, "/api/admin/whoami", { method: "POST", headers: writeHeaders("x") })).status).toBe(401);
  });
});

describe("login route exemption", () => {
  it("exists, unauthenticated and without a token, only with the password provider, and only for POST", async () => {
    const p = await passwordProvider();
    const attempt = (headers: Record<string, string>, method = "POST", path = "/api/admin/login") =>
      p.app(p.env, path, { method, headers: { "Content-Type": "application/json", ...headers }, body: method === "GET" ? undefined : JSON.stringify({ password: "wrong" }) });
    expect((await attempt({ Origin: ORIGIN })).status).toBe(401); // reached the handler: invalid_credentials
    expect((await attempt({ Origin: "https://evil.example" })).status).toBe(403);
    expect((await attempt({})).status).toBe(403);
    expect((await attempt({ Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect(await (await attempt({ Origin: ORIGIN }, "GET")).json()).toMatchObject({ error: { code: "unauthenticated" } });
    // Only the exact path is exempt.
    for (const path of ["/api/admin/login/", "/api/admin/LOGIN", "/api/admin/login2", "/api/admin/login/x"]) {
      expect((await attempt({ Origin: ORIGIN }, "POST", path)).status, path).toBe(401);
      expect(await (await attempt({ Origin: ORIGIN }, "POST", path)).json()).toMatchObject({ error: { code: "unauthenticated" } });
    }
  });

  it("does not exist with the Access provider, signed in or not", async () => {
    const p = await accessProvider();
    for (const headers of [{}, await p.auth()]) {
      const res = await p.app(p.env, "/api/admin/login", { method: "POST", headers: writeHeaders("x", headers) });
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("unconfigured admin", () => {
  it("answers 503 on every admin path and method, even with credentials, and never falls open", async () => {
    const good = await passwordEnv(t.env.DB);
    const variants: AppEnv[] = [
      { ...good, ADMIN_AUTH: "" }, { ...good, ADMIN_AUTH: "none" }, { ...good, ADMIN_AUTH: "Password" },
      { ...good, ADMIN_AUTH: "ACCESS" }, { ...good, ADMIN_PASSWORD_HASH: "pbkdf2-sha256$100000$bad$bad" },
      { ...good, ADMIN_SESSION_SECRET: "short" }, { ...accessEnv(t.env.DB), ACCESS_TEAM_DOMAIN: "evil.example" },
    ];
    const app = adminApp({ now: () => NOW });
    for (const env of variants) {
      for (const [path, method] of [
        ["/api/admin/session", "GET"], ["/api/admin/login", "POST"], ["/api/admin/logout", "POST"], ["/api/admin/events", "GET"],
        ["/api/admin/nope", "DELETE"], ["/api/admin", "GET"], ["/api/admin/whoami", "GET"],
      ]) {
        const res = await app(env, path, { method, headers: writeHeaders("x", { "Cf-Access-Jwt-Assertion": "x.y.z" }), body: method === "GET" ? undefined : "{}" });
        expect(res.status, `${env.ADMIN_AUTH} ${method} ${path}`).toBe(503);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toMatchObject({ error: { code: "admin_not_configured" } });
      }
    }
  });
});

describe("admin API with credentials in D1 (the password provider with no ADMIN_PASSWORD_HASH or ADMIN_SESSION_SECRET)", () => {
  const paths: [string, string][] = [
    ["/api/admin/session", "GET"], ["/api/admin/login", "POST"], ["/api/admin/logout", "POST"], ["/api/admin/events", "GET"],
    ["/api/admin/nope", "DELETE"], ["/api/admin", "GET"], ["/api/admin/whoami", "GET"],
  ];
  const app = adminApp({ now: () => NOW });

  it("answers 503 admin_not_configured on every admin path and method while there are no credentials, login included", async () => {
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    for (const [path, method] of paths) {
      const res = await app(d1Env(t.env.DB), path, { method, headers: writeHeaders("x"), body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: { code: "admin_not_configured" } });
    }
  });

  it("answers 401 unauthenticated once credentials exist, and lets the login route through", async () => {
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    const hash = (await passwordEnv(t.env.DB)).ADMIN_PASSWORD_HASH!;
    await t.env.DB.prepare("INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at) VALUES (1, ?, ?, ?)")
      .bind(hash, "s".repeat(43), "2026-10-05T10:00:00.000Z").run();
    for (const [path, method] of paths) {
      if (path === "/api/admin/login") continue;
      const res = await app(d1Env(t.env.DB), path, { method, headers: writeHeaders("x"), body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" }, provider: "password" });
    }
    const login = await app(d1Env(t.env.DB), "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.201" }, body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(login.status).toBe(200);
  });

  it("does not let stored credentials rescue env mode: one variable set, the other missing, is 503", async () => {
    const hash = (await passwordEnv(t.env.DB)).ADMIN_PASSWORD_HASH!;
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    await t.env.DB.prepare("INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at) VALUES (1, ?, ?, ?)")
      .bind(hash, "s".repeat(43), "2026-10-05T10:00:00.000Z").run();
    for (const env of [d1Env(t.env.DB, { ADMIN_PASSWORD_HASH: hash }), d1Env(t.env.DB, { ADMIN_SESSION_SECRET: "s".repeat(43) })]) {
      const res = await app(env, "/api/admin/session", { headers: writeHeaders("x") });
      expect(res.status).toBe(503);
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "../../test/db";
import type { AppEnv } from "../env";
import { saveCredentials } from "./credentials";
import { generateAdminSecret, hashAdminSecret } from "./crypto";
import { adminAuthFor } from "./index";
import { issueSession, SESSION_COOKIE } from "./session";

let hash: string;
let t: TestEnv;
beforeAll(async () => { hash = await hashAdminSecret(generateAdminSecret()); t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });
beforeEach(async () => {
  await t.env.DB.prepare("DELETE FROM admin_credentials").run();
  await t.env.DB.prepare("UPDATE auth_settings SET mode = 'password', access_team_domain = NULL, access_aud = NULL, access_hostname = NULL, changed_by = NULL WHERE id = 1").run();
});
// A database with no settings row and no credentials row, and nothing else, for the settings that must not need one.
const noRow = { prepare: () => ({ first: async () => null }), batch: async () => [{ results: [] }, { results: [] }] } as unknown as D1Database;
const env = (over: Partial<AppEnv>): AppEnv => ({ DB: noRow, ...over });
/** A database that fails the test if anything uses it. */
const noDb = new Proxy({}, { get: (_t, key) => { throw new Error(`The database was used (${String(key)})`); } }) as D1Database;
const SECRET = "s".repeat(32);

describe("adminAuthFor: the sign-in mode (design 3.8)", () => {
  const ACCESS = { ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" };
  const setMode = (mode: "password" | "access") => t.env.DB.prepare(
    "UPDATE auth_settings SET mode = ?, access_team_domain = ?, access_aud = ?, access_hostname = ?, changed_by = ? WHERE id = 1",
  ).bind(mode, mode === "access" ? "d1club.cloudflareaccess.com" : null, mode === "access" ? "d1-aud" : null, mode === "access" ? "club.example" : null, mode === "access" ? "wizard" : null).run();
  const accessOf = (r: Awaited<ReturnType<typeof adminAuthFor>>) => {
    if (!("auth" in r) || r.auth.kind !== "access") throw new Error(`expected Access, got ${JSON.stringify(r)}`);
    return r.auth;
  };

  it("env access decides without reading D1 at all", async () => {
    const throwing = { prepare: () => { throw new Error("prepare used"); }, batch: () => { throw new Error("batch used"); } } as unknown as D1Database;
    expect(accessOf(await adminAuthFor(env({ DB: throwing, ADMIN_AUTH: "access", ...ACCESS })))).toBeDefined();
    expect(await adminAuthFor(env({ DB: throwing, ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "evil.example", ACCESS_AUD: "aud" }))).toMatchObject({ error: "not_configured" });
  });

  // A well-formed token with an unknown kid makes the provider fetch the keys from the team domain it was built with.
  const seg = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const keysUrlOf = async (e: AppEnv): Promise<string[]> => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => { urls.push(url); return new Response("", { status: 500 }); }) as unknown as typeof fetch;
    const auth = accessOf(await adminAuthFor(e, { fetch: fetcher }));
    await auth.authenticate(new Request("https://club.example/", { headers: { "Cf-Access-Jwt-Assertion": `${seg({ alg: "RS256", kid: "k" })}.${seg({})}.AAAA` } }));
    return urls;
  };

  it("env access takes its values from env, not from D1", async () => {
    await setMode("access");
    expect(await keysUrlOf(env({ DB: t.env.DB, ADMIN_AUTH: "access", ...ACCESS }))).toEqual(["https://club.cloudflareaccess.com/cdn-cgi/access/certs"]);
  });

  it("unset or password, with D1 access: Access from the D1 values", async () => {
    await setMode("access");
    for (const ADMIN_AUTH of [undefined, "password"]) {
      expect(await keysUrlOf(env({ DB: t.env.DB, ADMIN_AUTH })), String(ADMIN_AUTH)).toEqual(["https://d1club.cloudflareaccess.com/cdn-cgi/access/certs"]);
    }
  });

  it("D1 access beats leftover env password credentials", async () => {
    await setMode("access");
    const r = await adminAuthFor(env({ DB: t.env.DB, ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET }));
    expect(accessOf(r)).toBeDefined();
    expect(accessOf(await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET })))).toBeDefined();
  });

  it("D1 access with values that are unusable fails closed", async () => {
    await setMode("access");
    await t.env.DB.prepare("UPDATE auth_settings SET access_team_domain = 'evil.example' WHERE id = 1").run();
    expect(await adminAuthFor(env({ DB: t.env.DB }))).toMatchObject({ error: "not_configured" });
  });

  it("names the stored settings, not the environment variables, when the D1 Access settings are unusable", async () => {
    await setMode("access");
    await t.env.DB.prepare("UPDATE auth_settings SET access_team_domain = 'evil.example' WHERE id = 1").run();
    expect(await adminAuthFor(env({ DB: t.env.DB }))).toEqual({
      error: "not_configured", reason: "the stored Access settings in auth_settings are unusable (team domain or AUD)",
    });
    expect(await adminAuthFor(env({ DB: noRow, ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "evil.example", ACCESS_AUD: "aud" }))).toEqual({
      error: "not_configured", reason: "ACCESS_TEAM_DOMAIN must be a cloudflareaccess.com host and ACCESS_AUD must be set",
    });
  });

  it("unset, D1 password, no credentials: awaiting setup, with the reworded reason", async () => {
    expect(await adminAuthFor(env({ DB: t.env.DB }))).toEqual({
      error: "not_configured", reason: "no admin credentials yet: open /setup", awaitingSetup: true,
    });
  });

  it("unset, D1 password, credentials in D1 or in env: the password provider", async () => {
    const fromEnv = await adminAuthFor(env({ DB: t.env.DB, ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET }));
    expect("auth" in fromEnv && fromEnv.auth.kind).toBe("password");
    await saveCredentials(t.env.DB, { secretHash: hash, sessionSecret: "u".repeat(43), createdAt: "2026-10-05T10:00:00.000Z" });
    const fromD1 = await adminAuthFor(env({ DB: t.env.DB }));
    expect("auth" in fromD1 && fromD1.auth.kind).toBe("password");
  });

  it("anything but unset, password or access is not_configured, whatever D1 says", async () => {
    for (const mode of ["password", "access"] as const) {
      await setMode(mode);
      for (const ADMIN_AUTH of ["", "Password", " access", "none", "ACCESS"]) {
        expect(await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH })), `${mode} ${JSON.stringify(ADMIN_AUTH)}`).toMatchObject({ error: "not_configured" });
      }
    }
  });
});

describe("adminAuthFor", () => {
  it("selects Access when it is configured", async () => {
    const r = await adminAuthFor(env({ ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" }));
    expect("auth" in r && r.auth.kind).toBe("access");
  });

  it("selects the password provider when it is configured", async () => {
    const r = await adminAuthFor(env({ ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET }));
    expect("auth" in r && r.auth.kind).toBe("password");
  });

  it("fails closed for anything else", async () => {
    const good = { ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET, ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" };
    for (const ADMIN_AUTH of ["", "none", "off", "Password", "ACCESS", " access", "password ", "true", "access,password"]) {
      expect(await adminAuthFor(env({ ...good, ADMIN_AUTH })), String(ADMIN_AUTH)).toMatchObject({ error: "not_configured" });
    }
  });

  it("fails closed when the chosen provider is misconfigured", async () => {
    const access = { ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" };
    const password = { ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET };
    for (const bad of [
      { ...access, ACCESS_TEAM_DOMAIN: "evil.example" }, { ...access, ACCESS_AUD: "" }, { ADMIN_AUTH: "access" },
      { ...password, ADMIN_PASSWORD_HASH: undefined }, { ...password, ADMIN_PASSWORD_HASH: "pbkdf2-sha256$100000$x$y" },
      { ...password, ADMIN_PASSWORD_HASH: hash.replace(/^hmac-sha256/, "pbkdf2-sha256") },
      { ...password, ADMIN_PASSWORD_HASH: hash.slice(0, -1) },
      { ...password, ADMIN_SESSION_SECRET: "s".repeat(31) }, { ...password, ADMIN_SESSION_SECRET: undefined },
      { ADMIN_AUTH: "password" },
    ]) {
      expect(await adminAuthFor(env(bad)), JSON.stringify(bad)).toMatchObject({ error: "not_configured" });
    }
  });

  it("does not fall back to the other provider's settings", async () => {
    const r = await adminAuthFor(env({ ADMIN_AUTH: "access", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET }));
    expect(r).toMatchObject({ error: "not_configured" });
  });

  it("reuses the Access instance for the same settings, but not when dependencies are injected", async () => {
    const e = env({ ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "reuse.cloudflareaccess.com", ACCESS_AUD: "aud" });
    const a = await adminAuthFor(e);
    const b = await adminAuthFor(e);
    const c = await adminAuthFor(e, { fetch: (async () => new Response("")) as typeof fetch });
    expect("auth" in a && "auth" in b && a.auth === b.auth).toBe(true);
    expect("auth" in c && "auth" in a && c.auth !== a.auth).toBe(true);
  });
});

const H_SECRET = "s".repeat(43);
const NOW_MS = Date.UTC(2026, 9, 5, 12, 0, 0);
const cookieFor = async (secret: string) => `${SESSION_COOKIE}=${(await issueSession(secret, NOW_MS)).value}`;
const requestWith = (cookie: string) => new Request("https://club.example/api/admin/session", { headers: { Cookie: cookie } });

describe("adminAuthFor with credentials in D1", () => {
  it("is used when ADMIN_AUTH is password and neither ADMIN_PASSWORD_HASH nor ADMIN_SESSION_SECRET is set: the stored hash checks passwords and the stored session secret signs the cookie", async () => {
    const secret = generateAdminSecret();
    await saveCredentials(t.env.DB, { secretHash: await hashAdminSecret(secret), sessionSecret: H_SECRET, createdAt: "2026-10-05T10:00:00.000Z" });
    const r = await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password" }), { now: () => NOW_MS });
    if (!("auth" in r) || r.auth.kind !== "password") throw new Error("expected the password provider");
    expect(await r.auth.checkPassword(secret)).toBe(true);
    expect(await r.auth.checkPassword(generateAdminSecret())).toBe(false);
    const { session } = await r.auth.startSession();
    expect(session.identity).toBe("admin");
    expect(await r.auth.authenticate(requestWith(await cookieFor(H_SECRET)))).not.toBeNull();
    expect(await r.auth.authenticate(requestWith(await cookieFor("t".repeat(43))))).toBeNull();
  });

  it("is not_configured, marked as awaiting setup, when there is no row", async () => {
    expect(await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password" }))).toMatchObject({ error: "not_configured", awaitingSetup: true });
  });

  it("reads the row on each call, so a replaced or deleted row takes effect at once (no cached secrets)", async () => {
    const first = generateAdminSecret();
    const second = generateAdminSecret();
    const e = env({ DB: t.env.DB, ADMIN_AUTH: "password" });
    await saveCredentials(t.env.DB, { secretHash: await hashAdminSecret(first), sessionSecret: H_SECRET, createdAt: "2026-10-05T10:00:00.000Z" });
    await saveCredentials(t.env.DB, { secretHash: await hashAdminSecret(second), sessionSecret: "u".repeat(43), createdAt: "2026-10-05T10:01:00.000Z" });
    const r = await adminAuthFor(e);
    if (!("auth" in r) || r.auth.kind !== "password") throw new Error("expected the password provider");
    expect(await r.auth.checkPassword(first)).toBe(false);
    expect(await r.auth.checkPassword(second)).toBe(true);
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    expect(await adminAuthFor(e)).toMatchObject({ error: "not_configured", awaitingSetup: true });
  });

  it("is never used in env mode: either variable set means both must be valid, and a stored row is ignored", async () => {
    await saveCredentials(t.env.DB, { secretHash: await hashAdminSecret(generateAdminSecret()), sessionSecret: H_SECRET, createdAt: "2026-10-05T10:00:00.000Z" });
    for (const over of [{ ADMIN_PASSWORD_HASH: hash }, { ADMIN_SESSION_SECRET: "s".repeat(32) }, { ADMIN_PASSWORD_HASH: "junk", ADMIN_SESSION_SECRET: "s".repeat(32) }]) {
      const r = await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password", ...over }));
      expect(r, JSON.stringify(over)).toMatchObject({ error: "not_configured" });
      expect(r, JSON.stringify(over)).not.toHaveProperty("awaitingSetup");
    }
  });

  it("does not touch the database for env Access, or when ADMIN_AUTH is something else", async () => {
    expect(await adminAuthFor(env({ DB: noDb, ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" }))).toHaveProperty("auth");
    expect(await adminAuthFor(env({ DB: noDb, ADMIN_AUTH: "" }))).toMatchObject({ error: "not_configured" });
  });

  it("has a confirmSignIn that does nothing and succeeds in env mode, and marks the first sign-in in D1 mode", async () => {
    const envMode = await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: "s".repeat(32) }));
    if (!("auth" in envMode) || envMode.auth.kind !== "password") throw new Error("expected the password provider");
    expect(await envMode.auth.confirmSignIn()).toBe(true);

    await saveCredentials(t.env.DB, { secretHash: hash, sessionSecret: H_SECRET, createdAt: "2026-10-05T10:00:00.000Z" });
    const d1 = await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password" }), { now: () => NOW_MS });
    if (!("auth" in d1) || d1.auth.kind !== "password") throw new Error("expected the password provider");
    expect(await d1.auth.confirmSignIn()).toBe(true);
    const row = await t.env.DB.prepare("SELECT first_login_at FROM admin_credentials WHERE id = 1").first();
    expect(row).toEqual({ first_login_at: new Date(NOW_MS).toISOString() });
  });

  it("confirms without a single D1 statement once the loaded credentials are already marked (setup can no longer replace them), and still marks unmarked ones", async () => {
    const statements: string[] = [];
    const spyDb = { prepare: (sql: string) => { statements.push(sql); return t.env.DB.prepare(sql); }, batch: (s: D1PreparedStatement[]) => t.env.DB.batch(s) } as unknown as D1Database;
    const passwordAuth = async () => {
      const r = await adminAuthFor(env({ DB: spyDb, ADMIN_AUTH: "password" }), { now: () => NOW_MS });
      if (!("auth" in r) || r.auth.kind !== "password") throw new Error("expected the password provider");
      statements.length = 0; // what loading the credentials cost is not the question
      return r.auth;
    };
    await saveCredentials(t.env.DB, { secretHash: hash, sessionSecret: H_SECRET, createdAt: "2026-10-05T10:00:00.000Z" });
    const first = await passwordAuth();
    expect(await first.confirmSignIn()).toBe(true);
    expect(statements.length).toBeGreaterThan(0); // the first sign-in does write
    const later = await passwordAuth(); // loaded after the mark
    expect(await later.confirmSignIn()).toBe(true);
    expect(await later.confirmSignIn()).toBe(true);
    expect(statements).toEqual([]);
    expect(await t.env.DB.prepare("SELECT first_login_at FROM admin_credentials WHERE id = 1").first()).toEqual({ first_login_at: new Date(NOW_MS).toISOString() });
  });

  it("refuses to confirm a sign-in verified against a secret that setup has since replaced, and marks nothing", async () => {
    await saveCredentials(t.env.DB, { secretHash: hash, sessionSecret: H_SECRET, createdAt: "2026-10-05T10:00:00.000Z" });
    const d1 = await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password" }));
    if (!("auth" in d1) || d1.auth.kind !== "password") throw new Error("expected the password provider");
    await saveCredentials(t.env.DB, { secretHash: await hashAdminSecret(generateAdminSecret()), sessionSecret: "u".repeat(43), createdAt: "2026-10-05T10:05:00.000Z" });
    expect(await d1.auth.confirmSignIn()).toBe(false);
    expect(await t.env.DB.prepare("SELECT first_login_at FROM admin_credentials WHERE id = 1").first()).toEqual({ first_login_at: null });
  });
});

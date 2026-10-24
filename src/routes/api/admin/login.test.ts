import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "../../../server/auth/session";
import { generateAdminSecret, hashAdminSecret, parseAdminSecretHash } from "../../../server/auth/crypto";
import { createPasswordAuth } from "../../../server/auth/password";
import { csrfToken } from "../../../server/auth/csrf";
import { clientKey } from "../../../server/auth/ratelimit";
import { adminApp, beforeStatement, d1Env, NOW, ORIGIN, passwordEnv, SESSION_SECRET, TEST_PASSWORD } from "../../../server/auth/test-harness";
import { loadCredentials, saveCredentials } from "../../../server/auth/credentials";
import type { AppEnv } from "../../../server/env";
import { createTestEnv, type TestEnv } from "../../../test/db";

let t: TestEnv;
let env: AppEnv;
const clock = { ms: NOW };
const app = adminApp({ now: () => clock.ms });
// The HMAC check is the only importKey call that uses the 16-byte stored salt as the key.
const importKey = vi.spyOn(crypto.subtle, "importKey");
const hmacChecks = () => importKey.mock.calls.filter(([, data]) => (data as Uint8Array).byteLength === 16).length;
const wrongSecret = () => generateAdminSecret();

beforeAll(async () => {
  t = await createTestEnv();
  env = await passwordEnv(t.env.DB);
});
afterAll(async () => { await t.dispose(); });
beforeEach(() => { importKey.mockClear(); clock.ms = NOW; });

let nextIp = 1;
const newIp = () => `203.0.113.${nextIp++}`;

const login = (password: unknown, ip: string, headers: Record<string, string> = {}) =>
  app(env, "/api/admin/login", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip, ...headers },
    body: JSON.stringify({ password }),
  });

const rows = async () => (await t.env.DB.prepare("SELECT key, attempts FROM login_attempts").all<{ key: string; attempts: number }>()).results;

describe("POST /api/admin/login", () => {
  it("signs in: 200 with the identity and CSRF token, and exactly the documented cookie", async () => {
    const res = await login(TEST_PASSWORD, newIp());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800$`));
    expect(cookie).not.toMatch(/domain/i);
    const body = (await res.json()) as { identity: string; csrfToken: string };
    expect(body.identity).toBe("admin");
    // The cookie opens the session endpoint, which hands out the same token.
    const session = await app(env, "/api/admin/session", { headers: { Cookie: cookie.split(";")[0] } });
    expect(await session.json()).toEqual({ identity: "admin", provider: "password", storedMode: "password", csrfToken: body.csrfToken });
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.csrfToken).toBe(await csrfToken(JSON.parse(atob(cookie.split(";")[0].split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sid));
  });

  it("gives the same generic 401 for a wrong secret, a near miss, a different length and a non-canonical spelling", async () => {
    const before = (await rows()).length;
    const bodies: unknown[] = [];
    // The last character carries 4 bits, so "x" (which only differs in the 2 unused bits) decodes like the real "w".
    const nonCanonical = `${TEST_PASSWORD.slice(0, 42)}x`;
    for (const wrong of [wrongSecret(), "wrong", `${TEST_PASSWORD}x`, TEST_PASSWORD.slice(1), "x".repeat(64), nonCanonical]) {
      const res = await login(wrong, newIp()); // a fresh client each time, so the limit never interferes
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      bodies.push(await res.json());
    }
    expect(bodies.every((b) => JSON.stringify(b) === JSON.stringify(bodies[0]))).toBe(true);
    expect(bodies[0]).toMatchObject({ error: { code: "invalid_credentials" } });
    expect(hmacChecks()).toBe(1); // only the well-formed guess got as far as the HMAC
    expect((await rows()).length).toBe(before + 6); // but all six were counted
  });

  it("refuses malformed bodies with no HMAC check and no counted attempt", async () => {
    const ip = newIp();
    const before = await rows();
    for (const password of [undefined, null, 5, "", "x".repeat(257), " \u200B\t ", ["a"], {}]) {
      expect((await login(password, ip)).status, JSON.stringify(password)).toBe(400);
    }
    const send = (init: RequestInit) => app(env, "/api/admin/login", {
      method: "POST", ...init, headers: { Origin: ORIGIN, "CF-Connecting-IP": ip, ...(init.headers as Record<string, string>) },
    });
    expect((await send({ headers: { "Content-Type": "text/plain" }, body: "x" })).status).toBe(415);
    expect((await send({ headers: { "Content-Type": "application/json" }, body: "{nope" })).status).toBe(400);
    expect((await send({ headers: { "Content-Type": "application/json" }, body: "[]" })).status).toBe(400);
    // Declared over 1 KB (the header a real client sends), or actually over the shared reader's 4 KB cap.
    expect((await send({ headers: { "Content-Type": "application/json", "Content-Length": "1025" }, body: "{}" })).status).toBe(413);
    expect((await send({ headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "x".repeat(5000) }) })).status).toBe(413);
    expect(hmacChecks()).toBe(0);
    expect(await rows()).toEqual(before);
  });

  describe("whitespace and zero-width characters around the secret", () => {
    const PADDING = " \t\n\u00A0\u200B\uFEFF\u00AD";
    const inner = (c: string) => `${TEST_PASSWORD.slice(0, 20)}${c}${TEST_PASSWORD.slice(20)}`;

    it("are ignored: a real secret padded on both sides signs in", async () => {
      const res = await login(`${PADDING}${TEST_PASSWORD}${PADDING}`, newIp());
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.`));
      expect((await login(`${PADDING}${TEST_PASSWORD}`, newIp())).status).toBe(200);
      expect((await login(`${TEST_PASSWORD}${PADDING}`, newIp())).status).toBe(200);
    });

    it("do not rescue a secret with a space or zero-width character inside it", async () => {
      for (const c of [" ", "\u200B", "\u00A0", "\u00AD"]) {
        const res = await login(`${PADDING}${inner(c)}${PADDING}`, newIp());
        expect(res.status, JSON.stringify(c)).toBe(401);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
    });

    it("do not make a wrong secret right", async () => {
      expect((await login(`${PADDING}${wrongSecret()}${PADDING}`, newIp())).status).toBe(401);
    });

    it("on their own are treated like an empty value: 400, nothing counted or checked", async () => {
      const ip = newIp();
      const before = await rows();
      expect((await login(PADDING, ip)).status).toBe(400);
      expect((await login("", ip)).status).toBe(400);
      expect(hmacChecks()).toBe(0);
      expect(await rows()).toEqual(before);
    });

    it("are capped on the raw value: 256 code units are read, 257 get 400", async () => {
      const pad = (n: number) => "\u200B".repeat(n);
      expect((await login(`${pad(100)}${TEST_PASSWORD}${pad(113)}`, newIp())).status).toBe(200); // 256 in all
      const ip = newIp();
      const before = await rows();
      expect((await login(`${pad(100)}${TEST_PASSWORD}${pad(114)}`, ip)).status).toBe(400); // 257
      expect(await rows()).toEqual(before);
    });

    it("still count one attempt per request", async () => {
      const ip = newIp();
      for (let i = 0; i < 3; i++) expect((await login(` ${wrongSecret()}\u200B`, ip)).status).toBe(401);
      const key = await clientKey(ip, SESSION_SECRET);
      expect((await rows()).find((r) => r.key === key)?.attempts).toBe(3);
      expect(hmacChecks()).toBe(3);
    });
  });

  it("refuses a body over 1 KB with 413 even when it is streamed without a Content-Length", async () => {
    const ip = newIp();
    const before = await rows();
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const streamed = (body: Uint8Array) => app(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: new ReadableStream({ start(c) { c.enqueue(body.slice(0, 100)); c.enqueue(body.slice(100)); c.close(); } }), duplex: "half",
    } as RequestInit);
    expect((await streamed(bytes({ password: wrongSecret(), pad: "x".repeat(900) }))).status).toBe(401); // about 0.9 KB: fine
    expect((await streamed(bytes({ password: wrongSecret(), pad: "x".repeat(1100) }))).status).toBe(413); // over 1 KB, no Content-Length
    expect(hmacChecks()).toBe(1);
    expect((await rows()).length).toBe(before.length + 1);
  });

  it("rejects a cross-origin or origin-less login with 403, before any counting or hashing", async () => {
    const ip = newIp();
    const before = (await rows()).length;
    for (const headers of [{ Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
      expect((await login(TEST_PASSWORD, ip, headers)).status).toBe(403);
    }
    const noOrigin = await app(env, "/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(noOrigin.status).toBe(403);
    expect(hmacChecks()).toBe(0);
    expect((await rows()).length).toBe(before);
  });

  it("allows five attempts, then 429 with Retry-After even for the right password, without running the HMAC check", async () => {
    const ip = newIp();
    for (let i = 0; i < 5; i++) expect((await login(wrongSecret(), ip)).status).toBe(401);
    expect(hmacChecks()).toBe(5);
    clock.ms = NOW + 100_000;
    const blocked = await login(TEST_PASSWORD, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("800");
    expect(blocked.headers.get("set-cookie")).toBeNull();
    expect(await blocked.json()).toMatchObject({ error: { code: "too_many_attempts" } });
    expect(hmacChecks()).toBe(5);
  });

  it("opens a new window 900 s after the first attempt", async () => {
    const ip = newIp();
    for (let i = 0; i < 6; i++) await login("wrong", ip);
    clock.ms = NOW + 899_000;
    expect((await login(TEST_PASSWORD, ip)).status).toBe(429);
    clock.ms = NOW + 900_000;
    expect((await login(TEST_PASSWORD, ip)).status).toBe(200);
  });

  it("forgets earlier failures after a success", async () => {
    const ip = newIp();
    for (let i = 0; i < 4; i++) await login("wrong", ip);
    expect((await login(TEST_PASSWORD, ip)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await login("wrong", ip)).status).toBe(401);
    expect((await login("wrong", ip)).status).toBe(429);
  });

  it("lets at most five of ten parallel guesses reach the password check", async () => {
    const ip = newIp();
    const results = await Promise.all(Array.from({ length: 10 }, () => login(wrongSecret(), ip)));
    expect(results.filter((r) => r.status === 401)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
    expect(hmacChecks()).toBe(5);
  });

  it("limits each client address separately and never stores one", async () => {
    const a = newIp();
    const b = newIp();
    for (let i = 0; i < 6; i++) await login("wrong", a);
    expect((await login("wrong", a)).status).toBe(429);
    expect((await login(TEST_PASSWORD, b)).status).toBe(200);
    expect(JSON.stringify(await rows())).not.toContain(a);
    expect(JSON.stringify(await rows())).not.toContain(b);
  });

  it("counts the addresses of one IPv6 /64 together, under a key made with the session secret", async () => {
    const inPrefix = (n: number) => `2001:db8:0:${nextIp}::${n.toString(16)}`;
    for (let i = 1; i <= 5; i++) expect((await login("wrong", inPrefix(i))).status).toBe(401);
    expect((await login("wrong", inPrefix(6))).status).toBe(429);
    expect((await login(TEST_PASSWORD, inPrefix(7))).status).toBe(429);
    const stored = (await rows()).map((r) => r.key);
    expect(stored).toContain(await clientKey(inPrefix(1), SESSION_SECRET));
    expect(JSON.stringify(stored)).not.toContain("db8");
    nextIp++;
    expect((await login(TEST_PASSWORD, `2001:db8:0:${nextIp}::1`)).status).toBe(200); // the next /64 is a different client
  });

  it("shares one counter between requests with no client address", async () => {
    const noIp = (password: string) => app(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    });
    for (let i = 0; i < 5; i++) await noIp("wrong");
    expect((await noIp(TEST_PASSWORD)).status).toBe(429);
  });
});

describe("POST /api/admin/login with credentials in D1", () => {
  const T0 = "2026-10-05T10:00:00.000Z";
  const D1_SESSION = "d1-session-secret-0123456789-abcdefghij-xyz";
  let hash: string;
  let d1: AppEnv;
  beforeAll(async () => { hash = await hashAdminSecret(TEST_PASSWORD); d1 = d1Env(t.env.DB); });
  beforeEach(async () => {
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    await saveCredentials(t.env.DB, { secretHash: hash, sessionSecret: D1_SESSION, createdAt: T0 });
  });
  const loginTo = (target: AppEnv, password: unknown, ip = newIp()) => app(target, "/api/admin/login", {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ password }),
  });
  const firstLogin = async () => (await loadCredentials(t.env.DB))?.firstLoginAt;

  it("signs in with the generated secret, sets a cookie signed by the stored session secret, and records the first sign-in", async () => {
    const res = await loginTo(d1, TEST_PASSWORD);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    expect((await app(d1, "/api/admin/session", { headers: { Cookie: cookie } })).status).toBe(200);
    // Not the environment secret, and not any other stored one: only the D1 session secret makes this cookie valid.
    const other = createPasswordAuth({ hash: parseAdminSecretHash(hash)!, sessionSecret: SESSION_SECRET }, { now: () => clock.ms });
    expect(await other.authenticate(new Request(`${ORIGIN}/`, { headers: { Cookie: cookie } }))).toBeNull();
    expect(await firstLogin()).toBe(new Date(clock.ms).toISOString());
  });

  it("does not mark the first sign-in for a wrong secret, a rate-limited attempt or a malformed body", async () => {
    expect((await loginTo(d1, wrongSecret())).status).toBe(401);
    expect((await loginTo(d1, "")).status).toBe(400);
    const ip = newIp();
    for (let i = 0; i < 5; i++) await loginTo(d1, wrongSecret(), ip);
    expect((await loginTo(d1, TEST_PASSWORD, ip)).status).toBe(429);
    expect(await firstLogin()).toBeNull();
  });

  it("keeps the first sign-in's time through later sign-ins", async () => {
    expect((await loginTo(d1, TEST_PASSWORD)).status).toBe(200);
    const first = await firstLogin();
    clock.ms += 3600_000;
    expect((await loginTo(d1, TEST_PASSWORD)).status).toBe(200);
    expect(await firstLogin()).toBe(first);
  });

  it("refuses the sign-in, with the usual 401 and no session, when setup replaced the secret after it was verified, and marks nothing", async () => {
    const replacement = await hashAdminSecret(generateAdminSecret());
    const racing = beforeStatement(t.env.DB, /^UPDATE admin_credentials SET first_login_at/, async () => {
      await saveCredentials(t.env.DB, { secretHash: replacement, sessionSecret: D1_SESSION.replace("d1", "d2"), createdAt: T0 });
    });
    const res = await loginTo({ ...d1, DB: racing }, TEST_PASSWORD);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_credentials" } });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await firstLogin()).toBeNull();
    expect((await loadCredentials(t.env.DB))?.secretHash).toBe(replacement);
  });

  it("lets two near-simultaneous sign-ins both succeed, marking the row once", async () => {
    const [a, b] = await Promise.all([loginTo(d1, TEST_PASSWORD), loginTo(d1, TEST_PASSWORD)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await firstLogin()).toBe(new Date(clock.ms).toISOString());
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM admin_credentials").first<{ n: number }>())?.n).toBe(1);
  });

  it("does not use the stored credentials, or mark them, when the deployment is in env mode", async () => {
    expect((await loginTo(env, TEST_PASSWORD)).status).toBe(200); // the env hash, though the D1 row holds the same secret
    expect(await firstLogin()).toBeNull();
    const envWrong = await passwordEnv(t.env.DB);
    expect((await loginTo({ ...envWrong, ADMIN_PASSWORD_HASH: await hashAdminSecret(generateAdminSecret()) }, TEST_PASSWORD)).status).toBe(401);
    expect(await firstLogin()).toBeNull();
  });
});

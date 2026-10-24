import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCredentials, markFirstSignIn, saveCredentials } from "../../server/auth/credentials";
import { generateAdminSecret, hashAdminSecret, isCanonicalAdminSecret, parseAdminSecretHash, verifyAdminSecret } from "../../server/auth/crypto";
import { clientKey, countAttempt, setupClientKey } from "../../server/auth/ratelimit";
import { beforeStatement, d1Env, NOW, ORIGIN, passwordEnv, SETUP_CODE } from "../../server/auth/test-harness";
import type { AppEnv } from "../../server/env";
import { createTestEnv, type TestEnv } from "../../test/db";
import { createSetupHandler } from "./setup";

let t: TestEnv;
let env: AppEnv;
const clock = { ms: NOW };
const handler = createSetupHandler({ now: () => clock.ms });
const digest = vi.spyOn(crypto.subtle, "digest");

beforeAll(async () => { t = await createTestEnv(); env = d1Env(t.env.DB); });
afterAll(async () => { await t.dispose(); });
beforeEach(async () => {
  clock.ms = NOW;
  digest.mockClear();
  await t.env.DB.prepare("DELETE FROM admin_credentials").run();
  await t.env.DB.prepare("DELETE FROM login_attempts").run();
});
afterEach(() => { vi.restoreAllMocks(); });

let nextIp = 1;
const newIp = () => `198.51.100.${nextIp++}`;

const post = (code: unknown, over: { env?: AppEnv; ip?: string; headers?: Record<string, string | null>; body?: string } = {}) => {
  const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": over.ip ?? newIp() };
  for (const [k, v] of Object.entries(over.headers ?? {})) { if (v === null) delete headers[k]; else headers[k] = v; }
  const request = new Request(`${ORIGIN}/api/setup`, { method: "POST", headers, body: over.body ?? JSON.stringify({ code }) });
  return handler({ request, env: over.env ?? env, params: {}, data: {} });
};
const rowOf = async () => loadCredentials(t.env.DB);
const GLOBAL_KEY = "slot-booker-setup-global-v1";
const allAttempts = async () => (await t.env.DB.prepare("SELECT key, attempts FROM login_attempts").all<{ key: string; attempts: number }>()).results;
/** The per-visitor rows only: the one global row (GLOBAL_KEY) has its own tests. */
const attempts = async () => (await allAttempts()).filter((r) => r.key !== GLOBAL_KEY);
const secretOf = async (res: Response) => ((await res.json()) as { secret: string }).secret;

describe("POST /api/setup: the right code", () => {
  it("answers 200 with a generated admin secret and no-store, and stores only its hash and a fresh session secret", async () => {
    const res = await post(SETUP_CODE);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { secret: string };
    expect(Object.keys(body)).toEqual(["secret"]);
    expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isCanonicalAdminSecret(body.secret)).toBe(true);

    const row = await t.env.DB.prepare("SELECT * FROM admin_credentials").all<Record<string, string | number | null>>();
    expect(row.results).toHaveLength(1);
    const stored = row.results[0];
    expect(stored).toMatchObject({ id: 1, created_at: new Date(NOW).toISOString(), first_login_at: null });
    expect(await verifyAdminSecret(body.secret, parseAdminSecretHash(stored.secret_hash as string)!)).toBe(true);
    expect(stored.session_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The secret exists only in the response: no column of the row holds it, nor does the session secret equal it.
    expect(JSON.stringify(stored)).not.toContain(body.secret);
    expect(stored.session_secret).not.toBe(body.secret);
  });

  it("never logs the secret (or anything at all on the happy path)", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const secret = await secretOf(await post(SETUP_CODE));
    const logged = spies.flatMap((s) => s.mock.calls).flat().map(String).join("\n");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(SETUP_CODE);
    expect(spies.flatMap((s) => s.mock.calls)).toHaveLength(0);
  });

  it("makes a different secret and session secret each time", async () => {
    const a = await secretOf(await post(SETUP_CODE));
    const sessionA = (await rowOf())!.sessionSecret;
    const b = await secretOf(await post(SETUP_CODE));
    expect(a).not.toBe(b);
    expect((await rowOf())!.sessionSecret).not.toBe(sessionA);
  });

  it("ignores whitespace and zero-width characters around the code, and around SETUP_CODE too", async () => {
    expect((await post(`  ​${SETUP_CODE}\t\n`)).status).toBe(200);
    expect((await post(SETUP_CODE, { env: d1Env(t.env.DB, { SETUP_CODE: `\n  ${SETUP_CODE} ​` }) })).status).toBe(200);
  });

  it("does not accept a code with something inside it changed", async () => {
    for (const wrong of [SETUP_CODE.toUpperCase(), `${SETUP_CODE.slice(0, 5)} ${SETUP_CODE.slice(5)}`, SETUP_CODE.slice(1), `${SETUP_CODE}x`]) {
      expect((await post(wrong)).status, wrong).toBe(401);
    }
    expect(await rowOf()).toBeNull();
  });

  it("clears the client's failed attempts", async () => {
    const ip = newIp();
    await post("nope-nope-nope", { ip });
    expect(await attempts()).toHaveLength(1);
    expect((await post(SETUP_CODE, { ip })).status).toBe(200);
    expect(await attempts()).toEqual([]);
  });
});

describe("POST /api/setup: a wrong code", () => {
  it("answers one 401 invalid_setup_code, whatever the submitted length, and writes nothing", async () => {
    const bodies: string[] = [];
    for (const wrong of ["x", "club", "x".repeat(12), `${SETUP_CODE}!`, "y".repeat(100), "z".repeat(256)]) {
      const res = await post(wrong);
      expect(res.status, wrong).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      bodies.push(JSON.stringify(await res.json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toMatchObject({ error: { code: "invalid_setup_code" } });
    expect(await rowOf()).toBeNull();
  });
});

describe("POST /api/setup: the request", () => {
  it("refuses a missing, foreign or cross-site Origin with 403 csrf_failed, before counting or writing anything", async () => {
    for (const headers of <Record<string, string | null>[]>[{ Origin: null }, { Origin: "https://evil.example" }, { Origin: `${ORIGIN}.evil.example` }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "none" }]) {
      const res = await post(SETUP_CODE, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "csrf_failed" } });
    }
    expect((await post(SETUP_CODE, { headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
    expect(await attempts()).toEqual([]);
  });

  it("refuses a body that is not application/json with 415", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      expect((await post(SETUP_CODE, { headers: { "Content-Type": type } })).status, type).toBe(415);
    }
    expect((await post(SETUP_CODE, { headers: { "Content-Type": null } })).status).toBe(415);
    expect((await post(SETUP_CODE, { headers: { "Content-Type": "Application/JSON; charset=utf-8" } })).status).toBe(200);
  });

  it("refuses a body over 1 KiB with 413, declared or streamed, before counting or writing", async () => {
    expect((await post(SETUP_CODE, { headers: { "Content-Length": "1025" } })).status).toBe(413);
    expect((await post(SETUP_CODE, { body: JSON.stringify({ code: "x".repeat(1100) }) })).status).toBe(413);
    expect(await attempts()).toEqual([]);
    expect(await rowOf()).toBeNull();
  });

  it("refuses malformed input with 400, uncounted: not JSON, not an object, no code, not a string, empty, or over 256 characters", async () => {
    expect((await post(null, { body: "{nope" })).status).toBe(400);
    expect((await post(null, { body: "[]" })).status).toBe(400);
    for (const code of [undefined, null, 5, ["a"], {}, "", " ​\t ", "x".repeat(257)]) {
      expect((await post(code)).status, JSON.stringify(code)).toBe(400);
    }
    expect(await attempts()).toEqual([]);
    expect(await rowOf()).toBeNull();
    expect((await post("x".repeat(256))).status).toBe(401); // exactly 256 is read, and is just wrong
  });
});

describe("POST /api/setup: rate limit", () => {
  it("allows five wrong codes, then 429 with Retry-After for the right one too, with no comparison and no write", async () => {
    const ip = newIp();
    for (let i = 0; i < 5; i++) expect((await post(`wrong-code-${i}`, { ip })).status).toBe(401);
    digest.mockClear();
    const res = await post(SETUP_CODE, { ip });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: { code: "too_many_attempts" } });
    expect(digest).not.toHaveBeenCalled(); // the code was not compared (hashed) at all
    expect(await rowOf()).toBeNull();
    expect((await post("another-wrong", { ip })).status).toBe(429);
  });

  it("reports the time left, and opens a new window 900 s after the first attempt", async () => {
    const ip = newIp();
    for (let i = 0; i < 6; i++) await post("wrong-code-here", { ip });
    clock.ms = NOW + 600_000;
    expect((await post(SETUP_CODE, { ip })).headers.get("retry-after")).toBe("300");
    clock.ms = NOW + 900_000;
    expect((await post(SETUP_CODE, { ip })).status).toBe(200);
  });

  it("counts each client separately", async () => {
    const a = newIp();
    for (let i = 0; i < 6; i++) await post("wrong-code-here", { ip: a });
    expect((await post(SETUP_CODE, { ip: a })).status).toBe(429);
    expect((await post(SETUP_CODE, { ip: newIp() })).status).toBe(200);
  });

  it("uses its own keyspace: setup attempts do not count towards the admin login limit, and login attempts do not count here", async () => {
    const ip = newIp();
    for (let i = 0; i < 6; i++) await post("wrong-code-here", { ip });
    const keys = (await attempts()).map((r) => r.key);
    expect(keys).toEqual([await setupClientKey(ip, SETUP_CODE)]);
    const sessionSecret = "test-only-session-secret-0123456789-abcdef";
    const loginKey = await clientKey(ip, sessionSecret);
    expect(keys).not.toContain(loginKey);
    expect(await countAttempt(t.env.DB, loginKey, Math.floor(NOW / 1000))).toEqual({ allowed: true });
    // and the other way round
    const other = newIp();
    for (let i = 0; i < 10; i++) await countAttempt(t.env.DB, await clientKey(other, sessionSecret), Math.floor(NOW / 1000));
    expect((await post(SETUP_CODE, { ip: other })).status).toBe(200);
  });

  it("stores no client address, only a key made with the setup code", async () => {
    const ip = newIp();
    await post("wrong-code-here", { ip });
    expect(JSON.stringify(await attempts())).not.toContain(ip);
    const [row] = await attempts();
    expect(row.key).toMatch(/^[0-9a-f]{64}$/);
    expect(row.key).not.toBe(await setupClientKey(ip, "a different setup code"));
  });
});

describe("POST /api/setup: the global attempt cap", () => {
  const globalRow = async () => (await allAttempts()).find((r) => r.key === GLOBAL_KEY);

  it("refuses the 31st attempt in 15 minutes from any number of different clients with 429, even with the right code, with no comparison and no write", async () => {
    for (let i = 0; i < 30; i++) expect((await post(`wrong-code-${i}`)).status, `attempt ${i + 1}`).toBe(401);
    digest.mockClear();
    const res = await post(SETUP_CODE);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: { code: "too_many_attempts" } });
    expect(digest).not.toHaveBeenCalled();
    expect(await rowOf()).toBeNull();
    expect((await post("another-wrong")).status).toBe(429);
  });

  it("reports the time left, and opens a new window 900 s after the first attempt", async () => {
    for (let i = 0; i < 31; i++) await post("wrong-code-here");
    clock.ms = NOW + 600_000;
    expect((await post(SETUP_CODE)).headers.get("retry-after")).toBe("300");
    clock.ms = NOW + 900_000;
    expect((await post(SETUP_CODE)).status).toBe(200);
  });

  it("counts under one constant key that is not derived from the setup code and holds no personal data", async () => {
    await post("wrong-code-here");
    await post("wrong-code-here", { env: d1Env(t.env.DB, { SETUP_CODE: "a different setup code entirely" }) });
    expect(await globalRow()).toEqual({ key: GLOBAL_KEY, attempts: 2 });
  });

  it("is counted after the per-visitor limit: a client already over its own limit adds nothing to it", async () => {
    const ip = newIp();
    for (let i = 0; i < 5; i++) await post("wrong-code-here", { ip });
    expect((await globalRow())!.attempts).toBe(5);
    for (let i = 0; i < 3; i++) expect((await post("wrong-code-here", { ip })).status).toBe(429);
    expect((await globalRow())!.attempts).toBe(5);
  });

  it("still limits one client to five attempts, as before", async () => {
    const ip = newIp();
    for (let i = 0; i < 5; i++) expect((await post("wrong-code-here", { ip })).status).toBe(401);
    expect((await post(SETUP_CODE, { ip })).status).toBe(429);
  });

  it("is not cleared by a correct setup, which clears only that client's own key", async () => {
    const ip = newIp();
    await post("wrong-code-here", { ip });
    await post("wrong-code-here");
    expect((await post(SETUP_CODE, { ip })).status).toBe(200);
    expect((await attempts()).map((r) => r.key)).not.toContain(await setupClientKey(ip, SETUP_CODE));
    expect(await globalRow()).toEqual({ key: GLOBAL_KEY, attempts: 3 });
  });
});

describe("POST /api/setup: when it is not open", () => {
  const notFound = { error: { code: "not_found" } };
  const untouched = async () => {
    expect(await allAttempts()).toEqual([]); // neither the client's key nor the global one
  };

  it("answers 404 after the first sign-in, writes nothing, and cannot replace the credentials (even with the right code)", async () => {
    const hash = await hashAdminSecret(generateAdminSecret());
    await saveCredentials(t.env.DB, { secretHash: hash, sessionSecret: "s".repeat(43), createdAt: "2026-10-05T10:00:00.000Z" });
    await markFirstSignIn(t.env.DB, hash, "2026-10-05T10:01:00.000Z");
    const before = await rowOf();
    const res = await post(SETUP_CODE);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject(notFound);
    expect(await rowOf()).toEqual(before);
    await untouched();
  });

  it("answers 404 in env mode (either variable set), for Access, and for any other ADMIN_AUTH, reading nothing", async () => {
    const full = await passwordEnv(t.env.DB);
    for (const e of [
      full, d1Env(t.env.DB, { ADMIN_PASSWORD_HASH: full.ADMIN_PASSWORD_HASH }), d1Env(t.env.DB, { ADMIN_SESSION_SECRET: full.ADMIN_SESSION_SECRET }),
      d1Env(t.env.DB, { ADMIN_AUTH: "access" }), d1Env(t.env.DB, { ADMIN_AUTH: "Password" }),
    ]) {
      const res = await post(SETUP_CODE, { env: { ...e, SETUP_CODE } });
      expect(res.status, JSON.stringify(e.ADMIN_AUTH)).toBe(404);
      expect(await res.json()).toMatchObject(notFound);
    }
    expect(await rowOf()).toBeNull();
    await untouched();
  });

  it("answers 404 without looking at Origin, content type or body, so a closed setup says nothing", async () => {
    const hash = await hashAdminSecret(generateAdminSecret());
    await saveCredentials(t.env.DB, { secretHash: hash, sessionSecret: "s".repeat(43), createdAt: "2026-10-05T10:00:00.000Z" });
    await markFirstSignIn(t.env.DB, hash, "2026-10-05T10:01:00.000Z");
    expect((await post(null, { headers: { Origin: null, "Content-Type": "text/plain" }, body: "junk" })).status).toBe(404);
  });

  it("answers 503 setup_not_ready, and writes and counts nothing, when SETUP_CODE is missing or shorter than 12 characters", async () => {
    for (const code of [undefined, "", "   ", "short", "12345678901", "  12345678901  "]) {
      const res = await post("12345678901", { env: d1Env(t.env.DB, { SETUP_CODE: code }) });
      expect(res.status, JSON.stringify(code)).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = JSON.stringify(await res.json());
      expect(text).toContain("setup_not_ready");
      expect(text).not.toContain("12345678901");
    }
    expect(await rowOf()).toBeNull();
    await untouched();
  });

  it("stays open to a second run while no one has signed in, and the 404 for a closed setup is the same generic one", async () => {
    expect((await post(SETUP_CODE)).status).toBe(200);
    expect((await post(SETUP_CODE)).status).toBe(200);
    const closed = await post(SETUP_CODE, { env: d1Env(t.env.DB, { ADMIN_AUTH: "access" }) });
    expect(await closed.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
  });
});

describe("POST /api/setup: running it again before the first sign-in", () => {
  it("replaces the stored secret and session secret: the new secret works and the old one does not", async () => {
    const first = await secretOf(await post(SETUP_CODE));
    const before = (await rowOf())!;
    const second = await secretOf(await post(SETUP_CODE));
    const after = (await rowOf())!;
    expect(second).not.toBe(first);
    const parsed = parseAdminSecretHash(after.secretHash)!;
    expect(await verifyAdminSecret(second, parsed)).toBe(true);
    expect(await verifyAdminSecret(first, parsed)).toBe(false);
    expect(after.secretHash).not.toBe(before.secretHash);
    expect(after.sessionSecret).not.toBe(before.sessionSecret);
    expect(after.firstLoginAt).toBeNull();
  });
});

describe("POST /api/setup: races, interleaved at the SQL level", () => {
  it("answers 404 and leaves the credentials alone when the first sign-in lands between the state check and the write", async () => {
    const original = await hashAdminSecret(generateAdminSecret());
    await saveCredentials(t.env.DB, { secretHash: original, sessionSecret: "s".repeat(43), createdAt: "2026-10-05T10:00:00.000Z" });
    const racing = beforeStatement(t.env.DB, /^INSERT INTO admin_credentials/, async () => {
      expect(await markFirstSignIn(t.env.DB, original, "2026-10-05T10:01:00.000Z")).toBe(true);
    });
    const ip = newIp();
    await post("wrong-code-here", { ip }); // so there is an attempt to find (or not) cleared afterwards
    const res = await post(SETUP_CODE, { ip, env: d1Env(racing) });
    expect(res.status).toBe(404);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("not_found");
    expect(text).not.toMatch(/[A-Za-z0-9_-]{43}/); // no secret in what the caller sees
    expect(await rowOf()).toEqual({ secretHash: original, sessionSecret: "s".repeat(43), firstLoginAt: "2026-10-05T10:01:00.000Z" });
    // And the next request sees it closed.
    expect((await post(SETUP_CODE)).status).toBe(404);
  });

  it("answers 500 without a secret in it, or in the logs, when the write fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = beforeStatement(t.env.DB, /^INSERT INTO admin_credentials/, async () => { throw new Error("D1 is down"); });
    const res = await post(SETUP_CODE, { env: d1Env(failing) });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(log.mock.calls.flat().map(String).join("\n")).not.toContain(SETUP_CODE);
    expect(await rowOf()).toBeNull();
  });
});

describe("recovery: deleting the row reopens setup", () => {
  it("opens /setup again, still behind SETUP_CODE, and the old secret stops working", async () => {
    const old = await secretOf(await post(SETUP_CODE));
    const { secretHash } = (await rowOf())!;
    await markFirstSignIn(t.env.DB, secretHash, "2026-10-05T10:01:00.000Z");
    expect((await post(SETUP_CODE)).status).toBe(404);

    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    expect((await post(SETUP_CODE, { env: d1Env(t.env.DB, { SETUP_CODE: undefined }) })).status).toBe(503);
    expect((await post("not-the-code-at-all")).status).toBe(401);
    const fresh = await secretOf(await post(SETUP_CODE));
    expect(fresh).not.toBe(old);
    expect(await verifyAdminSecret(old, parseAdminSecretHash((await rowOf())!.secretHash)!)).toBe(false);
  });
});

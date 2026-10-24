import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashClaimToken } from "../../server/auth/claim";
import { loadCredentials } from "../../server/auth/credentials";
import { generateAdminSecret, hashAdminSecret, isCanonicalAdminSecret, parseAdminSecretHash, verifyAdminSecret } from "../../server/auth/crypto";
import { clientKey, countAttempt, recoveryClientKey, setupClientKey } from "../../server/auth/ratelimit";
import { ageWindow, beforeStatement, d1Env, NOW, ORIGIN, SETUP_CODE } from "../../server/auth/test-harness";
import type { AppEnv } from "../../server/env";
import { createTestEnv, type TestEnv } from "../../test/db";
import { createLoginHandler } from "./admin/login";
import { createRecoverHandler } from "./recover";
import { createSetupHandler } from "./setup";

let t: TestEnv;
let env: AppEnv;
const clock = { ms: NOW };
const handler = createRecoverHandler({ now: () => clock.ms });

beforeAll(async () => { t = await createTestEnv(); env = d1Env(t.env.DB); });
afterAll(async () => { await t.dispose(); });

let OLD_SECRET: string;
let CODE: string;
let CODE_HASH: string;
const OLD_SESSION_SECRET = "o".repeat(43);
const FIRST_LOGIN = "2026-10-05T10:01:00.000Z";

/** An admin who has signed in once, with a recovery code: the state of a site on the day the secret is lost. */
async function seed({ firstLogin = true, mode = "password", claimToken = null as string | null, recovery = true } = {}) {
  OLD_SECRET = generateAdminSecret();
  CODE = generateAdminSecret();
  CODE_HASH = await hashAdminSecret(CODE);
  const db = t.env.DB;
  await db.prepare("DELETE FROM admin_credentials").run();
  await db.prepare("DELETE FROM login_attempts").run();
  await db.prepare("INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at, first_login_at) VALUES (1, ?, ?, ?, ?)")
    .bind(await hashAdminSecret(OLD_SECRET), OLD_SESSION_SECRET, "2026-10-05T10:00:00.000Z", firstLogin ? FIRST_LOGIN : null).run();
  await db.prepare("UPDATE auth_settings SET mode = 'password', changed_at = NULL, changed_by = NULL, claim_token_hash = ?, recovery_hash = ?, recovery_created_at = ? WHERE id = 1")
    .bind(claimToken === null ? null : await hashClaimToken(claimToken), recovery ? CODE_HASH : null, recovery ? "2026-10-05T10:00:00.000Z" : null).run();
  if (mode === "access") {
    await db.prepare("UPDATE auth_settings SET mode = 'access', access_team_domain = 'club.cloudflareaccess.com', access_aud = 'aud-tag-1234567890', access_hostname = 'club.example', changed_at = ?, changed_by = 'wizard' WHERE id = 1")
      .bind("2026-10-05T10:02:00.000Z").run();
  }
}

beforeEach(async () => { clock.ms = NOW; await seed(); });
afterEach(() => { vi.restoreAllMocks(); });

let nextIp = 1;
const newIp = () => `198.51.100.${nextIp++}`;

type Over = { env?: AppEnv; ip?: string; headers?: Record<string, string | null>; body?: string };
const post = (code: unknown, over: Over = {}) => {
  const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": over.ip ?? newIp() };
  for (const [k, v] of Object.entries(over.headers ?? {})) { if (v === null) delete headers[k]; else headers[k] = v; }
  const request = new Request(`${ORIGIN}/api/recover`, { method: "POST", headers, body: over.body ?? JSON.stringify({ code }) });
  return handler({ request, env: over.env ?? env, params: {}, data: {} });
};
type Made = { secret: string; recoveryCode: string; envPinned: boolean };
const madeOf = async (res: Response) => (await res.json()) as Made;
const allAttempts = async () => (await t.env.DB.prepare("SELECT key, attempts FROM login_attempts").all<{ key: string; attempts: number }>()).results;
const settingsRow = async () => t.env.DB.prepare("SELECT * FROM auth_settings WHERE id = 1").first<Record<string, string | null>>();
const credentialRows = async () => (await t.env.DB.prepare("SELECT * FROM admin_credentials").all<Record<string, string | null>>()).results;
/** Everything the handler could change, to show a refused request wrote nothing. */
const snapshot = async () => JSON.stringify([await settingsRow(), await credentialRows()]);
const wrong = () => generateAdminSecret();
const CONSOLE = ["log", "info", "warn", "error", "debug"] as const;

describe("POST /api/recover: when it is not available", () => {
  it("answers 404 when no recovery code is stored, and writes nothing", async () => {
    await seed({ recovery: false });
    const before = await snapshot();
    const res = await post(CODE);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    expect(await snapshot()).toBe(before);
    expect(await allAttempts()).toEqual([]);
  });

  it("answers 404 when the auth_settings row is missing", async () => {
    await t.env.DB.prepare("DELETE FROM auth_settings").run();
    try {
      expect((await post(CODE)).status).toBe(404);
    } finally {
      await t.env.DB.prepare("INSERT INTO auth_settings (id, setup_opened_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").run();
    }
  });

  it("answers 404 when ADMIN_PASSWORD_HASH or ADMIN_SESSION_SECRET is set (either one), without reading the database or the request", async () => {
    const untouched = { prepare: () => { throw new Error("database used"); }, batch: () => { throw new Error("database used"); } } as unknown as D1Database;
    for (const over of [{ ADMIN_PASSWORD_HASH: CODE_HASH }, { ADMIN_SESSION_SECRET: "s".repeat(43) }, { ADMIN_PASSWORD_HASH: "x", ADMIN_SESSION_SECRET: "y" }]) {
      const res = await post(CODE, { env: d1Env(untouched, over), headers: { Origin: null, "Content-Type": "text/plain" }, body: "not json" });
      expect(res.status, JSON.stringify(over)).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await allAttempts()).toEqual([]);
  });

  it("answers 404 without looking at Origin, content type or body, so an unavailable recovery says nothing", async () => {
    await seed({ recovery: false });
    const res = await post(null, { headers: { Origin: "https://evil.example", "Content-Type": "text/plain" }, body: "{nope" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/recover: the request", () => {
  it("refuses a missing, foreign or cross-site Origin with 403 csrf_failed, before counting or writing anything", async () => {
    const before = await snapshot();
    for (const headers of <Record<string, string | null>[]>[{ Origin: null }, { Origin: "https://evil.example" }, { Origin: `${ORIGIN}.evil.example` }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "none" }]) {
      const res = await post(CODE, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "csrf_failed" } });
    }
    expect(await allAttempts()).toEqual([]);
    expect(await snapshot()).toBe(before);
    expect((await post(CODE, { headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
  });

  it("refuses a body that is not application/json with 415", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      expect((await post(CODE, { headers: { "Content-Type": type } })).status, type).toBe(415);
    }
    expect((await post(CODE, { headers: { "Content-Type": null } })).status).toBe(415);
    expect((await post(CODE, { headers: { "Content-Type": "Application/JSON; charset=utf-8" } })).status).toBe(200);
  });

  it("refuses a body over 1 KiB with 413, declared or streamed, before counting or writing", async () => {
    const before = await snapshot();
    expect((await post(CODE, { headers: { "Content-Length": "1025" } })).status).toBe(413);
    expect((await post(CODE, { body: JSON.stringify({ code: "x".repeat(1100) }) })).status).toBe(413);
    expect(await allAttempts()).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it("refuses malformed input with 400, uncounted: not JSON, not an object, no code, not a string, empty, or over 256 characters", async () => {
    const before = await snapshot();
    expect((await post(null, { body: "{nope" })).status).toBe(400);
    expect((await post(null, { body: "[]" })).status).toBe(400);
    for (const code of [undefined, null, 5, ["a"], {}, "", " \u200B\t ", "x".repeat(257)]) {
      expect((await post(code)).status, JSON.stringify(code)).toBe(400);
    }
    expect(await allAttempts()).toEqual([]);
    expect(await snapshot()).toBe(before);
    expect((await post("x".repeat(256))).status).toBe(401); // exactly 256 is read, and is just wrong
  });
});

describe("POST /api/recover: a wrong code", () => {
  it("answers one 401 invalid_recovery_code whatever the submitted code, and writes nothing", async () => {
    const before = await snapshot();
    const bodies: string[] = [];
    for (const bad of [wrong(), "x", "club", "x".repeat(43), "y".repeat(100), "z".repeat(256), CODE.toUpperCase(), `${CODE.slice(0, 5)} ${CODE.slice(5)}`, CODE.slice(1), `${CODE}x`, OLD_SECRET]) {
      const res = await post(bad);
      expect(res.status, bad).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      bodies.push(JSON.stringify(await res.json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toMatchObject({ error: { code: "invalid_recovery_code" } });
    expect(await snapshot()).toBe(before);
  });

  it("answers 401, not 500, when the stored recovery hash is not usable", async () => {
    await t.env.DB.prepare("UPDATE auth_settings SET recovery_hash = 'hmac-sha256$garbage' WHERE id = 1").run();
    expect((await post(CODE)).status).toBe(401);
  });
});

describe("POST /api/recover: the right code", () => {
  it("answers 200 with a new secret, a new recovery code and envPinned false, no-store, and stores only their hashes", async () => {
    const res = await post(CODE);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const made = await madeOf(res);
    expect(Object.keys(made)).toEqual(["secret", "recoveryCode", "envPinned"]);
    expect(made.envPinned).toBe(false);
    for (const value of [made.secret, made.recoveryCode]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isCanonicalAdminSecret(value)).toBe(true);
    }
    expect(new Set([made.secret, made.recoveryCode, CODE, OLD_SECRET]).size).toBe(4);

    const [stored] = await credentialRows();
    const settings = (await settingsRow())!;
    expect(await verifyAdminSecret(made.secret, parseAdminSecretHash(stored.secret_hash!)!)).toBe(true);
    expect(await verifyAdminSecret(made.recoveryCode, parseAdminSecretHash(settings.recovery_hash!)!)).toBe(true);
    expect(stored.session_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.session_secret).not.toBe(OLD_SESSION_SECRET); // every existing session is signed out
    expect(stored.created_at).toBe(new Date(NOW).toISOString());
    expect(settings.recovery_created_at).toBe(new Date(NOW).toISOString());
    // Neither value exists anywhere in the database.
    const everything = JSON.stringify([stored, settings, await allAttempts()]);
    for (const value of [made.secret, made.recoveryCode, CODE]) expect(everything).not.toContain(value);
  });

  it("makes the old code useless and the old secret stop working, while the new secret signs in", async () => {
    const made = await madeOf(await post(CODE));
    expect((await post(CODE)).status).toBe(401); // the old code no longer matches
    const stored = (await loadCredentials(t.env.DB))!;
    expect(await verifyAdminSecret(OLD_SECRET, parseAdminSecretHash(stored.secretHash)!)).toBe(false);
    expect(await verifyAdminSecret(made.secret, parseAdminSecretHash(stored.secretHash)!)).toBe(true);

    const login = createLoginHandler({ now: () => NOW });
    const signIn = (password: string) => login({
      request: new Request(`${ORIGIN}/api/admin/login`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": newIp() }, body: JSON.stringify({ password }) }),
      env, params: {}, data: {},
    });
    expect((await signIn(OLD_SECRET)).status).toBe(401);
    expect((await signIn(made.secret)).status).toBe(200);
    // And the new recovery code works in its turn.
    expect((await post(made.recoveryCode)).status).toBe(200);
  });

  it("leaves first_login_at as it was, so /api/setup stays closed", async () => {
    expect((await post(CODE)).status).toBe(200);
    expect((await loadCredentials(t.env.DB))!.firstLoginAt).toBe(FIRST_LOGIN);
    const setup = await createSetupHandler({ now: () => NOW })({
      request: new Request(`${ORIGIN}/api/setup`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": newIp() }, body: JSON.stringify({ code: SETUP_CODE }) }),
      env, params: {}, data: {},
    });
    expect(setup.status).toBe(404);
  });

  it("does not make up a first_login_at when none was recorded", async () => {
    await seed({ firstLogin: false });
    expect((await post(CODE)).status).toBe(200);
    expect((await loadCredentials(t.env.DB))!.firstLoginAt).toBeNull();
  });

  it("records changed_by recovery, switches Access back to the password, and revokes the claim token", async () => {
    await seed({ mode: "access", claimToken: "t".repeat(43) });
    expect((await post(CODE)).status).toBe(200);
    expect(await settingsRow()).toMatchObject({ mode: "password", changed_by: "recovery", changed_at: new Date(NOW).toISOString(), claim_token_hash: null });
  });

  it("works from password mode, with the claim window long over, and with no credentials row at all", async () => {
    await ageWindow(t.env.DB, 24 * 3600_000);
    expect((await post(CODE)).status).toBe(200);
    expect(await settingsRow()).toMatchObject({ mode: "password", changed_by: "recovery" });
    await seed();
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    const made = await madeOf(await post(CODE));
    const [row] = await credentialRows();
    expect(await verifyAdminSecret(made.secret, parseAdminSecretHash(row.secret_hash!)!)).toBe(true);
  });

  it("reports envPinned true only when ADMIN_AUTH is exactly access in the environment", async () => {
    expect((await madeOf(await post(CODE, { env: d1Env(t.env.DB, { ADMIN_AUTH: "access" }) }))).envPinned).toBe(true);
    await seed();
    expect((await madeOf(await post(CODE, { env: d1Env(t.env.DB, { ADMIN_AUTH: "password" }) }))).envPinned).toBe(false);
    await seed();
    expect((await madeOf(await post(CODE, { env: { DB: t.env.DB } }))).envPinned).toBe(false);
  });

  it("ignores whitespace and zero-width characters around the code", async () => {
    expect((await post(`  \u200B${CODE}\t\n`)).status).toBe(200);
    await seed();
    expect((await post(`\uFEFF\u2060${CODE}\u00AD `)).status).toBe(200);
    await seed();
    expect((await post(`${CODE.slice(0, 5)}\u200B${CODE.slice(5)}`)).status).toBe(401); // only the ends are trimmed
  });

  it("makes different secrets and codes each time", async () => {
    const a = await madeOf(await post(CODE));
    const b = await madeOf(await post(a.recoveryCode));
    expect(new Set([a.secret, a.recoveryCode, b.secret, b.recoveryCode]).size).toBe(4);
  });

  it("clears the client's failed attempts", async () => {
    const ip = newIp();
    await post(wrong(), { ip });
    expect(await allAttempts()).toHaveLength(1);
    expect((await post(CODE, { ip })).status).toBe(200);
    expect(await allAttempts()).toEqual([]);
  });

  it("still answers 200 with the new secret when only clearing the attempts fails, because the credentials are already stored", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = beforeStatement(t.env.DB, /^DELETE FROM login_attempts WHERE key/, async () => { throw new Error("D1 is down"); });
    const res = await post(CODE, { env: d1Env(failing) });
    expect(res.status).toBe(200);
    const made = await madeOf(res);
    expect(await verifyAdminSecret(made.secret, parseAdminSecretHash((await loadCredentials(t.env.DB))!.secretHash)!)).toBe(true);
    expect(log.mock.calls.flat().map(String).join("\n")).not.toContain(made.secret);
  });
});

describe("POST /api/recover: rate limit", () => {
  it("allows five wrong codes, then 429 with Retry-After for the right one too, with no write", async () => {
    const ip = newIp();
    const before = await snapshot();
    for (let i = 0; i < 5; i++) expect((await post(wrong(), { ip })).status).toBe(401);
    const res = await post(CODE, { ip });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: { code: "too_many_attempts" } });
    expect(await snapshot()).toBe(before);
    expect((await post(wrong(), { ip })).status).toBe(429);
  });

  it("counts the attempt before it is checked: a wrong code leaves one counted attempt behind", async () => {
    await post(wrong());
    expect((await allAttempts()).map((r) => r.attempts)).toEqual([1]);
  });

  it("makes the sixth wrong attempt from one client a 429, and leaves another client unaffected", async () => {
    const a = newIp();
    for (let i = 0; i < 5; i++) expect((await post(wrong(), { ip: a })).status).toBe(401);
    expect((await post(wrong(), { ip: a })).status).toBe(429);
    expect((await post(wrong(), { ip: newIp() })).status).toBe(401);
    expect((await post(CODE, { ip: newIp() })).status).toBe(200);
  });

  it("has no global cap: 31 wrong attempts spread over different clients are all 401, and the right code still works", async () => {
    for (let i = 0; i < 31; i++) expect((await post(wrong())).status, `attempt ${i + 1}`).toBe(401);
    expect(await allAttempts()).toHaveLength(31);
    expect((await post(CODE)).status).toBe(200);
  });

  it("reports the time left, and opens a new window 900 s after the first attempt", async () => {
    const ip = newIp();
    for (let i = 0; i < 6; i++) await post(wrong(), { ip });
    clock.ms = NOW + 600_000;
    expect((await post(CODE, { ip })).headers.get("retry-after")).toBe("300");
    clock.ms = NOW + 900_000;
    expect((await post(CODE, { ip })).status).toBe(200);
  });

  it("uses its own keyspace, keyed with the stored recovery hash, and stores no client address", async () => {
    const ip = newIp();
    for (let i = 0; i < 6; i++) await post(wrong(), { ip });
    const keys = (await allAttempts()).map((r) => r.key);
    expect(keys).toEqual([await recoveryClientKey(ip, CODE_HASH)]);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await allAttempts())).not.toContain(ip);
    // Sign-in and setup attempts are counted apart: neither limit is touched by this one, nor this one by theirs.
    expect(keys).not.toContain(await clientKey(ip, OLD_SESSION_SECRET));
    expect(keys).not.toContain(await setupClientKey(ip, SETUP_CODE));
    const other = newIp();
    for (let i = 0; i < 10; i++) {
      await countAttempt(t.env.DB, await clientKey(other, OLD_SESSION_SECRET), Math.floor(NOW / 1000));
      await countAttempt(t.env.DB, await setupClientKey(other, SETUP_CODE), Math.floor(NOW / 1000));
    }
    expect((await post(CODE, { ip: other })).status).toBe(200);
  });
});

describe("POST /api/recover: logging", () => {
  it("writes nothing to the console on success, on a wrong code, or when limited: not the code, the new secret or the new recovery code", async () => {
    const spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const ip = newIp();
    for (let i = 0; i < 6; i++) await post(wrong(), { ip });
    await post(CODE, { ip });
    const made = await madeOf(await post(CODE));
    expect(made.secret).toBeDefined();
    expect(spies.flatMap((s) => s.mock.calls)).toHaveLength(0);
  });
});

describe("POST /api/recover: races, interleaved at the SQL level", () => {
  it("lets exactly one of two requests with one code win: the other gets 409 recovery_code_used, and one matching secret and code remain", async () => {
    let rival: Response | undefined;
    let first = true;
    const racing = beforeStatement(t.env.DB, /^UPDATE auth_settings SET recovery_hash/, async () => {
      if (!first) return;
      first = false;
      rival = await post(CODE, { ip: newIp() }); // the whole of another request lands before this one's write
    });
    const loser = await post(CODE, { env: d1Env(racing) });
    expect(rival!.status).toBe(200);
    expect(loser.status).toBe(409);
    expect(loser.headers.get("cache-control")).toBe("no-store");
    const body = await loser.json();
    expect(body).toMatchObject({ error: { code: "recovery_code_used" } });
    const made = await madeOf(rival!);
    const rows = await credentialRows();
    expect(rows).toHaveLength(1);
    const settings = (await settingsRow())!;
    expect(await verifyAdminSecret(made.secret, parseAdminSecretHash(rows[0].secret_hash!)!)).toBe(true);
    expect(await verifyAdminSecret(made.recoveryCode, parseAdminSecretHash(settings.recovery_hash!)!)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it("gives one 200 and one 409 for two simultaneous requests with one code", async () => {
    // Both read the state before either writes, then race for the compare-and-set.
    let gate!: () => void;
    const open = new Promise<void>((resolve) => { gate = resolve; });
    let waiting = 0;
    const meeting = beforeStatement(t.env.DB, /^UPDATE auth_settings SET recovery_hash/, async () => {
      if (++waiting === 2) gate();
      await open;
    });
    const [a, b] = await Promise.all([post(CODE, { env: d1Env(meeting) }), post(CODE, { env: d1Env(meeting) })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const win = a.status === 200 ? a : b;
    const made = await madeOf(win);
    const rows = await credentialRows();
    expect(rows).toHaveLength(1);
    expect(await verifyAdminSecret(made.secret, parseAdminSecretHash(rows[0].secret_hash!)!)).toBe(true);
    expect(await verifyAdminSecret(made.recoveryCode, parseAdminSecretHash((await settingsRow())!.recovery_hash!)!)).toBe(true);
  });
});

describe("POST /api/recover: database errors", () => {
  it("answers 500 internal_error, with no secret anywhere, and changes nothing, when the write fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = beforeStatement(t.env.DB, /^UPDATE auth_settings SET recovery_hash/, async () => { throw new Error("D1 is down"); });
    const before = await snapshot();
    const res = await post(CODE, { env: d1Env(failing) });
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = JSON.stringify(await res.json());
    expect(text).toContain("internal_error");
    expect(text).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(await snapshot()).toBe(before);
    expect(log.mock.calls.flat().map(String).join("\n")).not.toContain(CODE);
    expect((await post(CODE)).status).toBe(200); // the code was not spent
  });

  it("answers 500 when the state cannot be read, and 500 when the attempt cannot be counted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const noRead = { batch: async () => { throw new Error("D1 is down"); }, prepare: () => ({}) } as unknown as D1Database;
    const res = await post(CODE, { env: d1Env(noRead) });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "internal_error" } });
    const noCount = beforeStatement(t.env.DB, /^INSERT INTO login_attempts/, async () => { throw new Error("D1 is down"); });
    expect((await post(CODE, { env: d1Env(noCount) })).status).toBe(500);
  });
});

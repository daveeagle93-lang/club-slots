import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256, utf8 } from "./auth/crypto";
import { ageWindow, claimEnv, d1Env, NOW, SETUP_CODE, setOpenedAt } from "./auth/test-harness";
import { createTestEnv, type TestEnv } from "../test/db";
import { CLAIM_WINDOW_MS } from "./auth/settings";
import { claimOpenCached, MIN_SETUP_CODE_LENGTH, readSetup, setupCodeMatches, setupState } from "./setup";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });
beforeEach(async () => {
  await t.env.DB.prepare("DELETE FROM admin_credentials").run();
  await t.env.DB.prepare(
    `UPDATE auth_settings SET mode = 'password', access_team_domain = NULL, access_aud = NULL, access_hostname = NULL WHERE id = 1`,
  ).run();
  await ageWindow(t.env.DB, 0);
});

/** A database that fails the test if anything uses it: the states that never look at credentials must not. */
const noDb = new Proxy({}, { get: (_t, key) => { throw new Error(`The database was used (${String(key)})`); } }) as D1Database;

/** The test database, except that it records every statement prepared and every batch run; a new object each time, so it is a fresh memo key. */
function spied(): { db: D1Database; calls: string[] } {
  const calls: string[] = [];
  const db = {
    prepare: (sql: string) => { calls.push(sql); return t.env.DB.prepare(sql); },
    batch: (statements: D1PreparedStatement[]) => { calls.push("batch"); return t.env.DB.batch(statements); },
  } as unknown as D1Database;
  return { db, calls };
}

const HASH = `hmac-sha256$${"A".repeat(22)}$${"B".repeat(43)}`;
const putRow = (firstLoginAt: string | null) =>
  t.env.DB.prepare("INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at, first_login_at) VALUES (1, ?, ?, ?, ?)")
    .bind(HASH, "s".repeat(43), "2026-10-05T10:00:00.000Z", firstLoginAt).run();
const openedAgo = (ms: number) => setOpenedAt(t.env.DB, new Date(NOW - ms).toISOString());

describe("setupState: closed", () => {
  it("is closed unless ADMIN_AUTH is exactly password or unset, without reading the database", async () => {
    for (const ADMIN_AUTH of ["", "access", "none", "Password", "password ", "ACCESS"]) {
      expect(await setupState(d1Env(noDb, { ADMIN_AUTH })), String(ADMIN_AUTH)).toBe("closed");
    }
  });

  it("is closed in env mode, when either ADMIN_PASSWORD_HASH or ADMIN_SESSION_SECRET is set, without reading the database", async () => {
    expect(await setupState(d1Env(noDb, { ADMIN_PASSWORD_HASH: HASH }))).toBe("closed");
    expect(await setupState(d1Env(noDb, { ADMIN_SESSION_SECRET: "s".repeat(40) }))).toBe("closed");
    expect(await setupState(d1Env(noDb, { ADMIN_PASSWORD_HASH: HASH, ADMIN_SESSION_SECRET: "s".repeat(40) }))).toBe("closed");
    expect(await setupState(d1Env(noDb, { ADMIN_PASSWORD_HASH: "garbage" }))).toBe("closed"); // fail closed, even if unusable
    expect(await setupState(d1Env(noDb, { ADMIN_SESSION_SECRET: "x", SETUP_CODE: undefined }))).toBe("closed");
  });

  it("treats an empty ADMIN_PASSWORD_HASH or ADMIN_SESSION_SECRET as not set", async () => {
    expect(await setupState(d1Env(t.env.DB, { ADMIN_PASSWORD_HASH: "", ADMIN_SESSION_SECRET: "" }))).toBe("open");
  });

  it("is closed once the first sign-in has happened, even if SETUP_CODE has gone", async () => {
    await putRow("2026-10-05T11:00:00.000Z");
    expect(await setupState(d1Env(t.env.DB))).toBe("closed");
    expect(await setupState(d1Env(t.env.DB, { SETUP_CODE: undefined }))).toBe("closed");
    expect(await setupState(claimEnv(t.env.DB))).toBe("closed");
  });

  it("is closed when D1 says the mode is access", async () => {
    await t.env.DB.prepare(
      `UPDATE auth_settings SET mode = 'access', access_team_domain = 'club.cloudflareaccess.com', access_aud = 'aud', access_hostname = 'club.example' WHERE id = 1`,
    ).run();
    expect(await setupState(claimEnv(t.env.DB))).toBe("closed");
    expect(await setupState(d1Env(t.env.DB))).toBe("closed");
  });
});

describe("setupState: not_ready", () => {
  it("needs a SETUP_CODE of at least 12 characters once trimmed (enforced at runtime)", async () => {
    expect(MIN_SETUP_CODE_LENGTH).toBe(12);
    for (const SETUP_CODE of ["short", "12345678901", "   12345678901   ", "\u200b\u200b12345678901\u200b"]) {
      const read = await readSetup(d1Env(t.env.DB, { SETUP_CODE }));
      expect(read.state, JSON.stringify(SETUP_CODE)).toBe("not_ready");
      expect(read.reason, JSON.stringify(SETUP_CODE)).toBe("short_code");
    }
    expect(await setupState(d1Env(t.env.DB, { SETUP_CODE: "123456789012" }))).toBe("open");
    expect(await setupState(d1Env(t.env.DB, { SETUP_CODE: "  123456789012  " }))).toBe("open");
  });

  it("is not_ready with a short SETUP_CODE even when the window is open or a row exists", async () => {
    expect((await readSetup(d1Env(t.env.DB, { SETUP_CODE: "short" }))).reason).toBe("short_code");
    await putRow(null);
    expect(await setupState(d1Env(t.env.DB, { SETUP_CODE: "short" }))).toBe("not_ready");
  });

  it("is not_ready (expired) with no code, no row and the window run out", async () => {
    await ageWindow(t.env.DB, CLAIM_WINDOW_MS + 60_000);
    const read = await readSetup(claimEnv(t.env.DB));
    expect(read.state).toBe("not_ready");
    expect(read.reason).toBe("expired");
    expect(read.settings.setupOpenedAt).not.toBeNull();
  });

  it("treats the window as run out at exactly 30:00, and open one millisecond before", async () => {
    await openedAgo(CLAIM_WINDOW_MS);
    expect(await setupState(claimEnv(t.env.DB), NOW)).toBe("not_ready");
    await openedAgo(CLAIM_WINDOW_MS - 1);
    expect(await setupState(claimEnv(t.env.DB), NOW)).toBe("claim");
  });

  it("is not_ready (expired) when setup_opened_at is not a date", async () => {
    await setOpenedAt(t.env.DB, "not a date");
    const read = await readSetup(claimEnv(t.env.DB));
    expect(read.state).toBe("not_ready");
    expect(read.reason).toBe("expired");
  });

  it("treats a blank SETUP_CODE as no code, and a valid one as winning over an expired window", async () => {
    await ageWindow(t.env.DB, CLAIM_WINDOW_MS + 60_000);
    for (const SETUP_CODE of [undefined, "", "   "]) {
      expect(await setupState(d1Env(t.env.DB, { SETUP_CODE })), JSON.stringify(SETUP_CODE)).toBe("not_ready");
    }
    expect(await setupState(d1Env(t.env.DB))).toBe("open");
  });
});

describe("setupState: open", () => {
  it("is open with no credentials yet", async () => {
    expect(await setupState(d1Env(t.env.DB))).toBe("open");
  });

  it("is open, not claim, with a valid SETUP_CODE while the window is open", async () => {
    expect(await setupState(d1Env(t.env.DB, { ADMIN_AUTH: undefined }))).toBe("open");
  });

  it("is open while a row has not been used to sign in, so setup can be run again", async () => {
    await putRow(null);
    expect(await setupState(d1Env(t.env.DB))).toBe("open");
  });

  it("reopens when the row is deleted (the recovery path), and without SETUP_CODE falls back to the window", async () => {
    await putRow("2026-10-05T11:00:00.000Z");
    expect(await setupState(d1Env(t.env.DB))).toBe("closed");
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    expect(await setupState(d1Env(t.env.DB))).toBe("open");
    expect(await setupState(d1Env(t.env.DB, { SETUP_CODE: undefined }))).toBe("claim");
  });
});

describe("setupState: claim and claimed", () => {
  it("is claim with no code, no row and the window open (ADMIN_AUTH unset or password)", async () => {
    for (const env of [claimEnv(t.env.DB), claimEnv(t.env.DB, { ADMIN_AUTH: "password" })]) {
      const read = await readSetup(env);
      expect(read.state).toBe("claim");
      expect(read.reason).toBeNull();
    }
  });

  it("is claimed with no code and a row that has not been used to sign in", async () => {
    await putRow(null);
    const read = await readSetup(claimEnv(t.env.DB));
    expect(read.state).toBe("claimed");
    expect(read.reason).toBeNull();
  });

  it("stays claimed after the window has run out, because the row exists", async () => {
    await putRow(null);
    await ageWindow(t.env.DB, CLAIM_WINDOW_MS + 60_000);
    expect(await setupState(claimEnv(t.env.DB))).toBe("claimed");
  });

  it("defaults nowMs to the current time", async () => {
    await ageWindow(t.env.DB, 1000);
    expect(await setupState(claimEnv(t.env.DB))).toBe("claim");
  });
});

describe("claimOpenCached", () => {
  it("is true only in state claim", async () => {
    expect(await claimOpenCached(claimEnv(spied().db))).toBe(true);
    expect(await claimOpenCached(d1Env(spied().db))).toBe(false);
  });

  it("remembers a false for 60 seconds, per database, without touching D1 again", async () => {
    await ageWindow(t.env.DB, CLAIM_WINDOW_MS + 60_000);
    const now = Date.now();
    const { db, calls } = spied();
    expect(await claimOpenCached(claimEnv(db), now)).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    calls.length = 0;
    expect(await claimOpenCached(claimEnv(db), now + 59_999)).toBe(false);
    expect(calls).toEqual([]);
    expect(await claimOpenCached(claimEnv(db), now + 60_000)).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    const other = spied();
    expect(await claimOpenCached(claimEnv(other.db), now + 1)).toBe(false); // another database has its own memo
    expect(other.calls.length).toBeGreaterThan(0);
  });

  it("never remembers a true: the next call reads D1 and sees the claim made", async () => {
    const { db, calls } = spied();
    expect(await claimOpenCached(claimEnv(db), Date.now())).toBe(true);
    calls.length = 0;
    await putRow(null);
    expect(await claimOpenCached(claimEnv(db), Date.now())).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("setupCodeMatches", () => {
  it("compares SHA-256 digests (equal length, whatever the input), never the raw strings", async () => {
    const equal = vi.fn((a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]));
    expect(await setupCodeMatches("club-setup-phrase", "club-setup-phrase", equal)).toBe(true);
    expect(await setupCodeMatches("x", "club-setup-phrase", equal)).toBe(false);
    expect(await setupCodeMatches("x".repeat(256), "club-setup-phrase", equal)).toBe(false);
    expect(equal).toHaveBeenCalledTimes(3);
    expect(equal.mock.calls[0][0]).toEqual(await sha256(utf8("club-setup-phrase")));
    expect(equal.mock.calls[0][1]).toEqual(await sha256(utf8("club-setup-phrase")));
    expect(equal.mock.calls[1][0]).toEqual(await sha256(utf8("x")));
    for (const [a, b] of equal.mock.calls) {
      expect(a).toBeInstanceOf(Uint8Array);
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
    }
  });

  it("uses the constant-time compare by default", async () => {
    expect(await setupCodeMatches(SETUP_CODE, SETUP_CODE)).toBe(true);
    expect(await setupCodeMatches(SETUP_CODE, `${SETUP_CODE}!`)).toBe(false);
    expect(await setupCodeMatches("", SETUP_CODE)).toBe(false);
  });
});


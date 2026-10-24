import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "../../test/db";
import { generateAdminSecret, hashAdminSecret } from "./crypto";
import { loadCredentials, markFirstSignIn, saveCredentials } from "./credentials";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });
beforeEach(async () => {
  await t.env.DB.batch([
    t.env.DB.prepare("DELETE FROM admin_credentials"),
    t.env.DB.prepare("UPDATE auth_settings SET recovery_hash = NULL, recovery_created_at = NULL WHERE id = 1"),
  ]);
});

const H1 = `hmac-sha256$${"A".repeat(22)}$${"B".repeat(43)}`;
const H2 = `hmac-sha256$${"C".repeat(22)}$${"D".repeat(43)}`;
const S1 = "1".repeat(43);
const S2 = "2".repeat(43);
const T1 = "2026-10-05T10:00:00.000Z";
const T2 = "2026-10-05T11:00:00.000Z";
const T3 = "2026-10-05T12:00:00.000Z";
const recovery = () => t.env.DB.prepare("SELECT recovery_hash, recovery_created_at FROM auth_settings WHERE id = 1")
  .first<{ recovery_hash: string | null; recovery_created_at: string | null }>();
const claimToken = () => t.env.DB.prepare("SELECT claim_token_hash FROM auth_settings WHERE id = 1").first<{ claim_token_hash: string | null }>();
const raw = () => t.env.DB.prepare("SELECT * FROM admin_credentials").all();

describe("loadCredentials", () => {
  it("is null with no row, and the stored values with one", async () => {
    expect(await loadCredentials(t.env.DB)).toBeNull();
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1 });
    expect(await loadCredentials(t.env.DB)).toEqual({ secretHash: H1, sessionSecret: S1, firstLoginAt: null });
  });
});

describe("saveCredentials", () => {
  it("inserts the row, with first_login_at empty", async () => {
    expect(await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1 })).toBe(true);
    expect((await raw()).results).toEqual([{ id: 1, secret_hash: H1, session_secret: S1, created_at: T1, first_login_at: null }]);
  });

  it("replaces the hash and session secret while nobody has signed in", async () => {
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1 });
    expect(await saveCredentials(t.env.DB, { secretHash: H2, sessionSecret: S2, createdAt: T2 })).toBe(true);
    expect((await raw()).results).toEqual([{ id: 1, secret_hash: H2, session_secret: S2, created_at: T2, first_login_at: null }]);
  });

  it("changes nothing and says so once the first sign-in is recorded (the race: setup read 'open', then a login landed)", async () => {
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1 });
    expect(await markFirstSignIn(t.env.DB, H1, T2)).toBe(true);
    const before = (await raw()).results;
    expect(await saveCredentials(t.env.DB, { secretHash: H2, sessionSecret: S2, createdAt: "2026-10-05T12:00:00.000Z" })).toBe(false);
    expect((await raw()).results).toEqual(before);
    expect(before).toEqual([{ id: 1, secret_hash: H1, session_secret: S1, created_at: T1, first_login_at: T2 }]);
  });

  it("with a recovery hash, stores it with the credentials", async () => {
    const recoveryHash = await hashAdminSecret(generateAdminSecret());
    expect(await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1, recoveryHash })).toBe(true);
    expect((await raw()).results).toEqual([{ id: 1, secret_hash: H1, session_secret: S1, created_at: T1, first_login_at: null }]);
    expect(await recovery()).toEqual({ recovery_hash: recoveryHash, recovery_created_at: T1 });
  });

  it("without a recovery hash, leaves the stored one alone", async () => {
    const recoveryHash = await hashAdminSecret(generateAdminSecret());
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1, recoveryHash });
    expect(await saveCredentials(t.env.DB, { secretHash: H2, sessionSecret: S2, createdAt: T2 })).toBe(true);
    expect(await recovery()).toEqual({ recovery_hash: recoveryHash, recovery_created_at: T1 });
  });

  it("replaces the recovery hash along with the credentials while nobody has signed in", async () => {
    const first = await hashAdminSecret(generateAdminSecret());
    const second = await hashAdminSecret(generateAdminSecret());
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1, recoveryHash: first });
    expect(await saveCredentials(t.env.DB, { secretHash: H2, sessionSecret: S2, createdAt: T2, recoveryHash: second })).toBe(true);
    expect(await recovery()).toEqual({ recovery_hash: second, recovery_created_at: T2 });
  });

  it("writes no recovery hash once the first sign-in is recorded (false, and both rows unchanged)", async () => {
    const recoveryHash = await hashAdminSecret(generateAdminSecret());
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1, recoveryHash });
    await markFirstSignIn(t.env.DB, H1, T2);
    const before = (await raw()).results;
    const attempt = await hashAdminSecret(generateAdminSecret());
    expect(await saveCredentials(t.env.DB, { secretHash: H2, sessionSecret: S2, createdAt: T2, recoveryHash: attempt })).toBe(false);
    expect((await raw()).results).toEqual(before);
    expect(await recovery()).toEqual({ recovery_hash: recoveryHash, recovery_created_at: T1 });
  });
});

describe("saveCredentials and the claim token", () => {
  const setToken = () => t.env.DB.prepare("UPDATE auth_settings SET claim_token_hash = 'tokenhash' WHERE id = 1").run();

  it("revokes the claim token when it writes the credentials, with or without a recovery hash", async () => {
    await setToken();
    expect(await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1 })).toBe(true);
    expect(await claimToken()).toEqual({ claim_token_hash: null });
    await setToken();
    expect(await saveCredentials(t.env.DB, { secretHash: H2, sessionSecret: S2, createdAt: T2, recoveryHash: await hashAdminSecret(generateAdminSecret()) })).toBe(true);
    expect(await claimToken()).toEqual({ claim_token_hash: null });
  });

  it("does not clear the claim token when it did nothing (first sign-in recorded)", async () => {
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1 });
    await markFirstSignIn(t.env.DB, H1, T2);
    await setToken();
    expect(await saveCredentials(t.env.DB, { secretHash: H2, sessionSecret: S2, createdAt: T3 })).toBe(false);
    expect(await saveCredentials(t.env.DB, { secretHash: H2, sessionSecret: S2, createdAt: T3, recoveryHash: await hashAdminSecret(generateAdminSecret()) })).toBe(false);
    expect(await claimToken()).toEqual({ claim_token_hash: "tokenhash" });
  });
});

describe("markFirstSignIn", () => {
  it("records the time once, for the hash it was given", async () => {
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1 });
    expect(await markFirstSignIn(t.env.DB, H1, T2)).toBe(true);
    expect((await loadCredentials(t.env.DB))?.firstLoginAt).toBe(T2);
  });

  it("succeeds again for the same hash without moving the time (a later sign-in, or one that lost a race with another)", async () => {
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1 });
    expect(await markFirstSignIn(t.env.DB, H1, T2)).toBe(true);
    expect(await markFirstSignIn(t.env.DB, H1, "2026-10-05T13:00:00.000Z")).toBe(true);
    expect((await loadCredentials(t.env.DB))?.firstLoginAt).toBe(T2);
  });

  it("two simultaneous sign-ins both succeed and the row is marked once", async () => {
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1 });
    const results = await Promise.all([markFirstSignIn(t.env.DB, H1, T1), markFirstSignIn(t.env.DB, H1, T2)]);
    expect(results).toEqual([true, true]);
    const row = (await loadCredentials(t.env.DB))!;
    expect([T1, T2]).toContain(row.firstLoginAt);
    expect((await raw()).results).toHaveLength(1);
  });

  it("refuses, and marks nothing, when setup has replaced the secret that was verified", async () => {
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1 });
    await saveCredentials(t.env.DB, { secretHash: H2, sessionSecret: S2, createdAt: T2 }); // setup re-run between the check and the mark
    expect(await markFirstSignIn(t.env.DB, H1, T2)).toBe(false);
    expect((await loadCredentials(t.env.DB))?.firstLoginAt).toBeNull();
  });

  it("refuses when the row has gone, or was replaced after it had been marked", async () => {
    expect(await markFirstSignIn(t.env.DB, H1, T2)).toBe(false);
    await saveCredentials(t.env.DB, { secretHash: H1, sessionSecret: S1, createdAt: T1 });
    await markFirstSignIn(t.env.DB, H1, T2);
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    await saveCredentials(t.env.DB, { secretHash: H2, sessionSecret: S2, createdAt: T2 });
    expect(await markFirstSignIn(t.env.DB, H1, T2)).toBe(false);
    expect((await loadCredentials(t.env.DB))?.firstLoginAt).toBeNull();
  });
});

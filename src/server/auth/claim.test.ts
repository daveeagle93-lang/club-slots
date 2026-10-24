import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "../../test/db";
import { generateAdminSecret, hashAdminSecret } from "./crypto";
import { loadCredentials, markFirstSignIn, saveCredentials } from "./credentials";
import {
  CLAIM_COOKIE, claimAdmin, claimCookie, hashClaimToken, newClaimToken, readClaimToken, recoverAdmin, reissueClaim,
  type NewAdmin,
} from "./claim";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });
beforeEach(async () => {
  await t.env.DB.batch([
    t.env.DB.prepare("DELETE FROM admin_credentials"),
    t.env.DB.prepare(
      `UPDATE auth_settings SET mode = 'password', access_team_domain = NULL, access_aud = NULL, access_hostname = NULL,
         changed_at = NULL, changed_by = NULL, claim_token_hash = NULL, recovery_hash = NULL, recovery_created_at = NULL WHERE id = 1`,
    ),
  ]);
});

const T1 = "2026-10-05T10:00:00.000Z";
const T2 = "2026-10-05T11:00:00.000Z";
const T3 = "2026-10-05T12:00:00.000Z";

// Real hashes: each carries its own random salt, which is what the claim's "this caller's insert" proof relies on.
async function admin(nowIso = T1): Promise<NewAdmin & { claimTokenHash: string }> {
  return {
    secretHash: await hashAdminSecret(generateAdminSecret()),
    sessionSecret: generateAdminSecret(),
    recoveryHash: await hashAdminSecret(generateAdminSecret()),
    claimTokenHash: await hashClaimToken(newClaimToken()),
    nowIso,
  };
}

const settings = () => t.env.DB.prepare(
  "SELECT mode, changed_at, changed_by, claim_token_hash, recovery_hash, recovery_created_at FROM auth_settings WHERE id = 1",
).first<{
  mode: string; changed_at: string | null; changed_by: string | null; claim_token_hash: string | null;
  recovery_hash: string | null; recovery_created_at: string | null;
}>();
const credentialRows = async () => (await t.env.DB.prepare("SELECT * FROM admin_credentials").all()).results;

describe("claim cookie helpers", () => {
  it("builds the cookie with the exact attributes", () => {
    expect(CLAIM_COOKIE).toBe("__Host-sb_claim");
    expect(claimCookie("t")).toBe("__Host-sb_claim=t; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400");
  });

  it("reads the token among other cookies, and is null when absent", () => {
    expect(readClaimToken("a=1; __Host-sb_claim=tok-en_1; b=2")).toBe("tok-en_1");
    expect(readClaimToken("__Host-sb_claim=only")).toBe("only");
    expect(readClaimToken("a=1; b=2")).toBeNull();
    expect(readClaimToken("x__Host-sb_claim=nope")).toBeNull();
    expect(readClaimToken("__Host-sb_claim=")).toBeNull();
    expect(readClaimToken(null)).toBeNull();
  });

  it("makes a base64url token of 32 random bytes", () => {
    const a = newClaimToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newClaimToken()).not.toBe(a);
  });

  it("hashes a token to 64 hex characters, deterministically", async () => {
    const h = await hashClaimToken("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashClaimToken("abc")).toBe(h);
    expect(await hashClaimToken("abd")).not.toBe(h);
    // SHA-256("abc"), a published test vector
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("claimAdmin", () => {
  it("succeeds once; a second claim returns false and changes nothing", async () => {
    const first = await admin(T1);
    expect(await claimAdmin(t.env.DB, first)).toBe(true);
    expect(await loadCredentials(t.env.DB)).toEqual({ secretHash: first.secretHash, sessionSecret: first.sessionSecret, firstLoginAt: null });
    expect(await settings()).toMatchObject({
      claim_token_hash: first.claimTokenHash, recovery_hash: first.recoveryHash, recovery_created_at: T1,
    });
    const before = [await credentialRows(), await settings()];

    expect(await claimAdmin(t.env.DB, await admin(T2))).toBe(false);
    expect([await credentialRows(), await settings()]).toEqual(before);
  });

  it("two concurrent claimAdmin calls: exactly one true, one credentials row, and recovery_hash/claim_token_hash are the winner's", async () => {
    for (let round = 0; round < 5; round++) {
      await t.env.DB.batch([
        t.env.DB.prepare("DELETE FROM admin_credentials"),
        t.env.DB.prepare("UPDATE auth_settings SET claim_token_hash = NULL, recovery_hash = NULL, recovery_created_at = NULL WHERE id = 1"),
      ]);
      const a = await admin(T1);
      const b = await admin(T2);
      const results = await Promise.all([claimAdmin(t.env.DB, a), claimAdmin(t.env.DB, b)]);
      expect(results.filter(Boolean)).toHaveLength(1);

      const winner = results[0] ? a : b;
      const rows = await credentialRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, secret_hash: winner.secretHash, session_secret: winner.sessionSecret, created_at: winner.nowIso });
      expect(await settings()).toMatchObject({
        claim_token_hash: winner.claimTokenHash, recovery_hash: winner.recoveryHash, recovery_created_at: winner.nowIso,
      });
    }
  });

  it("does not claim over credentials that already exist (a code-flow setup, say) and leaves auth_settings alone", async () => {
    const existing = await admin();
    await t.env.DB.prepare("INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at) VALUES (1, ?, ?, ?)")
      .bind(existing.secretHash, existing.sessionSecret, T1).run();
    expect(await claimAdmin(t.env.DB, await admin(T2))).toBe(false);
    expect((await loadCredentials(t.env.DB))?.secretHash).toBe(existing.secretHash);
    expect(await settings()).toMatchObject({ claim_token_hash: null, recovery_hash: null, recovery_created_at: null });
  });
});

describe("reissueClaim", () => {
  it("with the right token, replaces the secret and the recovery hash, keeping the token", async () => {
    const first = await admin(T1);
    await claimAdmin(t.env.DB, first);
    const next = { ...(await admin(T2)), claimTokenHash: first.claimTokenHash };

    expect(await reissueClaim(t.env.DB, next)).toBe(true);
    const row = (await loadCredentials(t.env.DB))!;
    expect(row).toEqual({ secretHash: next.secretHash, sessionSecret: next.sessionSecret, firstLoginAt: null });
    expect(await settings()).toMatchObject({
      claim_token_hash: first.claimTokenHash, recovery_hash: next.recoveryHash, recovery_created_at: T2,
    });
    expect(await credentialRows()).toHaveLength(1);
  });

  it("with the wrong token, returns false and changes nothing", async () => {
    await claimAdmin(t.env.DB, await admin(T1));
    const before = [await credentialRows(), await settings()];
    expect(await reissueClaim(t.env.DB, await admin(T2))).toBe(false);
    expect([await credentialRows(), await settings()]).toEqual(before);
  });

  it("returns false and changes nothing once the first sign-in is recorded", async () => {
    const first = await admin(T1);
    await claimAdmin(t.env.DB, first);
    expect(await markFirstSignIn(t.env.DB, first.secretHash, T2)).toBe(true);
    const before = [await credentialRows(), await settings()];
    expect(await reissueClaim(t.env.DB, { ...(await admin(T3)), claimTokenHash: first.claimTokenHash })).toBe(false);
    expect([await credentialRows(), await settings()]).toEqual(before);
  });

  it("returns false after a saveCredentials (code flow) replaced the credentials, and the claim token is gone", async () => {
    const first = await admin(T1);
    await claimAdmin(t.env.DB, first);
    const codeFlow = await admin(T2);
    expect(await saveCredentials(t.env.DB, { secretHash: codeFlow.secretHash, sessionSecret: codeFlow.sessionSecret, createdAt: T2, recoveryHash: codeFlow.recoveryHash })).toBe(true);
    expect((await settings())?.claim_token_hash).toBeNull();

    expect(await reissueClaim(t.env.DB, { ...(await admin(T3)), claimTokenHash: first.claimTokenHash })).toBe(false);
    expect(await loadCredentials(t.env.DB)).toEqual({ secretHash: codeFlow.secretHash, sessionSecret: codeFlow.sessionSecret, firstLoginAt: null });
    expect((await settings())?.recovery_hash).toBe(codeFlow.recoveryHash);
  });

  it("returns false after recoverAdmin, and the claim token is gone", async () => {
    const first = await admin(T1);
    await claimAdmin(t.env.DB, first);
    const recovered = { ...(await admin(T2)), oldRecoveryHash: first.recoveryHash };
    expect(await recoverAdmin(t.env.DB, recovered)).toBe(true);
    expect((await settings())?.claim_token_hash).toBeNull();

    expect(await reissueClaim(t.env.DB, { ...(await admin(T3)), claimTokenHash: first.claimTokenHash })).toBe(false);
    expect(await loadCredentials(t.env.DB)).toEqual({ secretHash: recovered.secretHash, sessionSecret: recovered.sessionSecret, firstLoginAt: null });
    expect((await settings())?.recovery_hash).toBe(recovered.recoveryHash);
  });

  it("returns false when nothing has been claimed", async () => {
    expect(await reissueClaim(t.env.DB, await admin())).toBe(false);
    expect(await credentialRows()).toHaveLength(0);
    expect(await settings()).toMatchObject({ claim_token_hash: null, recovery_hash: null });
  });
});

describe("recoverAdmin", () => {
  async function claimed(): Promise<NewAdmin & { claimTokenHash: string }> {
    const first = await admin(T1);
    await claimAdmin(t.env.DB, first);
    return first;
  }

  it("with the right old hash: stores the new recovery hash, resets the mode, replaces the credentials and keeps first_login_at", async () => {
    const first = await claimed();
    expect(await markFirstSignIn(t.env.DB, first.secretHash, T2)).toBe(true);
    const next = { ...(await admin(T3)), oldRecoveryHash: first.recoveryHash };

    expect(await recoverAdmin(t.env.DB, next)).toBe(true);
    expect(await settings()).toMatchObject({
      recovery_hash: next.recoveryHash, recovery_created_at: T3, mode: "password", changed_at: T3, changed_by: "recovery",
      claim_token_hash: null,
    });
    expect(await loadCredentials(t.env.DB)).toEqual({ secretHash: next.secretHash, sessionSecret: next.sessionSecret, firstLoginAt: T2 });
    expect(await credentialRows()).toHaveLength(1);
  });

  it("with the wrong old hash: false, nothing changed", async () => {
    await claimed();
    const before = [await credentialRows(), await settings()];
    expect(await recoverAdmin(t.env.DB, { ...(await admin(T3)), oldRecoveryHash: await hashAdminSecret(generateAdminSecret()) })).toBe(false);
    expect([await credentialRows(), await settings()]).toEqual(before);
  });

  it("with no recovery hash stored: false, nothing changed", async () => {
    expect(await recoverAdmin(t.env.DB, { ...(await admin(T3)), oldRecoveryHash: await hashAdminSecret(generateAdminSecret()) })).toBe(false);
    expect(await credentialRows()).toHaveLength(0);
    expect(await settings()).toMatchObject({ recovery_hash: null, changed_by: null });
  });

  it("two concurrent calls with the same old hash: exactly one true, and the stored pair is the winner's", async () => {
    const first = await claimed();
    await markFirstSignIn(t.env.DB, first.secretHash, T2);
    const a = { ...(await admin(T3)), oldRecoveryHash: first.recoveryHash };
    const b = { ...(await admin(T3)), oldRecoveryHash: first.recoveryHash };

    const results = await Promise.all([recoverAdmin(t.env.DB, a), recoverAdmin(t.env.DB, b)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? a : b;
    expect(await settings()).toMatchObject({ recovery_hash: winner.recoveryHash });
    expect(await loadCredentials(t.env.DB)).toEqual({ secretHash: winner.secretHash, sessionSecret: winner.sessionSecret, firstLoginAt: T2 });
    expect(await credentialRows()).toHaveLength(1);
  });

  it("works when no credentials row exists, inserting one with first_login_at empty", async () => {
    const first = await claimed();
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    const next = { ...(await admin(T3)), oldRecoveryHash: first.recoveryHash };

    expect(await recoverAdmin(t.env.DB, next)).toBe(true);
    expect(await loadCredentials(t.env.DB)).toEqual({ secretHash: next.secretHash, sessionSecret: next.sessionSecret, firstLoginAt: null });
    expect((await settings())?.recovery_hash).toBe(next.recoveryHash);
  });

  it("resets the mode from access to password", async () => {
    const first = await claimed();
    await t.env.DB.prepare(
      `UPDATE auth_settings SET mode = 'access', access_team_domain = 'team.cloudflareaccess.com', access_aud = 'aud', access_hostname = 'h.example', changed_by = 'wizard' WHERE id = 1`,
    ).run();
    expect(await recoverAdmin(t.env.DB, { ...(await admin(T3)), oldRecoveryHash: first.recoveryHash })).toBe(true);
    expect(await settings()).toMatchObject({ mode: "password", changed_by: "recovery", changed_at: T3 });
  });
});

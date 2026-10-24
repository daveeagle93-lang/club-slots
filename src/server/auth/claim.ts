// First-run claim, replacement of a claim, and recovery-code recovery (design 3.3 and 3.6). Each write that touches both
// admin_credentials and auth_settings is ONE db.batch, which D1 runs as a single serialised transaction. Within a batch,
// the later statements are guarded by a hash only this caller can have produced (the salted secret or recovery hash), so
// a caller that lost a race writes nothing at all and the winner's rows always belong together.
//
// The claim token, the admin secret and the recovery code are never stored or logged here: only SHA-256 of the token
// and the salted hashes of the other two.

import { base64urlEncode, sha256, utf8 } from "./crypto";

export const CLAIM_COOKIE = "__Host-sb_claim";
const CLAIM_COOKIE_MAX_AGE = 86400;
const CLAIM_TOKEN_BYTES = 32;

/** Same attributes as the admin session cookie; the claim is only ever re-shown to the browser that made it. */
export function claimCookie(token: string): string {
  return `${CLAIM_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${CLAIM_COOKIE_MAX_AGE}`;
}

/** The claim token from a Cookie header, or null if absent or empty. The name must match exactly. */
export function readClaimToken(cookieHeader: string | null): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== CLAIM_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

export function newClaimToken(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(CLAIM_TOKEN_BYTES)));
}

/** SHA-256 hex. The token is 256 random bits, so an unsalted fast hash is enough and lets D1 compare it directly. */
export async function hashClaimToken(token: string): Promise<string> {
  return [...(await sha256(utf8(token)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface NewAdmin { secretHash: string; sessionSecret: string; recoveryHash: string; nowIso: string }

/**
 * The first claim: credentials, claim token hash and recovery hash, together or not at all. True iff this caller's
 * insert created the credentials row. A second claim, or credentials made another way, give false and change nothing.
 */
export async function claimAdmin(db: D1Database, a: NewAdmin & { claimTokenHash: string }): Promise<boolean> {
  const [inserted] = await db.batch([
    // Only while there is no row at all: of two simultaneous claims the batches are serialised, so the second sees the row.
    db.prepare(
      `INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at)
       SELECT 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admin_credentials)`,
    ).bind(a.secretHash, a.sessionSecret, a.nowIso),
    // The salted secret hash proves the row above is this caller's, so a loser can never write its token or recovery hash.
    db.prepare(
      `UPDATE auth_settings SET claim_token_hash = ?, recovery_hash = ?, recovery_created_at = ?
       WHERE id = 1 AND EXISTS (SELECT 1 FROM admin_credentials WHERE secret_hash = ?)`,
    ).bind(a.claimTokenHash, a.recoveryHash, a.nowIso, a.secretHash),
  ]);
  return inserted.meta.changes === 1;
}

/**
 * Replaces an unused claim's secret and recovery hash for the browser that holds the claim token (the token hash is
 * kept). Does nothing once the first sign-in is recorded. True iff the credentials were replaced.
 */
export async function reissueClaim(db: D1Database, a: NewAdmin & { claimTokenHash: string }): Promise<boolean> {
  const [replaced] = await db.batch([
    db.prepare(
      `UPDATE admin_credentials SET secret_hash = ?, session_secret = ?, created_at = ?
       WHERE id = 1 AND first_login_at IS NULL AND EXISTS (SELECT 1 FROM auth_settings WHERE id = 1 AND claim_token_hash = ?)`,
    ).bind(a.secretHash, a.sessionSecret, a.nowIso, a.claimTokenHash),
    // Only if the statement above wrote this caller's secret hash (salted, so no one else's).
    db.prepare(
      `UPDATE auth_settings SET recovery_hash = ?, recovery_created_at = ?
       WHERE id = 1 AND claim_token_hash = ? AND EXISTS (SELECT 1 FROM admin_credentials WHERE secret_hash = ?)`,
    ).bind(a.recoveryHash, a.nowIso, a.claimTokenHash, a.secretHash),
  ]);
  return replaced.meta.changes === 1;
}

/**
 * Recovery with the recovery code, whose stored hash the caller has already verified (`oldRecoveryHash`). Replaces the
 * recovery hash by compare-and-set, so one code works once, then replaces the credentials and puts the sign-in mode back
 * to the password. `first_login_at` is never touched, so setup stays closed. True iff this caller won the compare-and-set.
 */
export async function recoverAdmin(db: D1Database, a: NewAdmin & { oldRecoveryHash: string }): Promise<boolean> {
  const [swapped] = await db.batch([
    db.prepare(
      `UPDATE auth_settings SET recovery_hash = ?, recovery_created_at = ?, mode = 'password', changed_at = ?, changed_by = 'recovery'
       WHERE id = 1 AND recovery_hash = ?`,
    ).bind(a.recoveryHash, a.nowIso, a.nowIso, a.oldRecoveryHash),
    // Only if the new (salted) recovery hash is the stored one, i.e. the compare-and-set above was this caller's. The WHERE
    // is also what lets SQLite parse ON CONFLICT after INSERT ... SELECT.
    db.prepare(
      `INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at)
       SELECT 1, ?, ?, ? WHERE EXISTS (SELECT 1 FROM auth_settings WHERE id = 1 AND recovery_hash = ?)
       ON CONFLICT (id) DO UPDATE SET secret_hash = excluded.secret_hash, session_secret = excluded.session_secret, created_at = excluded.created_at`,
    ).bind(a.secretHash, a.sessionSecret, a.nowIso, a.recoveryHash),
  ]);
  return swapped.meta.changes === 1;
}

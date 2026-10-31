// The shared auth_settings row (migration 0019): the sign-in mode, the first-run claim window and the recovery hash.
// One row at most (id 1), seeded by the migration; a missing row (deleted by hand) reads as the defaults.

import type { AppEnv } from "../env";
import type { StoredCredentials } from "./credentials";

export interface AuthSettings {
  mode: "password" | "access";
  accessTeamDomain: string | null;
  accessAud: string | null;
  accessHostname: string | null;
  changedAt: string | null;
  changedBy: string | null;
  setupOpenedAt: string | null;
  claimTokenHash: string | null;
  recoveryHash: string | null;
  recoveryCreatedAt: string | null;
}

export const NO_SETTINGS: AuthSettings = {
  mode: "password", accessTeamDomain: null, accessAud: null, accessHostname: null, changedAt: null, changedBy: null,
  setupOpenedAt: null, claimTokenHash: null, recoveryHash: null, recoveryCreatedAt: null,
};

interface SettingsRow {
  mode: string; access_team_domain: string | null; access_aud: string | null; access_hostname: string | null;
  changed_at: string | null; changed_by: string | null; setup_opened_at: string | null; claim_token_hash: string | null;
  recovery_hash: string | null; recovery_created_at: string | null;
}

/** Both rows in one batch, so the mode and the credentials it chooses between are read at the same moment. */
export async function loadAuthState(db: D1Database): Promise<{ settings: AuthSettings; credentials: StoredCredentials | null }> {
  const [settingsResult, credentialsResult] = await db.batch([
    db.prepare(
      `SELECT mode, access_team_domain, access_aud, access_hostname, changed_at, changed_by, setup_opened_at, claim_token_hash,
              recovery_hash, recovery_created_at FROM auth_settings WHERE id = 1`,
    ),
    db.prepare("SELECT secret_hash, session_secret, first_login_at FROM admin_credentials WHERE id = 1"),
  ]);
  const row = (settingsResult.results as SettingsRow[])[0];
  const stored = (credentialsResult.results as { secret_hash: string; session_secret: string; first_login_at: string | null }[])[0];
  return {
    settings: row
      ? {
          mode: row.mode === "access" ? "access" : "password",
          accessTeamDomain: row.access_team_domain, accessAud: row.access_aud, accessHostname: row.access_hostname,
          changedAt: row.changed_at, changedBy: row.changed_by, setupOpenedAt: row.setup_opened_at,
          claimTokenHash: row.claim_token_hash, recoveryHash: row.recovery_hash, recoveryCreatedAt: row.recovery_created_at,
        }
      : NO_SETTINGS,
    credentials: stored ? { secretHash: stored.secret_hash, sessionSecret: stored.session_secret, firstLoginAt: stored.first_login_at } : null,
  };
}

/** Only an exact "access" or "password", or no value at all, is a setting; anything else (even "Password") fails closed. */
export function envAuthSetting(env: Pick<AppEnv, "ADMIN_AUTH">): "access" | "password-or-unset" | "invalid" {
  if (env.ADMIN_AUTH === "access") return "access";
  return env.ADMIN_AUTH === undefined || env.ADMIN_AUTH === "password" ? "password-or-unset" : "invalid";
}

export const CLAIM_WINDOW_MS = 30 * 60 * 1000;
// The migration's clock and the Worker's may differ a little; an opening this far ahead still counts as open.
const CLOCK_SKEW_MS = 60 * 1000;

/** True while the first-run claim window is open. Computed on read from when it opened, so nothing has to close it. */
export function windowOpen(setupOpenedAt: string | null, nowMs: number): boolean {
  if (setupOpenedAt === null) return false;
  const openedMs = Date.parse(setupOpenedAt);
  if (Number.isNaN(openedMs)) return false;
  const elapsed = nowMs - openedMs;
  return elapsed >= -CLOCK_SKEW_MS && elapsed < CLAIM_WINDOW_MS;
}

/**
 * Records env-configured Access in D1 (mode access, changed_by import), only if D1 does not already hold exactly these
 * values. True iff a row changed.
 */
export async function pinAccess(
  db: D1Database, v: { teamDomain: string; aud: string; hostname: string }, nowIso: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE auth_settings SET mode = 'access', access_team_domain = ?, access_aud = ?, access_hostname = ?, changed_at = ?, changed_by = 'import'
     WHERE id = 1 AND (mode IS NOT 'access' OR access_team_domain IS NOT ? OR access_aud IS NOT ? OR access_hostname IS NOT ?)`,
  ).bind(v.teamDomain, v.aud, v.hostname, nowIso, v.teamDomain, v.aud, v.hostname).run();
  return result.meta.changes > 0;
}

/** The mode stored in D1, or null when there is no row, the value is not exactly a known mode, or the read fails (logged by message only). */
export async function readStoredMode(db: D1Database): Promise<"access" | "password" | null> {
  try {
    const row = await db.prepare("SELECT mode FROM auth_settings WHERE id = 1").first<{ mode: string }>();
    return row?.mode === "access" || row?.mode === "password" ? row.mode : null;
  } catch (e) {
    console.error(`Stored mode read failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

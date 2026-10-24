import { sha256, timingSafeEqual, trimAdminSecret, utf8 } from "./auth/crypto";
import { envCredentialsSet } from "./auth/password";
import { type AuthSettings, envAuthSetting, loadAuthState, NO_SETTINGS, windowOpen } from "./auth/settings";
import type { AppEnv } from "./env";

/** Enforced at runtime, not only in the deploy prompt: a shorter SETUP_CODE leaves /setup not_ready. */
export const MIN_SETUP_CODE_LENGTH = 12;

/**
 * closed: 404 everywhere (not the password provider, credentials set by environment variables or by Access in D1, or the
 * first sign-in has happened). not_ready: SETUP_CODE is too short, or there is no code and the claim window has run out.
 * open: a code may be entered. claim: no code, no admin secret yet, window open. claimed: no code, a secret made, not yet used.
 */
export type SetupState = "closed" | "not_ready" | "open" | "claim" | "claimed";

export interface SetupRead {
  state: SetupState;
  settings: AuthSettings;
  /** Why the state is not_ready; null in every other state. */
  reason: "short_code" | "expired" | null;
}

/** The one place the not_ready texts live (the API and the /setup page both use it). */
export function setupNotReadyMessage(reason: "short_code" | "expired"): string {
  return reason === "short_code"
    ? "Setup isn't ready: SETUP_CODE must be at least 12 characters."
    : "Setup is closed. The first-run window ended, so nobody can create an admin secret from the web any more. To reopen it, set `SETUP_CODE` as a Worker secret (any phrase of 12+ characters) and reload, or see [handover](../handover.md).";
}

/** SETUP_CODE trimmed the way a submitted code is, or null if it is missing or shorter than MIN_SETUP_CODE_LENGTH. */
export function expectedSetupCode(env: AppEnv): string | null {
  const code = trimAdminSecret(env.SETUP_CODE ?? "");
  return [...code].length >= MIN_SETUP_CODE_LENGTH ? code : null;
}

/** Reads D1 only when ADMIN_AUTH and the credential variables leave the password provider in D1 mode. */
export async function readSetup(env: AppEnv, nowMs: number = Date.now()): Promise<SetupRead> {
  if (envAuthSetting(env) !== "password-or-unset" || envCredentialsSet(env)) return { state: "closed", settings: NO_SETTINGS, reason: null };
  const { settings, credentials } = await loadAuthState(env.DB);
  const read = (state: SetupState, reason: SetupRead["reason"] = null): SetupRead => ({ state, settings, reason });
  if (settings.mode === "access" || credentials?.firstLoginAt != null) return read("closed");
  if (expectedSetupCode(env) !== null) return read("open");
  if (trimAdminSecret(env.SETUP_CODE ?? "") !== "") return read("not_ready", "short_code");
  if (credentials !== null) return read("claimed");
  return windowOpen(settings.setupOpenedAt, nowMs) ? read("claim") : read("not_ready", "expired");
}

export async function setupState(env: AppEnv, nowMs?: number): Promise<SetupState> {
  return (await readSetup(env, nowMs)).state;
}

const NOT_CLAIMABLE_MS = 60 * 1000;
// When each database was last seen not claimable. Only that is kept: a claimable site must always be read afresh.
const notClaimableAt = new WeakMap<D1Database, number>();

/** True iff the state is claim. A false is remembered for 60 s per isolate (it only saves reads for the convenience redirect on /). */
export async function claimOpenCached(env: AppEnv, nowMs: number = Date.now()): Promise<boolean> {
  const seen = notClaimableAt.get(env.DB);
  if (seen !== undefined && nowMs - seen < NOT_CLAIMABLE_MS) return false;
  if ((await setupState(env, nowMs)) === "claim") return true;
  notClaimableAt.set(env.DB, nowMs);
  return false;
}

/** Compares SHA-256 digests, which are always the same length, so neither the content nor the length of the code shows in the timing. */
export async function setupCodeMatches(submitted: string, expected: string, equal = timingSafeEqual): Promise<boolean> {
  return equal(await sha256(utf8(submitted)), await sha256(utf8(expected)));
}

import type { AppEnv } from "../env";
import { createAccessAuth, parseAccessConfig, sharedAccessAuth, type AccessAuth } from "./access";
import { createPasswordAuth, envCredentialsSet, parsePasswordConfig, type PasswordAuth } from "./password";
import { envAuthSetting, loadAuthState } from "./settings";
import type { AuthDeps } from "./types";

export type { AdminAuth, AdminData, AdminSession, AuthDeps } from "./types";
export type { PasswordAuth } from "./password";

const ACCESS_UNUSABLE_ENV = "ACCESS_TEAM_DOMAIN must be a cloudflareaccess.com host and ACCESS_AUD must be set";
const ACCESS_UNUSABLE_STORED = "the stored Access settings in auth_settings are unusable (team domain or AUD)";

/**
 * The one admin authenticator. Fails closed: an ADMIN_AUTH value other than "access", "password" or unset, or settings the
 * chosen provider cannot use, is not_configured, and callers must then refuse every admin request.
 * With injected dependencies (tests) the Access provider is built fresh instead of shared.
 *
 * Env `access` decides alone, with Access settings from env, and D1 is not read. Otherwise (unset or "password") the
 * sign-in mode in auth_settings decides: `access` uses the Access settings stored there, even over leftover
 * ADMIN_PASSWORD_HASH or ADMIN_SESSION_SECRET; `password` uses the password provider.
 *
 * The password provider takes its secrets from ADMIN_PASSWORD_HASH and ADMIN_SESSION_SECRET if either is set (both
 * must then be valid: it never falls back to D1), and otherwise from the admin_credentials row made on /setup, which
 * is read on every call (nothing is cached). `awaitingSetup` marks the case of no row yet.
 */
export async function adminAuthFor(
  env: AppEnv, deps?: AuthDeps,
): Promise<{ auth: AccessAuth | PasswordAuth } | { error: "not_configured"; reason: string; awaitingSetup?: true }> {
  const fromEnv = envAuthSetting(env);
  if (fromEnv === "invalid") return { error: "not_configured", reason: 'ADMIN_AUTH must be "access" or "password"' };
  const accessAuth = (settings: Parameters<typeof parseAccessConfig>[0], unusable: string) => {
    const config = parseAccessConfig(settings);
    if (!config) return { error: "not_configured" as const, reason: unusable };
    return { auth: (deps ? createAccessAuth(config, deps) : sharedAccessAuth(config)) };
  };
  if (fromEnv === "access") return accessAuth(env, ACCESS_UNUSABLE_ENV);

  const { settings, credentials: stored } = await loadAuthState(env.DB);
  if (settings.mode === "access") {
    return accessAuth({ ACCESS_TEAM_DOMAIN: settings.accessTeamDomain ?? undefined, ACCESS_AUD: settings.accessAud ?? undefined }, ACCESS_UNUSABLE_STORED);
  }
  if (envCredentialsSet(env)) {
    const config = parsePasswordConfig(env);
    if (typeof config === "string") return { error: "not_configured", reason: config };
    return { auth: createPasswordAuth(config, deps) };
  }
  if (!stored) return { error: "not_configured", reason: "no admin credentials yet: open /setup", awaitingSetup: true };
  const config = parsePasswordConfig({ ADMIN_PASSWORD_HASH: stored.secretHash, ADMIN_SESSION_SECRET: stored.sessionSecret });
  if (typeof config === "string") return { error: "not_configured", reason: config };
  return { auth: createPasswordAuth(config, deps, { db: env.DB, secretHash: stored.secretHash, firstLoginAt: stored.firstLoginAt }) };
}

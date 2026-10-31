import { markFirstSignIn } from "./credentials";
import { parseAdminSecretHash, verifyAdminSecret, type AdminSecretHash } from "./crypto";
import { clientKey } from "./ratelimit";
import { clearedSessionCookie, issueSession, readSession, sessionCookie } from "./session";
import type { AdminAuth, AdminSession, AuthDeps } from "./types";

export const MIN_SESSION_SECRET_LENGTH = 32;

export interface PasswordAuth extends AdminAuth {
  readonly kind: "password";
  checkPassword(password: string): Promise<boolean>;
  /** A new session and the Set-Cookie header value that carries it. */
  startSession(): Promise<{ session: AdminSession; setCookie: string }>;
  clearCookie(): string;
  /** The login rate-limit key for a client address, keyed with the session secret so stored keys are not reversible. */
  clientKey(ip: string | null): Promise<string>;
  /**
   * Called once the password has checked out. With credentials from D1 it records the first sign-in (which closes
   * /setup) for the credentials that were verified, and is false if setup replaced them meanwhile: refuse then.
   * With ADMIN_PASSWORD_HASH and ADMIN_SESSION_SECRET it does nothing and is true.
   */
  confirmSignIn(): Promise<boolean>;
}

/** Credentials that came from D1, which is what confirmSignIn needs to mark them. `firstLoginAt` is as loaded: once set, nothing more is to be recorded. */
export interface StoredSource { db: D1Database; secretHash: string; firstLoginAt: string | null }

/** Env mode: either variable set (even if unusable) means the settings are the operator's, and D1 credentials are ignored. */
export const envCredentialsSet = (env: { ADMIN_PASSWORD_HASH?: string; ADMIN_SESSION_SECRET?: string }): boolean =>
  Boolean(env.ADMIN_PASSWORD_HASH) || Boolean(env.ADMIN_SESSION_SECRET);

export interface PasswordConfig { hash: AdminSecretHash; sessionSecret: string }

/** The usable settings, or a reason fit for logs (never a value) why not. */
export function parsePasswordConfig(
  env: { ADMIN_PASSWORD_HASH?: string; ADMIN_SESSION_SECRET?: string },
): PasswordConfig | string {
  const hash = parseAdminSecretHash(env.ADMIN_PASSWORD_HASH);
  if (!hash) return "ADMIN_PASSWORD_HASH is missing or malformed: it must be hmac-sha256$<salt>$<mac>, so run `npm run generate-admin-secret` (earlier pbkdf2-sha256 values no longer work)";
  const sessionSecret = env.ADMIN_SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    return `ADMIN_SESSION_SECRET is missing or shorter than ${MIN_SESSION_SECRET_LENGTH} characters`;
  }
  return { hash, sessionSecret };
}

export function createPasswordAuth({ hash, sessionSecret }: PasswordConfig, deps: AuthDeps = {}, stored?: StoredSource): PasswordAuth {
  const now = deps.now ?? Date.now;
  return {
    kind: "password",
    checkPassword: (password) => verifyAdminSecret(password, hash),
    async startSession() {
      const { value, sid } = await issueSession(sessionSecret, now());
      return { session: { identity: "admin", csrfBinding: sid }, setCookie: sessionCookie(value) };
    },
    clearCookie: clearedSessionCookie,
    clientKey: (ip) => clientKey(ip, sessionSecret),
    // Already marked when loaded: setup cannot replace the row any more, and the hash verified is the hash loaded, so there is nothing to write.
    confirmSignIn: async () => !stored || stored.firstLoginAt !== null || markFirstSignIn(stored.db, stored.secretHash, new Date(now()).toISOString()),
    async authenticate(request) {
      try {
        const sid = await readSession(sessionSecret, request.headers.get("Cookie"), now());
        return sid === null ? null : { identity: "admin", csrfBinding: sid };
      } catch {
        return null;
      }
    },
  };
}

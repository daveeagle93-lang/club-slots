/** What a verified admin request carries. Handlers read `context.data.admin`. */
export interface AdminSession {
  /** Access: the verified email. Password: the fixed string "admin". */
  identity: string;
  /**
   * An unguessable per-session secret the CSRF token is derived from (src/server/auth/csrf.ts).
   * Access: the verified JWT. Password: the session id from the signed cookie.
   */
  csrfBinding: string;
}

export interface AdminAuth {
  readonly kind: "access" | "password";
  /** null = not authenticated. Never throws for bad input. */
  authenticate(request: Request): Promise<AdminSession | null>;
}

/** The `context.data` shape after guardAdminApi (src/worker/guards.ts) has run. */
export type AdminData = { admin: AdminSession };

/** Injection points for tests; production uses the globals. `now` returns epoch milliseconds. */
export interface AuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/** The bindings and variables the handlers read. Wider than the generated global `Env`, which only has the bindings (DB, ASSETS). */
export interface AppEnv {
  DB: D1Database;
  /** The Worker's static-asset binding (what is in public/): the pages, scripts and default icons. Optional so tests can omit it. */
  ASSETS?: Fetcher;
  /** Minutes after the event's start at which bookings close (negative = before). See docs/configuration.md. */
  BOOKING_CUTOFF_OFFSET_MINUTES?: string;
  /** Plain-text privacy notice shown on the booking form. See docs/configuration.md. */
  PRIVACY_NOTICE?: string;
  /** Admin sign-in method: unset or "password": the sign-in mode stored in D1 decides; "access" pins Access; anything else fails closed. See docs/admin-auth.md. */
  ADMIN_AUTH?: string;
  /** Access only: the team's cloudflareaccess.com host. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access only: the application's AUD tag. */
  ACCESS_AUD?: string;
  /** Password only, SECRET: `hmac-sha256$...` from `npm run generate-admin-secret`. */
  ADMIN_PASSWORD_HASH?: string;
  /** Password only, SECRET: at least 32 random characters that sign the session cookie. */
  ADMIN_SESSION_SECRET?: string;
  /** Optional: when set (12+ characters) /setup asks for it and the first-run claim window is off. */
  SETUP_CODE?: string;
}

/** What the Worker's router hands a route handler. `data` carries what the guards add (the admin session, under `admin`). */
export interface RouteContext<Params extends string = string, Data = Record<string, unknown>> {
  request: Request;
  env: AppEnv;
  /** The captured, percent-decoded `:param` segments of the matched pattern. */
  params: Record<Params, string>;
  data: Data;
}

/** A route handler: the exported `onRequest*` functions under src/routes/. */
export type RouteHandler<Params extends string = string, Data = Record<string, unknown>> =
  (context: RouteContext<Params, Data>) => Response | Promise<Response>;

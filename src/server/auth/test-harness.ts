// Test-only helpers: run a request through the admin API guard and then the matching route, as the Worker does.
import { vi } from "vitest";
import { guardAdminApi } from "../../worker/guards";
import { createLoginHandler } from "../../routes/api/admin/login";
import { onRequestPost as logout } from "../../routes/api/admin/logout";
import { onRequestGet as session } from "../../routes/api/admin/session";
import { json } from "../http";
import type { AppEnv } from "../env";
import { base64urlEncode, hashAdminSecret, utf8 } from "./crypto";
import type { AuthDeps } from "./types";

export const ORIGIN = "https://club.example";
export const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
// A fixed value in the generated form (43 base64url characters, canonical), so tests are repeatable.
export const TEST_PASSWORD = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw";
export const SESSION_SECRET = "test-only-session-secret-0123456789-abcdef";
export const ACCESS_TEAM = "club.cloudflareaccess.com";
export const ACCESS_AUD = "aud-tag-1234567890";

let hash: Promise<string> | undefined;
export const passwordEnv = async (db: D1Database): Promise<AppEnv> => ({
  DB: db, ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: await (hash ??= hashAdminSecret(TEST_PASSWORD)), ADMIN_SESSION_SECRET: SESSION_SECRET,
});
/** A valid SETUP_CODE (12+ characters once trimmed) for the first-run setup tests. */
export const SETUP_CODE = "club-setup-phrase";
/** The password provider with no ADMIN_PASSWORD_HASH or ADMIN_SESSION_SECRET: credentials are in D1 (made on /setup), as on a new deployment. */
export const d1Env = (db: D1Database, over: Partial<AppEnv> = {}): AppEnv => ({ DB: db, ADMIN_AUTH: "password", SETUP_CODE, ...over });
/**
 * The database, except that a statement whose SQL matches `match` first awaits `hook` each time it runs: lets a test slip
 * another request in between two steps of one handler (an interleaving at the SQL level). Only the methods the handlers use.
 * In a batch, the hook of each matching statement runs just before the whole batch, which is as close to "just before
 * that statement" as a transactional batch allows.
 */
export function beforeStatement(db: D1Database, match: RegExp, hook: () => Promise<void>): D1Database {
  const real = Symbol("real");
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => ({
    [real]: stmt,
    bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
    run: async () => { await hook(); return stmt.run(); },
    first: async (column?: string) => { await hook(); return column === undefined ? stmt.first() : stmt.first(column); },
    all: async () => { await hook(); return stmt.all(); },
    raw: async () => { await hook(); return stmt.raw(); },
  }) as unknown as D1PreparedStatement;
  const unwrap = (stmt: D1PreparedStatement): D1PreparedStatement => (stmt as unknown as Record<symbol, D1PreparedStatement>)[real] ?? stmt;
  return {
    prepare: (sql: string) => (match.test(sql) ? wrap(db.prepare(sql)) : db.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      for (const stmt of statements) if ((stmt as unknown as Record<symbol, unknown>)[real] !== undefined) await hook();
      return db.batch(statements.map(unwrap));
    },
  } as unknown as D1Database;
}
/** An environment with no ADMIN_AUTH and no SETUP_CODE, as on a fresh zero-config deployment. */
export const claimEnv = (db: D1Database, over: Partial<AppEnv> = {}): AppEnv => ({ DB: db, ...over });
export async function setOpenedAt(db: D1Database, iso: string): Promise<void> {
  await db.prepare("UPDATE auth_settings SET setup_opened_at = ? WHERE id = 1").bind(iso).run();
}
/** Makes the claim window have opened `ms` milliseconds ago. */
export const ageWindow = (db: D1Database, ms: number): Promise<void> => setOpenedAt(db, new Date(Date.now() - ms).toISOString());
export const accessEnv = (db: D1Database): AppEnv => ({
  DB: db, ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: ACCESS_TEAM, ACCESS_AUD,
});

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
export interface AccessKey { kid: string; pair: CryptoKeyPair; jwk: JsonWebKey & { kid: string } }

export async function newAccessKey(kid: string): Promise<AccessKey> {
  const pair = (await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, pair, jwk: Object.assign(jwk, { kid }) };
}

export const jsonPart = (value: unknown): string => base64urlEncode(utf8(JSON.stringify(value)));

export const accessClaims = (over: Record<string, unknown> = {}) => ({
  iss: `https://${ACCESS_TEAM}`, aud: [ACCESS_AUD], email: "admin@club.example", exp: NOW / 1000 + 600, iat: NOW / 1000 - 10, ...over,
});

export async function accessJwt(key: AccessKey, claims: unknown = accessClaims(), header: Record<string, unknown> = {}): Promise<string> {
  const input = `${jsonPart({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })}.${jsonPart(claims)}`;
  const signature = await crypto.subtle.sign(RS256, key.pair.privateKey, utf8(input));
  return `${input}.${base64urlEncode(new Uint8Array(signature))}`;
}

/** A fetch that serves the given keys as Cloudflare's certs endpoint would. */
export const jwksFetch = (keys: () => AccessKey[]) =>
  vi.fn(async () => Response.json({ keys: keys().map((k) => k.jwk), public_cert: { kid: "x", cert: "x" }, public_certs: [] }));

/**
 * `/api/admin/whoami` is a stand-in for the other admin routes: it echoes what the guard put in `data`.
 * Any other path the guard lets through ends at a 404, as an unknown path does in the Worker.
 * `routes` adds more routes (return undefined for a path it doesn't handle), so a test can put a real handler behind the real guard.
 * For the whole Worker (router, guards and headers together) use createWorker from src/worker.ts instead.
 */
export function adminApp(deps: AuthDeps = {}, routes?: (context: never) => Response | Promise<Response> | undefined) {
  const login = createLoginHandler(deps);
  return async (env: AppEnv, path: string, init: RequestInit = {}): Promise<Response> => {
    const request = new Request(`${ORIGIN}${path}`, init);
    const guarded = await guardAdminApi(request, env, deps);
    if (guarded instanceof Response) return guarded;
    const data: Record<string, unknown> = { ...guarded };
    const route = (): Response | Promise<Response> => {
      const { pathname } = new URL(request.url);
      const context = { request, env, data, params: {} } as never;
      if (pathname === "/api/admin/session" && request.method === "GET") return session(context);
      if (pathname === "/api/admin/login" && request.method === "POST") return login(context);
      if (pathname === "/api/admin/logout" && request.method === "POST") return logout(context);
      if (pathname === "/api/admin/whoami") return json({ data });
      const routed = routes?.(context);
      if (routed) return routed;
      return new Response("not found", { status: 404 });
    };
    return route();
  };
}

/** Headers of a well-formed same-origin admin write. */
export const writeHeaders = (csrfToken: string, extra: Record<string, string> = {}): Record<string, string> => ({
  Origin: ORIGIN, "Content-Type": "application/json", "X-CSRF-Token": csrfToken, ...extra,
});

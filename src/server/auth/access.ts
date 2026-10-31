import type { AppEnv } from "../env";
import { base64urlDecode, utf8 } from "./crypto";
import type { AdminAuth, AdminSession, AuthDeps } from "./types";

// Cloudflare Access validation, following
// https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
// - Read the token from the Cf-Access-Jwt-Assertion header (the docs recommend it over the CF_Authorization cookie).
//   Cf-Access-Authenticated-User-Email is never read: it is not signed.
// - Keys are at https://<team>.cloudflareaccess.com/cdn-cgi/access/certs. They rotate about every 6 weeks with a
//   7-day overlap, so pick the JWK by the token's `kid`; `public_cert` is never used.
// - RS256 only; check the signature, then iss, aud, exp (and nbf), and that the token carries an email.

const TEAM_DOMAIN = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/i;
const MAX_TOKEN_LENGTH = 8192;
const MAX_KEYSET_BYTES = 64 * 1024;
const KEYSET_TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000; // between forced refetches (unknown kid) and after a failed fetch
const FETCH_TIMEOUT_MS = 3000;
const NBF_LEEWAY_SECONDS = 30;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

export interface AccessConfig { teamDomain: string; aud: string }
export type AccessAuth = AdminAuth & { readonly kind: "access" };

/** The team domain decides which host the keys come from, so anything but a cloudflareaccess.com host is refused. */
export function parseAccessConfig(env: Pick<AppEnv, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!teamDomain || !aud || !TEAM_DOMAIN.test(teamDomain)) return null;
  return { teamDomain, aud };
}

const fail = (reason: string): null => {
  console.error(`Access auth: ${reason}`);
  return null;
};

function parseJson(segment: string): Record<string, unknown> | null {
  const bytes = base64urlDecode(segment);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createAccessAuth(config: AccessConfig, deps: AuthDeps = {}): AccessAuth {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = deps.now ?? Date.now;
  const issuer = `https://${config.teamDomain}`;
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = -Infinity;
  let lastForced = -Infinity;
  let lastFailure = -Infinity;
  let inflight: Promise<boolean> | null = null;

  async function load(): Promise<boolean> {
    try {
      const res = await doFetch(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_KEYSET_BYTES) throw new Error("response too large");
      const listed = (JSON.parse(text) as { keys?: unknown }).keys;
      if (!Array.isArray(listed)) throw new Error("no keys array");
      const next = new Map<string, CryptoKey>();
      for (const jwk of listed) {
        if (typeof jwk !== "object" || jwk === null) continue;
        const { kty, kid, n, e } = jwk as Record<string, unknown>;
        if (kty !== "RSA" || typeof kid !== "string" || typeof n !== "string" || typeof e !== "string") continue;
        try {
          next.set(kid, await crypto.subtle.importKey("jwk", { kty, n, e, alg: "RS256", ext: true }, RS256, false, ["verify"]));
        } catch { /* skip a key that will not import */ }
      }
      if (next.size === 0) throw new Error("no usable RSA keys");
      keys = next;
      fetchedAt = now();
      return true;
    } catch (e) {
      lastFailure = now();
      fail(`could not load keys: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** One fetch at a time, shared by whoever asks meanwhile. */
  const refresh = (): Promise<boolean> => (inflight ??= load().finally(() => { inflight = null; }));

  async function keyFor(kid: string): Promise<CryptoKey | null> {
    let justFetched = false;
    if (now() - fetchedAt >= KEYSET_TTL_MS) {
      if (now() - lastFailure < RETRY_MS || !(await refresh())) return null;
      justFetched = true;
    }
    const known = keys.get(kid);
    if (known || justFetched || now() - lastForced < RETRY_MS) return known ?? null;
    // Possibly a freshly rotated key. At most one forced refetch a minute, so junk kids cannot hammer the endpoint.
    lastForced = now();
    await refresh();
    return keys.get(kid) ?? null;
  }

  async function verify(token: string): Promise<AdminSession | null> {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    const segments = token.split(".");
    if (segments.length !== 3 || !segments.every((s) => SEGMENT.test(s))) return null;
    const header = parseJson(segments[0]);
    if (header?.alg !== "RS256" || typeof header.kid !== "string") return null; // never trust a token's own choice of algorithm
    const signature = base64urlDecode(segments[2]);
    const key = signature && (await keyFor(header.kid));
    if (!key || !signature) return null;
    if (!(await crypto.subtle.verify(RS256, key, signature, utf8(`${segments[0]}.${segments[1]}`)))) return null;
    // Only now is the payload trusted enough to look at.
    const claims = parseJson(segments[1]);
    if (!claims) return null;
    const seconds = now() / 1000;
    const { aud, exp, nbf, email } = claims;
    if (claims.iss !== issuer) return null;
    if (!(typeof aud === "string" ? aud === config.aud : Array.isArray(aud) && aud.includes(config.aud))) return null;
    if (typeof exp !== "number" || !(seconds < exp)) return null;
    if (nbf !== undefined && (typeof nbf !== "number" || !(seconds >= nbf - NBF_LEEWAY_SECONDS))) return null;
    if (typeof email !== "string" || !email.trim().includes("@")) return null; // service tokens carry no email
    return { identity: email.trim(), csrfBinding: token };
  }

  return {
    kind: "access",
    async authenticate(request) {
      try {
        return await verify(request.headers.get("Cf-Access-Jwt-Assertion") ?? "");
      } catch (e) {
        return fail(`verification error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

const shared = new Map<string, AccessAuth>();

/** The production instance for a config, reused across requests so its key cache survives. */
export function sharedAccessAuth(config: AccessConfig): AccessAuth {
  const id = `${config.teamDomain}\n${config.aud}`;
  let auth = shared.get(id);
  if (!auth) shared.set(id, (auth = createAccessAuth(config)));
  return auth;
}

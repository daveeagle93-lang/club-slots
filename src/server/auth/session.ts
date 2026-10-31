import { base64urlDecode, base64urlEncode, utf8 } from "./crypto";

// Stateless admin session: `v1.<payload>.<signature>`, payload = base64url(JSON {sid, iat, exp}) in seconds,
// signature = HMAC-SHA256 over a version-tagged payload with ADMIN_SESSION_SECRET. The cookie is the only
// state, so logout cannot revoke it before it expires; rotating the secret invalidates every session.
export const SESSION_COOKIE = "__Host-sb_admin";
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;
const MAX_COOKIE_HEADER = 4096;
const SIGNED_PREFIX = "slot-booker-session-v1.";
const SID_PATTERN = /^[A-Za-z0-9_-]{22}$/; // 128 random bits

const attributes = "HttpOnly; Secure; SameSite=Strict; Path=/";
export const sessionCookie = (value: string): string =>
  `${SESSION_COOKIE}=${value}; ${attributes}; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
export const clearedSessionCookie = (): string => `${SESSION_COOKIE}=; ${attributes}; Max-Age=0`;

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function issueSession(secret: string, nowMs: number): Promise<{ value: string; sid: string }> {
  const sid = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const iat = Math.floor(nowMs / 1000);
  const payload = base64urlEncode(utf8(JSON.stringify({ sid, iat, exp: iat + SESSION_MAX_AGE_SECONDS })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(SIGNED_PREFIX + payload));
  return { value: `v1.${payload}.${base64urlEncode(new Uint8Array(signature))}`, sid };
}

/** Every value the header carries for the session cookie, in order: a duplicate must not hide a valid one. */
function cookieValues(header: string | null): string[] {
  if (!header || header.length > MAX_COOKIE_HEADER) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === SESSION_COOKIE) values.push(part.slice(eq + 1).trim());
  }
  return values;
}

/** The session id if any one of the request's session cookies is genuine and current; null otherwise. */
export async function readSession(secret: string, cookieHeader: string | null, nowMs: number): Promise<string | null> {
  for (const value of cookieValues(cookieHeader)) {
    const sid = await readCookieValue(secret, value, nowMs);
    if (sid !== null) return sid;
  }
  return null;
}

/** Signature first, then claims. */
async function readCookieValue(secret: string, value: string, nowMs: number): Promise<string | null> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const signature = base64urlDecode(parts[2]);
  if (!signature) return null;
  // crypto.subtle.verify compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, utf8(SIGNED_PREFIX + parts[1])))) return null;
  const bytes = base64urlDecode(parts[1]);
  if (!bytes) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;
  const { sid, iat, exp, ...rest } = claims as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof sid !== "string" || !SID_PATTERN.test(sid)) return null;
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return null;
  const now = Math.floor(nowMs / 1000);
  const issued = iat as number;
  const expires = exp as number;
  if (expires <= now || expires <= issued || issued > now + CLOCK_SKEW_SECONDS) return null;
  if (expires - issued > MAX_LIFETIME_SECONDS) return null;
  return sid;
}

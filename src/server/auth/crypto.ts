// WebCrypto helpers for admin auth. Deliberately no relative imports: scripts/generate-admin-secret.ts loads
// this file under plain Node, which needs explicit extensions that the type checker here refuses.

const encoder = new TextEncoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Unpadded base64url only; null for anything else. */
export function base64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Node has no crypto.subtle.timingSafeEqual (workerd does), so: length check, then XOR over the whole length. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// The admin secret is generated, not chosen: 32 random bytes, base64url without padding (exactly 43 characters,
// 256 bits). It is far too random to guess or brute-force from a stored value, so a salted HMAC-SHA-256 is enough
// to verify it and no slow password KDF is needed (Workers have only PBKDF2 natively, and that is capped at
// 100,000 iterations and costs real CPU time). Stored as `hmac-sha256$<salt>$<mac>`, mac = HMAC(key = salt, secret).
const HASH_PREFIX = "hmac-sha256";
const SALT_BYTES = 16;
const MAC_BYTES = 32;
const SECRET_BYTES = 32;
const SECRET_LENGTH = 43; // base64url of 32 bytes, unpadded

export interface AdminSecretHash { salt: Uint8Array; mac: Uint8Array }

export function generateAdminSecret(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/**
 * The one accepted spelling of a generated secret. The last character of 43 base64url characters carries only
 * 4 bits, so other spellings decode to the same bytes; the re-encode check refuses them. Checked before any hashing.
 */
export function isCanonicalAdminSecret(text: string): boolean {
  if (text.length !== SECRET_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) return false;
  const bytes = base64urlDecode(text);
  return bytes?.length === SECRET_BYTES && base64urlEncode(bytes) === text;
}

// Characters people pick up copying a secret from chat apps or PDFs. String.prototype.trim covers whitespace (NBSP,
// BOM, line and paragraph separators and every Zs space) but not these; a generated secret contains none of them.
// public/admin/login.js repeats this set and its test checks the two agree, so change both together.
const INVISIBLE = "\u200B\u200C\u200D\u2060\u180E\u00AD";
const isIgnorable = (char: string): boolean => char.trim() === "" || INVISIBLE.includes(char);

/** Drops whitespace and invisible characters from both ends only; anything inside the text is kept (and so still fails). */
export function trimAdminSecret(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && isIgnorable(input[start])) start++;
  while (end > start && isIgnorable(input[end - 1])) end--;
  return input.slice(start, end);
}

async function mac(salt: Uint8Array, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(secret)));
}

/** `hmac-sha256$<salt>$<mac>`, both base64url. */
export async function hashAdminSecret(
  secret: string, salt: Uint8Array = crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
): Promise<string> {
  return [HASH_PREFIX, base64urlEncode(salt), base64urlEncode(await mac(salt, secret))].join("$");
}

/** null if malformed, including every earlier `pbkdf2-sha256$...` value. */
export function parseAdminSecretHash(stored: string | undefined): AdminSecretHash | null {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 3 || parts[0] !== HASH_PREFIX) return null;
  const salt = base64urlDecode(parts[1]);
  const macBytes = base64urlDecode(parts[2]);
  if (salt?.length !== SALT_BYTES || macBytes?.length !== MAC_BYTES) return null;
  return { salt, mac: macBytes };
}

export async function verifyAdminSecret(secret: string, stored: AdminSecretHash): Promise<boolean> {
  if (!isCanonicalAdminSecret(secret)) return false;
  return timingSafeEqual(await mac(stored.salt, secret), stored.mac);
}

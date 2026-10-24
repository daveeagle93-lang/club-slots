import { utf8 } from "./crypto";

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 15 * 60;
const KEEP_SECONDS = 24 * 60 * 60;
const PURGE_BATCH = 100;

/**
 * Deletes rows whose window ended over a day ago, at most PURGE_BATCH per attempt so one request never does
 * unbounded work; a backlog is cleared over the next attempts. Uses the window_start index (migration 0007).
 */
export const PURGE_SQL = `DELETE FROM login_attempts WHERE rowid IN (
  SELECT rowid FROM login_attempts WHERE window_start < ? LIMIT ${PURGE_BATCH})`;

const hextet = /^[0-9a-f]{1,4}$/i;
const octet = /^[0-9]{1,3}$/;

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. The zone id must already be gone. */
function ipv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (text: string): number[] | null => {
    if (text === "") return [];
    const groups: number[] = [];
    const parts = text.split(":");
    for (const [i, part] of parts.entries()) {
      if (i === parts.length - 1 && part.includes(".")) { // dotted IPv4 in the last 32 bits
        const octets = part.split(".");
        if (octets.length !== 4 || !octets.every((o) => octet.test(o) && Number(o) <= 255)) return null;
        const [a, b, c, d] = octets.map(Number);
        groups.push(a * 256 + b, c * 256 + d);
      } else if (hextet.test(part)) {
        groups.push(parseInt(part, 16));
      } else {
        return null;
      }
    }
    return groups;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
}

/**
 * What one client is counted as: the IPv4 address, or for IPv6 the /64 prefix (one subscriber usually
 * owns a whole /64, so per-address limits could be sidestepped by rotating addresses). IPv4-mapped IPv6
 * is the IPv4 address. No address (local dev) shares the bucket "unknown"; anything unparseable is its
 * own raw text. Never throws.
 */
export function rateLimitBucket(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const groups = ipv6Groups(ip.split("%")[0]);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/**
 * Hex HMAC-SHA-256 of the client's bucket, keyed with the admin session secret (the message is
 * domain-separated from the session signatures). Keyed, because the IPv4 space can be hashed in minutes:
 * an unkeyed hash would make the stored rows addresses. The value is pseudonymous, still personal data.
 */
export async function clientKey(ip: string | null, secret: string): Promise<string> {
  return hmacHex(secret, `slot-booker-ratelimit-v1:${rateLimitBucket(ip)}`);
}

/** The /setup rate-limit key: keyed with the SETUP_CODE and domain-separated, so setup attempts and admin logins are counted apart. */
export async function setupClientKey(ip: string | null, setupCode: string): Promise<string> {
  return hmacHex(setupCode, `slot-booker-setup-ratelimit-v1:${rateLimitBucket(ip)}`);
}

/** The /recover rate-limit key: keyed with the stored recovery hash and domain-separated, so recovery attempts are counted apart from sign-in and setup. */
export async function recoveryClientKey(ip: string | null, recoveryHash: string): Promise<string> {
  return hmacHex(recoveryHash, `slot-booker-recover-ratelimit-v1:${rateLimitBucket(ip)}`);
}

/** The one key every /setup attempt is also counted under, whoever sent it: not derived from SETUP_CODE and holding no personal data. */
export const SETUP_GLOBAL_KEY = "slot-booker-setup-global-v1";
/** Attempts across all visitors per window: a cap on guessing by an attacker who rotates addresses (the per-visitor limit is 5). */
export const SETUP_GLOBAL_LIMIT = { max: 30, windowSeconds: 15 * 60 };

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, utf8(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Counts one login attempt and says whether it may go on to the password check. The count happens
 * first, in one upsert, so parallel guesses cannot slip past the limit. A new window starts when an attempt
 * arrives `windowSeconds` (900 unless given) or more after the window began; `max` defaults to 5. The same batch runs PURGE_SQL.
 */
export async function countAttempt(
  db: D1Database, key: string, nowSeconds: number, { max = MAX_ATTEMPTS, windowSeconds = WINDOW_SECONDS } = {},
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const [, upsert] = await db.batch([
    db.prepare(PURGE_SQL).bind(nowSeconds - KEEP_SECONDS - WINDOW_SECONDS),
    // Every right-hand side sees the row as it was before this statement, so both CASEs test the old window.
    db.prepare(
      `INSERT INTO login_attempts (key, attempts, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT (key) DO UPDATE SET
         attempts = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE attempts + 1 END,
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END
       RETURNING attempts, window_start`,
    ).bind(key, nowSeconds, windowSeconds),
  ]);
  const row = upsert.results[0] as { attempts: number; window_start: number };
  if (row.attempts <= max) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, row.window_start + windowSeconds - nowSeconds) };
}

export async function clearAttempts(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}

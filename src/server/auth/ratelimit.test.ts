import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "../../test/db";
import { utf8 } from "./crypto";
import { clearAttempts, clientKey, countAttempt, PURGE_SQL, rateLimitBucket, recoveryClientKey, setupClientKey } from "./ratelimit";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

const T0 = 1_800_000_000;
const SECRET = "test-only-session-secret-0123456789-abcdef";
const keyOf = (ip: string | null) => clientKey(ip, SECRET);
const rows = async () => (await t.env.DB.prepare("SELECT * FROM login_attempts ORDER BY key").all<{ key: string; attempts: number; window_start: number }>()).results;

describe("rateLimitBucket", () => {
  it.each([
    [null, "unknown"],
    ["", "unknown"],
    ["203.0.113.9", "203.0.113.9"],
    // IPv6: the first four hextets (the /64), lower-case, without leading zeros.
    ["2001:0db8:0000:0042:0000:0000:0000:0001", "2001:db8:0:42::/64"],
    ["2001:db8:0:42::1", "2001:db8:0:42::/64"],
    ["2001:DB8:0:42:AAAA:BBBB:CCCC:DDDD", "2001:db8:0:42::/64"],
    ["2001:db8:0:42:aaaa:bbbb:cccc:dddd", "2001:db8:0:42::/64"],
    // "::" at the start, in the middle and at the end
    ["::1", "0:0:0:0::/64"],
    ["::", "0:0:0:0::/64"],
    ["::5:6:7:8", "0:0:0:0::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["2001:db8:1:2:3::", "2001:db8:1:2::/64"],
    ["2001:db8:1::", "2001:db8:1:0::/64"],
    ["1:2:3:4:5:6:7::", "1:2:3:4::/64"],
    ["::2:3:4:5:6:7:8", "0:2:3:4::/64"],
    // zone ids are dropped
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["fe80::1%25eth0", "fe80:0:0:0::/64"],
    // IPv4-mapped addresses are the IPv4 address
    ["::ffff:203.0.113.9", "203.0.113.9"],
    ["::FFFF:203.0.113.9", "203.0.113.9"],
    ["0:0:0:0:0:ffff:203.0.113.9", "203.0.113.9"],
    ["::ffff:cb00:7109", "203.0.113.9"],
    ["::ffff:010.0.0.1", "10.0.0.1"],
    // not IPv4-mapped: another prefix, or a mapped-looking address with something in the first 80 bits
    ["::fffe:203.0.113.9", "0:0:0:0::/64"],
    ["1::ffff:203.0.113.9", "1:0:0:0::/64"],
    // garbage comes back as it was, and never throws
    ["not an address", "not an address"],
    ["2001:db8::1::2", "2001:db8::1::2"],
    ["2001:db8:0:42:0:0:0:0:1", "2001:db8:0:42:0:0:0:0:1"],
    ["1:2:3:4:5:6:7:8::", "1:2:3:4:5:6:7:8::"],
    ["12345::1", "12345::1"],
    ["g::1", "g::1"],
    ["::ffff:256.0.0.1", "::ffff:256.0.0.1"],
    ["::ffff:1.2.3", "::ffff:1.2.3"],
    [":", ":"],
    [":::", ":::"],
    [" ", " "],
    ["%eth0", "%eth0"],
  ])("%j -> %j", (ip, bucket) => {
    expect(rateLimitBucket(ip)).toBe(bucket);
  });

  it("puts two addresses in one /64 in one bucket, and different /64s in different buckets", () => {
    expect(rateLimitBucket("2001:db8:0:42::1")).toBe(rateLimitBucket("2001:db8:0:42:ffff:ffff:ffff:ffff"));
    expect(rateLimitBucket("2001:db8:0:42::1")).not.toBe(rateLimitBucket("2001:db8:0:43::1"));
    expect(rateLimitBucket("2001:db8:0:42::1")).not.toBe(rateLimitBucket("2001:db9:0:42::1"));
  });
});

describe("clientKey", () => {
  it("is 64 hex characters, the same for the same bucket and secret", async () => {
    expect(await keyOf("203.0.113.9")).toMatch(/^[0-9a-f]{64}$/);
    expect(await keyOf("203.0.113.9")).toBe(await keyOf("203.0.113.9"));
    expect(await keyOf("203.0.113.9")).not.toBe(await keyOf("203.0.113.10"));
    expect(await keyOf(null)).toBe(await keyOf(null));
    expect(await keyOf("203.0.113.9")).not.toBe("203.0.113.9");
  });

  it("is keyed with the secret: another secret gives another key", async () => {
    expect(await clientKey("203.0.113.9", SECRET)).not.toBe(await clientKey("203.0.113.9", `${SECRET}x`));
  });

  it("is HMAC-SHA-256 under the secret of a domain-separated bucket, so it cannot be recomputed from the address", async () => {
    const hmac = await crypto.subtle.importKey("raw", utf8(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = [...new Uint8Array(await crypto.subtle.sign("HMAC", hmac, utf8("slot-booker-ratelimit-v1:203.0.113.9")))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await keyOf("203.0.113.9")).toBe(expected);
  });

  it("is one key for every address of an IPv6 /64, and one per address for IPv4", async () => {
    expect(await keyOf("2001:db8:0:42::1")).toBe(await keyOf("2001:db8:0:42:dead:beef:0:1"));
    expect(await keyOf("2001:db8:0:42::1")).not.toBe(await keyOf("2001:db8:0:43::1"));
    expect(await keyOf("::ffff:203.0.113.9")).toBe(await keyOf("203.0.113.9"));
  });
});

describe("countAttempt", () => {
  it("allows five attempts per window, then refuses with the seconds left", async () => {
    const key = await keyOf("198.51.100.1");
    for (let i = 1; i <= 5; i++) expect((await countAttempt(t.env.DB, key, T0 + i)).allowed, `attempt ${i}`).toBe(true);
    const sixth = await countAttempt(t.env.DB, key, T0 + 100);
    expect(sixth).toEqual({ allowed: false, retryAfterSeconds: 900 - 99 });
    expect((await countAttempt(t.env.DB, key, T0 + 899)).allowed).toBe(false);
  });

  it("starts a new window exactly 900 s after the first attempt of the old one", async () => {
    const key = await keyOf("198.51.100.2");
    for (let i = 0; i < 6; i++) await countAttempt(t.env.DB, key, T0);
    expect((await countAttempt(t.env.DB, key, T0 + 899)).allowed).toBe(false);
    expect((await countAttempt(t.env.DB, key, T0 + 900)).allowed).toBe(true);
    const row = (await rows()).find((r) => r.key === key)!;
    expect(row).toEqual({ key, attempts: 1, window_start: T0 + 900 });
  });

  it("counts per key", async () => {
    const a = await keyOf("198.51.100.3");
    const b = await keyOf("198.51.100.4");
    for (let i = 0; i < 6; i++) await countAttempt(t.env.DB, a, T0);
    expect((await countAttempt(t.env.DB, a, T0)).allowed).toBe(false);
    expect((await countAttempt(t.env.DB, b, T0)).allowed).toBe(true);
  });

  it("never lets parallel attempts exceed the limit", async () => {
    const key = await keyOf("198.51.100.5");
    const results = await Promise.all(Array.from({ length: 12 }, () => countAttempt(t.env.DB, key, T0)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("without options allows exactly 5 attempts per 900 seconds (the login limit)", async () => {
    const key = await keyOf("198.51.100.30");
    for (let i = 0; i < 5; i++) expect((await countAttempt(t.env.DB, key, T0)).allowed).toBe(true);
    expect(await countAttempt(t.env.DB, key, T0 + 10)).toEqual({ allowed: false, retryAfterSeconds: 890 });
    expect((await countAttempt(t.env.DB, key, T0 + 899)).allowed).toBe(false);
    expect((await countAttempt(t.env.DB, key, T0 + 900)).allowed).toBe(true);
  });

  it("takes its own max and window length when given", async () => {
    const key = await keyOf("198.51.100.31");
    const options = { max: 2, windowSeconds: 60 };
    expect((await countAttempt(t.env.DB, key, T0, options)).allowed).toBe(true);
    expect((await countAttempt(t.env.DB, key, T0, options)).allowed).toBe(true);
    expect(await countAttempt(t.env.DB, key, T0 + 10, options)).toEqual({ allowed: false, retryAfterSeconds: 50 });
    expect((await countAttempt(t.env.DB, key, T0 + 60, options)).allowed).toBe(true);
  });

  it("clearAttempts forgets a client", async () => {
    const key = await keyOf("198.51.100.6");
    for (let i = 0; i < 6; i++) await countAttempt(t.env.DB, key, T0);
    await clearAttempts(t.env.DB, key);
    expect((await rows()).some((r) => r.key === key)).toBe(false);
    expect((await countAttempt(t.env.DB, key, T0)).allowed).toBe(true);
  });

  it("purges rows whose window ended more than a day ago, and keeps the rest", async () => {
    const old = await keyOf("198.51.100.7");
    const recent = await keyOf("198.51.100.8");
    await countAttempt(t.env.DB, old, T0);
    await countAttempt(t.env.DB, recent, T0 + 86_400);
    await countAttempt(t.env.DB, await keyOf("198.51.100.9"), T0 + 86_400 + 900); // window of `old` ended exactly a day ago
    expect((await rows()).some((r) => r.key === old)).toBe(true);
    await countAttempt(t.env.DB, await keyOf("198.51.100.9"), T0 + 86_400 + 901);
    const keys = (await rows()).map((r) => r.key);
    expect(keys).not.toContain(old);
    expect(keys).toContain(recent);
  });

  it("stores only 64-hex keys, never the address or its bucket", async () => {
    for (const ip of ["192.0.2.77", "2001:db8:77:1::5"]) await countAttempt(t.env.DB, await keyOf(ip), T0);
    const stored = await rows();
    expect(stored.length).toBeGreaterThanOrEqual(2);
    for (const r of stored) expect(r.key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain("192.0.2.77");
    expect(JSON.stringify(stored)).not.toContain("2001");
    expect(JSON.stringify(stored)).not.toContain("db8");
    expect(stored.map((r) => r.key)).toContain(await keyOf("192.0.2.77"));
  });
});

describe("the purge of old rows", () => {
  const T = T0 + 10_000_000; // later than any other test's rows, which are then all purgeable
  const insertOld = async (n: number, prefix: string, windowStart: number) => {
    await t.env.DB.batch(Array.from({ length: n }, (_, i) =>
      t.env.DB.prepare("INSERT INTO login_attempts (key, attempts, window_start) VALUES (?, 1, ?)").bind(`${prefix}${i}`, windowStart)));
  };
  const count = async (prefix: string) =>
    (await t.env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE key LIKE ?").bind(`${prefix}%`).first<{ n: number }>())!.n;

  it("uses the window_start index instead of scanning the table", async () => {
    const plan = (await t.env.DB.prepare(`EXPLAIN QUERY PLAN ${PURGE_SQL}`).bind(0).all<{ detail: string }>()).results.map((r) => r.detail).join("\n");
    expect(plan).toMatch(/USING (COVERING )?INDEX login_attempts_window_start/);
    expect(plan).not.toMatch(/SCAN login_attempts/);
  });

  it("deletes only rows whose window ended more than a day ago", async () => {
    await insertOld(3, "gone-", T - 86_400 - 901);
    await insertOld(3, "kept-edge-", T - 86_400 - 900); // window ended exactly a day ago
    await insertOld(3, "kept-new-", T - 10);
    await countAttempt(t.env.DB, await keyOf("198.51.100.20"), T);
    expect([await count("gone-"), await count("kept-edge-"), await count("kept-new-")]).toEqual([0, 3, 3]);
  });

  it("removes at most 100 rows per attempt, so a backlog is cleared over several attempts", async () => {
    await insertOld(250, "backlog-", T - 3 * 86_400);
    const left: number[] = [];
    for (let i = 0; i < 4; i++) {
      await countAttempt(t.env.DB, await keyOf("198.51.100.21"), T);
      left.push(await count("backlog-"));
    }
    expect(left).toEqual([150, 50, 0, 0]);
  });
});

describe("setupClientKey", () => {
  it("is a hex HMAC-SHA-256 of the bucket under the setup code, a different keyspace from the login key, and stable per client", async () => {
    const setup = await setupClientKey("203.0.113.9", SECRET);
    expect(setup).toMatch(/^[0-9a-f]{64}$/);
    expect(await setupClientKey("203.0.113.9", SECRET)).toBe(setup);
    expect(setup).not.toBe(await keyOf("203.0.113.9"));
    expect(await setupClientKey("203.0.113.10", SECRET)).not.toBe(setup);
    expect(await setupClientKey("203.0.113.9", `${SECRET}x`)).not.toBe(setup);
    expect(await setupClientKey("2001:db8:0:42::1", SECRET)).toBe(await setupClientKey("2001:db8:0:42:aaaa::2", SECRET));
  });

  it("leaves the login key as it was", async () => {
    const key = await crypto.subtle.importKey("raw", utf8(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, utf8("slot-booker-ratelimit-v1:203.0.113.9"));
    expect(await keyOf("203.0.113.9")).toBe([...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  });
});

describe("recoveryClientKey", () => {
  const HASH = "hmac-sha256$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  it("is a hex HMAC-SHA-256 of the bucket under the stored recovery hash, apart from the login and setup keys, and stable per client", async () => {
    const recovery = await recoveryClientKey("203.0.113.9", HASH);
    expect(recovery).toMatch(/^[0-9a-f]{64}$/);
    expect(await recoveryClientKey("203.0.113.9", HASH)).toBe(recovery);
    expect(recovery).not.toBe(await keyOf("203.0.113.9"));
    expect(recovery).not.toBe(await setupClientKey("203.0.113.9", HASH));
    expect(recovery).not.toBe(await clientKey("203.0.113.9", HASH));
    expect(await recoveryClientKey("203.0.113.9", SECRET)).not.toBe(recovery); // keyed with the hash
    expect(await recoveryClientKey("203.0.113.9", `${HASH}x`)).not.toBe(recovery);
    expect(await recoveryClientKey("203.0.113.10", HASH)).not.toBe(recovery);
    expect(await recoveryClientKey("2001:db8:0:42::1", HASH)).toBe(await recoveryClientKey("2001:db8:0:42:aaaa::2", HASH));
  });

  it("is HMAC(recovery hash, 'slot-booker-recover-ratelimit-v1:<bucket>')", async () => {
    const key = await crypto.subtle.importKey("raw", utf8(HASH), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, utf8("slot-booker-recover-ratelimit-v1:203.0.113.9"));
    expect(await recoveryClientKey("203.0.113.9", HASH)).toBe([...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  });
});

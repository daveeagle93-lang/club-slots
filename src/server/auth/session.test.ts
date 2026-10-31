import { describe, expect, it } from "vitest";
import { base64urlEncode, utf8 } from "./crypto";
import {
  clearedSessionCookie, issueSession, readSession, sessionCookie, SESSION_COOKIE,
} from "./session";

const SECRET = "x".repeat(40);
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const SEC = NOW / 1000;

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(`slot-booker-session-v1.${payload}`))));
}
const encode = (o: unknown) => base64urlEncode(utf8(JSON.stringify(o)));
/** A correctly signed cookie value for arbitrary claims, to test the claim checks alone. */
async function signed(claims: unknown, secret = SECRET): Promise<string> {
  const payload = encode(claims);
  return `v1.${payload}.${await sign(secret, payload)}`;
}
const header = (value: string) => `${SESSION_COOKIE}=${value}`;
const SID = "A".repeat(22);

describe("session cookie", () => {
  it("issues a cookie that reads back as the same session id", async () => {
    const { value, sid } = await issueSession(SECRET, NOW);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await readSession(SECRET, header(value), NOW + 1000)).toBe(sid);
    expect((await issueSession(SECRET, NOW)).sid).not.toBe(sid);
  });

  it("is HttpOnly, Secure, SameSite=Strict, host-only, 8 hours", () => {
    expect(sessionCookie("v")).toBe(`${SESSION_COOKIE}=v; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
    expect(clearedSessionCookie()).toBe(`${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    expect(SESSION_COOKIE).toBe("__Host-sb_admin");
  });

  it("finds the cookie among others and ignores lookalikes", async () => {
    const { value, sid } = await issueSession(SECRET, NOW);
    expect(await readSession(SECRET, `a=1; ${header(value)}; b=2`, NOW)).toBe(sid);
    expect(await readSession(SECRET, `x${header(value)}`, NOW)).toBeNull();
    expect(await readSession(SECRET, `sb_admin=${value}`, NOW)).toBeNull();
    expect(await readSession(SECRET, null, NOW)).toBeNull();
    expect(await readSession(SECRET, "", NOW)).toBeNull();
  });

  it("accepts the request if any one of several same-named cookies verifies, in either order", async () => {
    const { value, sid } = await issueSession(SECRET, NOW);
    const forged = await signed({ sid: SID, iat: SEC, exp: SEC + 3600 }, "y".repeat(40));
    for (const junk of ["junk", "", "v1.a.b", "v1..", forged]) {
      expect(await readSession(SECRET, `${header(junk)}; ${header(value)}`, NOW), `junk first: ${junk}`).toBe(sid);
      expect(await readSession(SECRET, `${header(value)}; ${header(junk)}`, NOW), `junk last: ${junk}`).toBe(sid);
    }
    expect(await readSession(SECRET, `${header("junk")}; a=1; ${header("v1.x.y")}; ${header(value)}; b=2`, NOW)).toBe(sid);
    expect(await readSession(SECRET, `${header("junk")}; ${header(forged)}`, NOW)).toBeNull(); // none verifies
  });

  it("accepts correctly signed claims (control for the rejections below)", async () => {
    expect(await readSession(SECRET, header(await signed({ sid: SID, iat: SEC, exp: SEC + 3600 })), NOW)).toBe(SID);
  });

  it("rejects a tampered payload that keeps the old signature", async () => {
    const { value } = await issueSession(SECRET, NOW);
    const [v, payload, sig] = value.split(".");
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    for (const change of [{ exp: claims.exp + 86400 }, { sid: "B".repeat(22) }]) {
      const forged = `${v}.${encode({ ...claims, ...change })}.${sig}`;
      expect(await readSession(SECRET, header(forged), NOW)).toBeNull();
    }
  });

  it("rejects bad signatures, versions and secrets", async () => {
    const { value } = await issueSession(SECRET, NOW);
    const [v, payload, sig] = value.split(".");
    const bad = [
      `${v}.${payload}.${sig.slice(0, -2)}`, `${v}.${payload}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`, `${v}.${payload}.`, `${v}.${payload}`,
      `v2.${payload}.${sig}`, `${payload}.${sig}`, `${v}.${payload}.${sig}.extra`, "garbage", "...", `${v}.${payload}.!!!`,
      await signed({ sid: SID, iat: SEC, exp: SEC + 3600 }, "y".repeat(40)),
    ];
    for (const b of bad) expect(await readSession(SECRET, header(b), NOW), b).toBeNull();
  });

  it("rejects an oversized cookie header", async () => {
    const { value } = await issueSession(SECRET, NOW);
    expect(await readSession(SECRET, `${"a=b; ".repeat(2000)}${header(value)}`, NOW)).toBeNull();
  });

  it("checks the claims after the signature", async () => {
    const check = async (claims: unknown, now = NOW) => readSession(SECRET, header(await signed(claims)), now);
    expect(await check({ sid: SID, iat: SEC - 100, exp: SEC })).toBeNull(); // exp exactly now
    expect(await check({ sid: SID, iat: SEC - 100, exp: SEC - 1 })).toBeNull();
    expect(await check({ sid: SID, iat: SEC, exp: SEC + 86401 })).toBeNull(); // lifetime over 24 h
    expect(await check({ sid: SID, iat: SEC, exp: SEC + 86400 })).toBe(SID);
    expect(await check({ sid: SID, iat: SEC + 61, exp: SEC + 3600 })).toBeNull(); // issued in the future
    expect(await check({ sid: SID, iat: SEC + 60, exp: SEC + 3600 })).toBe(SID);
    expect(await check({ sid: SID, iat: SEC, exp: SEC })).toBeNull();
    expect(await check({ sid: SID, iat: SEC, exp: SEC + 3600 }, NOW + 3600_000)).toBeNull();
    for (const claims of [
      { iat: SEC, exp: SEC + 60 }, { sid: 5, iat: SEC, exp: SEC + 60 }, { sid: "short", iat: SEC, exp: SEC + 60 },
      { sid: SID, iat: "1", exp: SEC + 60 }, { sid: SID, iat: SEC, exp: 1.5 + SEC }, { sid: SID, iat: SEC, exp: SEC + 60, extra: 1 },
      [], null, "x", 5,
    ]) {
      expect(await check(claims), JSON.stringify(claims)).toBeNull();
    }
  });

  it("rejects a signed payload that is not JSON", async () => {
    const payload = base64urlEncode(utf8("not json"));
    expect(await readSession(SECRET, header(`v1.${payload}.${await sign(SECRET, payload)}`), NOW)).toBeNull();
  });
});

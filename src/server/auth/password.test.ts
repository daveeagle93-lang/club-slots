import { beforeAll, describe, expect, it } from "vitest";
import { generateAdminSecret, hashAdminSecret, parseAdminSecretHash } from "./crypto";
import { createPasswordAuth, parsePasswordConfig } from "./password";
import { SESSION_COOKIE } from "./session";

const SECRET = "s".repeat(40);
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const ADMIN_SECRET = generateAdminSecret();
let stored: string;
let hash: NonNullable<ReturnType<typeof parseAdminSecretHash>>;
beforeAll(async () => {
  stored = await hashAdminSecret(ADMIN_SECRET);
  hash = parseAdminSecretHash(stored)!;
});

const cookieOf = (setCookie: string) => setCookie.split(";")[0];
const requestWith = (cookie?: string) => new Request("https://club.example/api/admin/session", { headers: cookie ? { Cookie: cookie } : {} });

describe("password provider", () => {
  it("checks the admin secret", async () => {
    const auth = createPasswordAuth({ hash, sessionSecret: SECRET }, { now: () => NOW });
    expect(auth.kind).toBe("password");
    expect(await auth.checkPassword(ADMIN_SECRET)).toBe(true);
    expect(await auth.checkPassword(generateAdminSecret())).toBe(false);
    expect(await auth.checkPassword("a long enough password")).toBe(false);
  });

  it("starts a session whose cookie authenticates as admin, bound to its session id", async () => {
    const auth = createPasswordAuth({ hash, sessionSecret: SECRET }, { now: () => NOW });
    const { session, setCookie } = await auth.startSession();
    expect(session.identity).toBe("admin");
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.[\\w-]+\\.[\\w-]+; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800$`));
    expect(await auth.authenticate(requestWith(cookieOf(setCookie)))).toEqual(session);
    expect(session.csrfBinding).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("does not authenticate without a cookie, with a garbage cookie, an expired one, or one signed by another secret", async () => {
    const auth = createPasswordAuth({ hash, sessionSecret: SECRET }, { now: () => NOW });
    const { setCookie } = await auth.startSession();
    expect(await auth.authenticate(requestWith())).toBeNull();
    expect(await auth.authenticate(requestWith(`${SESSION_COOKIE}=junk`))).toBeNull();
    const later = createPasswordAuth({ hash, sessionSecret: SECRET }, { now: () => NOW + 8 * 3600_000 });
    expect(await later.authenticate(requestWith(cookieOf(setCookie)))).toBeNull();
    const elsewhere = createPasswordAuth({ hash, sessionSecret: "t".repeat(40) }, { now: () => NOW });
    expect(await elsewhere.authenticate(requestWith(cookieOf(setCookie)))).toBeNull();
  });

  it("clears the cookie with Max-Age=0", () => {
    const auth = createPasswordAuth({ hash, sessionSecret: SECRET });
    expect(auth.clearCookie()).toBe(`${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  });
});

describe("parsePasswordConfig", () => {
  const session = "s".repeat(32);

  it("accepts a generated-secret hash with a long enough session secret", () => {
    const config = parsePasswordConfig({ ADMIN_PASSWORD_HASH: stored, ADMIN_SESSION_SECRET: session });
    expect(config).toEqual({ hash, sessionSecret: session });
  });

  it("refuses the old pbkdf2 format, wrong lengths and junk, telling the operator how to fix it", () => {
    const [prefix, salt, mac] = stored.split("$");
    for (const bad of [
      undefined, "", "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      `${prefix}$${salt.slice(1)}$${mac}`, `${prefix}$${salt}$${mac.slice(1)}`, `${prefix}$${salt}$${mac}$x`, "hmac-sha256$a$b",
    ]) {
      const result = parsePasswordConfig({ ADMIN_PASSWORD_HASH: bad, ADMIN_SESSION_SECRET: session });
      expect(typeof result, String(bad)).toBe("string");
      expect(result as string, String(bad)).toContain("npm run generate-admin-secret");
      expect(result as string).not.toContain(salt);
    }
  });

  it("still requires a session secret of at least 32 characters", () => {
    expect(typeof parsePasswordConfig({ ADMIN_PASSWORD_HASH: stored, ADMIN_SESSION_SECRET: "s".repeat(31) })).toBe("string");
    expect(typeof parsePasswordConfig({ ADMIN_PASSWORD_HASH: stored })).toBe("string");
  });
});

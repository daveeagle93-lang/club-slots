import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, interceptBatches, type TestEnv } from "../../test/db";
import { CLAIM_WINDOW_MS, envAuthSetting, loadAuthState, NO_SETTINGS, pinAccess, windowOpen } from "./settings";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });
beforeEach(async () => {
  await t.env.DB.prepare("DELETE FROM auth_settings").run();
  await t.env.DB.prepare("INSERT INTO auth_settings (id, setup_opened_at) VALUES (1, '2026-10-22T10:00:00.000Z')").run();
  await t.env.DB.prepare("DELETE FROM admin_credentials").run();
});

const SESSION = "s".repeat(43);
const OPENED = Date.UTC(2026, 9, 22, 10, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe("windowOpen", () => {
  it("is open from the start up to, but not including, 30 minutes", () => {
    expect(CLAIM_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(windowOpen(iso(OPENED), OPENED)).toBe(true);
    expect(windowOpen(iso(OPENED), OPENED + CLAIM_WINDOW_MS - 1)).toBe(true);
    expect(windowOpen(iso(OPENED), OPENED + CLAIM_WINDOW_MS)).toBe(false);
  });

  it("is closed for no value or one that is not a date", () => {
    expect(windowOpen(null, OPENED)).toBe(false);
    expect(windowOpen("not a date", OPENED)).toBe(false);
  });

  it("allows 60 seconds of clock skew, no more", () => {
    expect(windowOpen(iso(OPENED + 60_000), OPENED)).toBe(true);
    expect(windowOpen(iso(OPENED + 61_000), OPENED)).toBe(false);
  });
});

describe("loadAuthState", () => {
  it("reads the settings row and the credentials row", async () => {
    await t.env.DB.prepare("INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at) VALUES (1, 'hmac-sha256$salt$mac', ?, '2026-10-22T10:01:00.000Z')").bind(SESSION).run();
    const { settings, credentials } = await loadAuthState(t.env.DB);
    expect(settings).toEqual({ ...NO_SETTINGS, setupOpenedAt: "2026-10-22T10:00:00.000Z" });
    expect(credentials).toEqual({ secretHash: "hmac-sha256$salt$mac", sessionSecret: SESSION, firstLoginAt: null });
  });

  it("gives NO_SETTINGS and no credentials when the rows are gone", async () => {
    await t.env.DB.prepare("DELETE FROM auth_settings").run();
    expect(await loadAuthState(t.env.DB)).toEqual({ settings: NO_SETTINGS, credentials: null });
  });

  it("is a single batch", async () => {
    const batches: string[][] = [];
    const db = interceptBatches(t.env.DB, async (sqls, run) => { batches.push(sqls); return run(); });
    await loadAuthState(db);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });
});

describe("pinAccess", () => {
  const v = { teamDomain: "club.cloudflareaccess.com", aud: "aud-1", hostname: "club.example" };
  const row = () => t.env.DB.prepare("SELECT mode, access_team_domain, access_aud, access_hostname, changed_at, changed_by FROM auth_settings WHERE id = 1").first();

  it("writes the values once, and does nothing for identical ones", async () => {
    expect(await pinAccess(t.env.DB, v, "2026-10-22T11:00:00.000Z")).toBe(true);
    expect(await row()).toEqual({
      mode: "access", access_team_domain: v.teamDomain, access_aud: "aud-1", access_hostname: "club.example",
      changed_at: "2026-10-22T11:00:00.000Z", changed_by: "import",
    });
    expect(await pinAccess(t.env.DB, v, "2026-10-22T12:00:00.000Z")).toBe(false);
    expect(await row()).toMatchObject({ changed_at: "2026-10-22T11:00:00.000Z" });
  });

  it("writes again when a value differs", async () => {
    await pinAccess(t.env.DB, v, "2026-10-22T11:00:00.000Z");
    expect(await pinAccess(t.env.DB, { ...v, aud: "aud-2" }, "2026-10-22T12:00:00.000Z")).toBe(true);
    expect(await row()).toMatchObject({ access_aud: "aud-2", changed_at: "2026-10-22T12:00:00.000Z" });
  });

  it("changes nothing when the row is gone", async () => {
    await t.env.DB.prepare("DELETE FROM auth_settings").run();
    expect(await pinAccess(t.env.DB, v, "2026-10-22T11:00:00.000Z")).toBe(false);
  });
});

describe("envAuthSetting", () => {
  it("accepts only an exact access or password, or nothing", () => {
    expect(envAuthSetting({ ADMIN_AUTH: undefined })).toBe("password-or-unset");
    expect(envAuthSetting({ ADMIN_AUTH: "password" })).toBe("password-or-unset");
    expect(envAuthSetting({ ADMIN_AUTH: "access" })).toBe("access");
    for (const bad of ["", "Password", " access", "none"]) expect(envAuthSetting({ ADMIN_AUTH: bad }), bad).toBe("invalid");
  });
});

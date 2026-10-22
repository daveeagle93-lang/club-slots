import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./db";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

const HASH = `hmac-sha256$${"A".repeat(22)}$${"B".repeat(43)}`;
const ACCESS = { team: "team.cloudflareaccess.com", aud: "a".repeat(64), host: "book.example.com" };
const update = (set: string, ...values: unknown[]) => t.env.DB.prepare(`UPDATE auth_settings SET ${set} WHERE id = 1`).bind(...values).run();
const reset = () => t.env.DB.prepare(
  "UPDATE auth_settings SET mode = 'password', access_team_domain = NULL, access_aud = NULL, access_hostname = NULL, changed_by = NULL, recovery_hash = NULL WHERE id = 1",
).run();

describe("0019 auth_settings", () => {
  it("seeds one row: mode password, every optional column null, setup_opened_at an ISO time near now", async () => {
    const { results } = await t.env.DB.prepare("SELECT * FROM auth_settings").all<Record<string, unknown>>();
    expect(results).toHaveLength(1);
    const row = results[0]!;
    expect(row).toMatchObject({
      id: 1,
      mode: "password",
      access_team_domain: null,
      access_aud: null,
      access_hostname: null,
      changed_at: null,
      changed_by: null,
      claim_token_hash: null,
      recovery_hash: null,
      recovery_created_at: null,
    });
    // The template database is migrated once per run and copied, so the seed can be minutes old by the time this runs.
    const opened = row.setup_opened_at as string;
    expect(opened).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const age = Date.now() - Date.parse(opened);
    expect(Number.isFinite(age)).toBe(true);
    expect(age).toBeGreaterThan(-60_000);
    expect(age).toBeLessThan(60 * 60_000);
  });

  it("refuses id 2, mode 'both' and changed_by 'someone'", async () => {
    await expect(
      t.env.DB.prepare("INSERT INTO auth_settings (id, setup_opened_at) VALUES (2, '2026-10-22T10:00:00.000Z')").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(update("mode = ?", "both")).rejects.toThrow(/CHECK constraint failed/);
    await expect(update("changed_by = ?", "someone")).rejects.toThrow(/CHECK constraint failed/);
  });

  it("refuses mode 'access' unless team domain, aud and hostname are all set, and accepts it when they are", async () => {
    await reset();
    await expect(update("mode = 'access'")).rejects.toThrow(/CHECK constraint failed/);
    await expect(update("mode = 'access', access_team_domain = ?, access_aud = ?", ACCESS.team, ACCESS.aud)).rejects.toThrow(/CHECK constraint failed/);
    await expect(update("mode = 'access', access_team_domain = ?, access_hostname = ?", ACCESS.team, ACCESS.host)).rejects.toThrow(/CHECK constraint failed/);
    await expect(update("mode = 'access', access_aud = ?, access_hostname = ?", ACCESS.aud, ACCESS.host)).rejects.toThrow(/CHECK constraint failed/);
    await update("mode = 'access', access_team_domain = ?, access_aud = ?, access_hostname = ?", ACCESS.team, ACCESS.aud, ACCESS.host);
    const row = await t.env.DB.prepare("SELECT mode FROM auth_settings").first();
    expect(row).toEqual({ mode: "access" });
    await reset();
  });

  it("refuses a recovery_hash without the hmac-sha256$ prefix and accepts null", async () => {
    await reset();
    for (const hash of ["pbkdf2-sha256$100000$x$y", "", "hmac-sha256", "plain-secret"]) {
      await expect(update("recovery_hash = ?", hash), hash).rejects.toThrow(/CHECK constraint failed/);
    }
    await update("recovery_hash = ?", HASH);
    await update("recovery_hash = NULL");
    const row = await t.env.DB.prepare("SELECT recovery_hash FROM auth_settings").first();
    expect(row).toEqual({ recovery_hash: null });
  });
});

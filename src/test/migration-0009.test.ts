import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./db";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

const SHA = "a".repeat(64);
const logo = (over: Record<string, unknown> = {}) => {
  const v = { id: 1, contentType: "image/png", bytes: Uint8Array.of(1, 2, 3), width: 10, height: 10, sha256: SHA, ...over };
  return t.env.DB.prepare("INSERT INTO site_logo (id, content_type, bytes, width, height, sha256) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(v.id, v.contentType, v.bytes, v.width, v.height, v.sha256).run();
};
const setting = (column: string, value: unknown) => t.env.DB.prepare(`UPDATE site_settings SET ${column} = ?`).bind(value).run();

describe("0009 site_settings", () => {
  it("starts with the one row, text empty and the theme unset", async () => {
    const { results } = await t.env.DB.prepare("SELECT * FROM site_settings").all();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 1, club_name: "", privacy_contact_name: "", privacy_contact_email: "", website_url: "", theme_primary: null, theme_accent: null,
    });
    expect(results[0].updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("allows only the singleton row", async () => {
    await expect(t.env.DB.prepare("INSERT INTO site_settings (id) VALUES (2)").run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(t.env.DB.prepare("INSERT INTO site_settings (id) VALUES (1)").run()).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("refuses NULL text", async () => {
    for (const column of ["club_name", "privacy_contact_name", "privacy_contact_email", "website_url", "updated_at"]) {
      await expect(setting(column, null), column).rejects.toThrow(/NOT NULL constraint failed/);
    }
  });

  it.each([
    ["club_name", 320], ["privacy_contact_name", 400], ["privacy_contact_email", 254], ["website_url", 300],
  ])("%s holds at most %i characters", async (column, max) => {
    // 'https://' first, so the website column is tested on its length alone.
    const text = (n: number) => (column === "website_url" ? "https://" + "x".repeat(n - 8) : "x".repeat(n));
    await setting(column, text(max));
    await expect(setting(column, text(max + 1))).rejects.toThrow(/CHECK constraint failed/);
    // Characters, not bytes: 3-byte and 4-byte characters at the limit are fine.
    if (column !== "website_url") {
      await setting(column, "€".repeat(max));
      await setting(column, "😀".repeat(max));
    }
    await setting(column, "");
  });

  it("website_url is empty or starts with lower-case https://", async () => {
    for (const ok of ["", "https://example.org/", "https://x"]) await setting("website_url", ok);
    for (const bad of ["http://example.org", "HTTPS://example.org", "javascript:alert(1)", "//example.org", "example.org", " https://example.org", "ftp://x", "https:/x", "data:text/html,x"]) {
      await expect(setting("website_url", bad), bad).rejects.toThrow(/CHECK constraint failed/);
    }
    await setting("website_url", "");
  });

  it.each(["theme_primary", "theme_accent"])("%s accepts NULL and lower-case #rrggbb only", async (column) => {
    for (const ok of ["#0a1b2c", "#000000", "#ffffff", null]) await setting(column, ok);
    for (const bad of ["#0A1B2C", "#fff", "#0a1b2", "#0a1b2c0", "0a1b2c", "#0a1b2g", "red", "", " #0a1b2c", "#0a1b2c ", "#0a1b2c\n", "rgb(1,2,3)", "#0a1b2cff"]) {
      await expect(setting(column, bad), JSON.stringify(bad)).rejects.toThrow(/CHECK constraint failed/);
    }
    await setting(column, null);
  });

  it("refuses an updated_at that isn't the fixed timestamp shape", async () => {
    await expect(setting("updated_at", "2026-10-05 12:00")).rejects.toThrow(/CHECK constraint failed/);
    await expect(setting("updated_at", "2026-10-05T12:00:00Zx")).rejects.toThrow(/CHECK constraint failed/);
    await setting("updated_at", "2026-10-05T12:00:00Z");
  });
});

describe("0009 site_logo", () => {
  it("starts empty: no row means no logo", async () => {
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM site_logo").first<{ n: number }>())!.n).toBe(0);
  });

  it("allows only the singleton row", async () => {
    await expect(logo({ id: 2 })).rejects.toThrow(/CHECK constraint failed/);
    await logo();
    await expect(logo()).rejects.toThrow(/UNIQUE constraint failed/);
    await t.env.DB.prepare("DELETE FROM site_logo").run();
  });

  it("allows only png, jpeg and webp, as exact lower-case values", async () => {
    for (const contentType of ["image/png", "image/jpeg", "image/webp"]) {
      await logo({ contentType });
      await t.env.DB.prepare("DELETE FROM site_logo").run();
    }
    for (const contentType of ["image/svg+xml", "image/gif", "text/html", "IMAGE/PNG", "image/png ", "", "image/x-icon", "application/pdf"]) {
      await expect(logo({ contentType }), contentType).rejects.toThrow(/CHECK constraint failed/);
    }
    await expect(logo({ contentType: null })).rejects.toThrow(/NOT NULL constraint failed/);
  });

  it("holds 1 to 204800 bytes of BLOB, and nothing else", async () => {
    await logo({ bytes: new Uint8Array(204_800) });
    await t.env.DB.prepare("DELETE FROM site_logo").run();
    await logo({ bytes: new Uint8Array(1) });
    await t.env.DB.prepare("DELETE FROM site_logo").run();
    await expect(logo({ bytes: new Uint8Array(0) })).rejects.toThrow(/CHECK constraint failed/);
    await expect(logo({ bytes: new Uint8Array(204_801) })).rejects.toThrow(/CHECK constraint failed/);
    await expect(logo({ bytes: "text, not a blob" })).rejects.toThrow(/CHECK constraint failed/);
    await expect(logo({ bytes: null })).rejects.toThrow(/NOT NULL constraint failed/);
  });

  it("holds sizes of 1 to 512 on each side", async () => {
    for (const [width, height] of [[1, 1], [512, 512], [1, 512]]) {
      await logo({ width, height });
      await t.env.DB.prepare("DELETE FROM site_logo").run();
    }
    for (const [width, height] of [[0, 10], [10, 0], [513, 10], [10, 513], [-1, 10], [20000, 20000]]) {
      await expect(logo({ width, height }), `${width}x${height}`).rejects.toThrow(/CHECK constraint failed/);
    }
    await expect(logo({ width: null })).rejects.toThrow(/NOT NULL constraint failed/);
  });

  it("holds the digest as 64 lower-case hex characters", async () => {
    for (const sha256 of ["A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(63)}g`, "", `${"a".repeat(63)}\n`]) {
      await expect(logo({ sha256 }), sha256).rejects.toThrow(/CHECK constraint failed/);
    }
    await logo({ sha256: "0123456789abcdef".repeat(4) });
    await t.env.DB.prepare("DELETE FROM site_logo").run();
    await expect(logo({ sha256: null })).rejects.toThrow(/NOT NULL constraint failed/);
  });

  it("fills in updated_at", async () => {
    await logo();
    const row = await t.env.DB.prepare("SELECT updated_at FROM site_logo").first<{ updated_at: string }>();
    expect(row!.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    await t.env.DB.prepare("DELETE FROM site_logo").run();
  });
});

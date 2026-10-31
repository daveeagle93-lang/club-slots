import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./db";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());
beforeEach(() => t.env.DB.prepare("DELETE FROM site_icons").run());

const SHA = "a".repeat(64);
const icon = (over: Record<string, unknown> = {}) => {
  const v = {
    size: 32, contentType: "image/png", bytes: Uint8Array.of(1, 2, 3), width: 32, height: 32, sha256: SHA, background: "#0b5cad", logoSha256: SHA, ...over,
  };
  return t.env.DB.prepare("INSERT INTO site_icons (size, content_type, bytes, width, height, sha256, background, logo_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(v.size, v.contentType, v.bytes, v.width, v.height, v.sha256, v.background, v.logoSha256).run();
};
const count = async () => (await t.env.DB.prepare("SELECT COUNT(*) AS n FROM site_icons").first<{ n: number }>())!.n;

describe("0011 site_icons", () => {
  it("starts empty: no rows means the default icons are served", async () => {
    expect(await count()).toBe(0);
  });

  it("holds one row for each of 32, 180 and 512, and no other size", async () => {
    for (const size of [32, 180, 512]) await icon({ size, width: size, height: size });
    expect(await count()).toBe(3);
    await expect(icon({ size: 32 })).rejects.toThrow(/UNIQUE constraint failed/);
    await t.env.DB.prepare("DELETE FROM site_icons").run();
    for (const size of [0, 16, 64, 192, 256, 511, 513, -32]) {
      await expect(icon({ size, width: size, height: size }), String(size)).rejects.toThrow(/CHECK constraint failed/);
    }
  });

  it("holds image/png only", async () => {
    for (const contentType of ["image/jpeg", "image/webp", "image/svg+xml", "IMAGE/PNG", "image/png ", "", "text/html"]) {
      await expect(icon({ contentType }), contentType).rejects.toThrow(/CHECK constraint failed/);
    }
    await expect(icon({ contentType: null })).rejects.toThrow(/NOT NULL constraint failed/);
  });

  it("holds 1 to 204800 bytes of BLOB, and nothing else", async () => {
    await icon({ bytes: new Uint8Array(204_800) });
    await t.env.DB.prepare("DELETE FROM site_icons").run();
    await icon({ bytes: new Uint8Array(1) });
    await expect(icon({ size: 180, width: 180, height: 180, bytes: new Uint8Array(0) })).rejects.toThrow(/CHECK constraint failed/);
    await expect(icon({ size: 180, width: 180, height: 180, bytes: new Uint8Array(204_801) })).rejects.toThrow(/CHECK constraint failed/);
    await expect(icon({ size: 180, width: 180, height: 180, bytes: "text, not a blob" })).rejects.toThrow(/CHECK constraint failed/);
    await expect(icon({ size: 180, width: 180, height: 180, bytes: null })).rejects.toThrow(/NOT NULL constraint failed/);
  });

  it("holds width and height equal to the size", async () => {
    for (const [size, width, height] of [[32, 33, 32], [32, 32, 31], [180, 32, 180], [512, 512, 0], [512, 513, 513]]) {
      await expect(icon({ size, width, height }), `${size}: ${width}x${height}`).rejects.toThrow(/CHECK constraint failed/);
    }
    await expect(icon({ width: null })).rejects.toThrow(/NOT NULL constraint failed/);
    expect(await count()).toBe(0);
  });

  it.each(["sha256", "logoSha256"])("holds %s as 64 lower-case hex characters", async (column) => {
    for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(63)}g`, "", `${"a".repeat(63)}\n`]) {
      await expect(icon({ [column]: bad }), bad).rejects.toThrow(/CHECK constraint failed/);
    }
    await expect(icon({ [column]: null })).rejects.toThrow(/NOT NULL constraint failed/);
    await icon({ [column]: "0123456789abcdef".repeat(4) });
  });

  it("holds the background as lower-case #rrggbb", async () => {
    for (const bad of ["#0B5CAD", "#fff", "#0b5ca", "#0b5cadd", "0b5cad", "#0b5cag", "red", "", " #0b5cad", "#0b5cad\n", "rgb(1,2,3)"]) {
      await expect(icon({ background: bad }), JSON.stringify(bad)).rejects.toThrow(/CHECK constraint failed/);
    }
    await expect(icon({ background: null })).rejects.toThrow(/NOT NULL constraint failed/);
    await icon({ background: "#000000" });
    expect(await count()).toBe(1);
  });

  it("fills in updated_at in the fixed timestamp shape, and refuses any other", async () => {
    await icon();
    const row = await t.env.DB.prepare("SELECT updated_at FROM site_icons").first<{ updated_at: string }>();
    expect(row!.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    await expect(t.env.DB.prepare("UPDATE site_icons SET updated_at = '2026-10-05 12:00'").run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(t.env.DB.prepare("UPDATE site_icons SET updated_at = '2026-10-05T12:00:00Zx'").run()).rejects.toThrow(/CHECK constraint failed/);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./db";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

const HASH = `hmac-sha256$${"A".repeat(22)}$${"B".repeat(43)}`;
const SESSION = "s".repeat(43);
const insert = (over: { id?: number; hash?: unknown; session?: unknown; createdAt?: unknown } = {}) =>
  t.env.DB.prepare("INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at) VALUES (?, ?, ?, ?)")
    .bind(over.id ?? 1, "hash" in over ? over.hash : HASH, "session" in over ? over.session : SESSION, "createdAt" in over ? over.createdAt : "2026-10-05T10:00:00.000Z").run();
const clear = () => t.env.DB.prepare("DELETE FROM admin_credentials").run();

describe("0013 admin_credentials", () => {
  it("holds one row, id 1, with first_login_at empty until the first sign-in", async () => {
    await clear();
    await insert();
    const row = await t.env.DB.prepare("SELECT id, secret_hash, session_secret, created_at, first_login_at FROM admin_credentials").first();
    expect(row).toEqual({ id: 1, secret_hash: HASH, session_secret: SESSION, created_at: "2026-10-05T10:00:00.000Z", first_login_at: null });
  });

  it("refuses a second row and any id other than 1", async () => {
    await clear();
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insert({ id: 2 })).rejects.toThrow(/CHECK constraint failed/);
    await clear();
    await expect(insert({ id: 0 })).rejects.toThrow(/CHECK constraint failed/);
  });

  it("refuses a secret_hash that is not the hmac-sha256$ form", async () => {
    await clear();
    for (const hash of ["pbkdf2-sha256$100000$x$y", "", "hmac-sha256", "plain-secret"]) {
      await expect(insert({ hash }), hash).rejects.toThrow(/CHECK constraint failed/);
    }
    await expect(insert({ hash: null })).rejects.toThrow(/NOT NULL constraint failed/);
  });

  it("refuses a session_secret under 32 characters, and NULLs", async () => {
    await clear();
    await expect(insert({ session: "s".repeat(31) })).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert({ session: null })).rejects.toThrow(/NOT NULL constraint failed/);
    await expect(insert({ createdAt: null })).rejects.toThrow(/NOT NULL constraint failed/);
    await insert({ session: "s".repeat(32) });
  });
});

import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./db";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

it("has the migrated schema", async () => {
  const row = await t.env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'events_slug'").first<{ n: number }>();
  expect(row?.n).toBe(1);
});

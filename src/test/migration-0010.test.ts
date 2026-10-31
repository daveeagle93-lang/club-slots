import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, insertEvent, type TestEnv } from "./db";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

const listedOf = (id: number) => t.env.DB.prepare("SELECT listed FROM events WHERE id = ?").bind(id).first<{ listed: number }>();
const setListed = (id: number, value: unknown) => t.env.DB.prepare("UPDATE events SET listed = ? WHERE id = ?").bind(value, id).run();

describe("0010 events.listed", () => {
  it("is NOT NULL with a default of 1, so events made without it (and every event from before) stay listed", async () => {
    const col = await t.env.DB.prepare("SELECT \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('events') WHERE name = 'listed'")
      .first<{ nn: number; d: string }>();
    expect(col).toEqual({ nn: 1, d: "1" });
    const { id } = await insertEvent(t.env.DB);
    expect(await listedOf(id)).toEqual({ listed: 1 });
  });

  it("holds 0 and 1, and refuses 2 and NULL", async () => {
    const { id } = await insertEvent(t.env.DB);
    await setListed(id, 0);
    expect(await listedOf(id)).toEqual({ listed: 0 });
    await setListed(id, 1);
    await expect(setListed(id, 2)).rejects.toThrow(/CHECK constraint failed/);
    await expect(setListed(id, null)).rejects.toThrow(/NOT NULL constraint failed/);
    expect(await listedOf(id)).toEqual({ listed: 1 });
  });
});

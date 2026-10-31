/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, insertEvent, type TestEnv } from "./db";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

const TEMPLATE = {
  name: "Saturday", is_default: 0, details: "", venue_postcode: "AB1 2CD", cost_pence: 1500, start_time: "09:00", end_time: "12:00",
  session_minutes: 15, gap_minutes: 0, share_message: "",
};
const insertTemplate = (over: Record<string, unknown> = {}) => {
  const row = { ...TEMPLATE, ...over };
  const columns = Object.keys(row);
  return t.env.DB.prepare(`INSERT INTO event_templates (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING id`)
    .bind(...Object.values(row)).first<{ id: number }>();
};
const insertTemplateBreak = (templateId: number, over: Record<string, unknown> = {}) => {
  const row = { template_id: templateId, start_time: "10:00", end_time: "10:30", label: "Lunch", ...over };
  const columns = Object.keys(row);
  return t.env.DB.prepare(`INSERT INTO event_template_breaks (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...Object.values(row)).run();
};
const clear = () => t.env.DB.prepare("DELETE FROM event_templates").run();
const CHECK = /CHECK constraint failed/;

describe("0014 event_templates", () => {
  it("fills in the defaults (not default, no details, cost 0, no gap, no share message) and UTC timestamps in the repo's form", async () => {
    await clear();
    await t.env.DB.prepare(
      "INSERT INTO event_templates (name, venue_postcode, start_time, end_time, session_minutes) VALUES ('Minimal', 'AB1 2CD', '09:00', '12:00', 15)",
    ).run();
    const row = await t.env.DB.prepare("SELECT * FROM event_templates").first();
    const stamp = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(row).toEqual({
      id: expect.any(Number), name: "Minimal", is_default: 0, details: "", venue_postcode: "AB1 2CD", cost_pence: 0, start_time: "09:00",
      end_time: "12:00", session_minutes: 15, gap_minutes: 0, share_message: "", created_at: stamp, updated_at: stamp,
    });
  });

  it("refuses a name that is empty, blank or over 60 characters, and accepts exactly 60", async () => {
    await clear();
    for (const name of ["", "   ", "x".repeat(61)]) await expect(insertTemplate({ name }), JSON.stringify(name)).rejects.toThrow(CHECK);
    await expect(insertTemplate({ name: null })).rejects.toThrow(/NOT NULL constraint failed/);
    await insertTemplate({ name: "x".repeat(60) });
  });

  it("makes the name unique ignoring case", async () => {
    await clear();
    await insertTemplate({ name: "Saturday" });
    await expect(insertTemplate({ name: "SATURDAY" })).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insertTemplate({ name: "saturday" })).rejects.toThrow(/UNIQUE constraint failed/);
    await insertTemplate({ name: "Sunday" });
  });

  it("allows at most one default, and only 0 or 1", async () => {
    await clear();
    await insertTemplate({ name: "A", is_default: 1 });
    await insertTemplate({ name: "B" });
    await insertTemplate({ name: "C" });
    await expect(insertTemplate({ name: "D", is_default: 1 })).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(t.env.DB.prepare("UPDATE event_templates SET is_default = 1 WHERE name = 'B'").run()).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insertTemplate({ name: "E", is_default: 2 })).rejects.toThrow(CHECK);
    await expect(insertTemplate({ name: "F", is_default: null })).rejects.toThrow(/NOT NULL constraint failed/);
  });

  it.each([
    ["details of 2001 characters", { details: "d".repeat(2001) }],
    ["share_message of 1001 characters", { share_message: "m".repeat(1001) }],
    ["a one-character postcode", { venue_postcode: "A" }],
    ["an eleven-character postcode", { venue_postcode: "A".repeat(11) }],
    ["a negative cost", { cost_pence: -1 }],
    ["a cost over 100000", { cost_pence: 100001 }],
    ["a session of 0 minutes", { session_minutes: 0 }],
    ["a session of 481 minutes", { session_minutes: 481 }],
    ["a negative gap", { gap_minutes: -1 }],
    ["a gap of 121 minutes", { gap_minutes: 121 }],
    ["a start of 24:00", { start_time: "24:00", end_time: "24:59" }],
    ["a start of 9:00", { start_time: "9:00" }],
    ["a start with seconds", { start_time: "09:00:00" }],
    ["a start of 09:60", { start_time: "09:60" }],
    ["an end of 25:00", { end_time: "25:00" }],
    ["an end equal to the start", { end_time: "09:00" }],
    ["an end before the start", { end_time: "08:00" }],
    ["a created_at in the wrong shape", { created_at: "2026-10-05 12:00" }],
    ["an updated_at in the wrong shape", { updated_at: "2026-10-05T12:00:00.000Z" }],
  ])("refuses %s", async (_n, over) => {
    await clear();
    await expect(insertTemplate(over)).rejects.toThrow(CHECK);
  });

  it.each([
    ["details of 2000", { details: "d".repeat(2000) }],
    ["share_message of 1000", { share_message: "m".repeat(1000) }],
    ["a cost of 0", { cost_pence: 0 }],
    ["a cost of 100000", { cost_pence: 100000 }],
    ["a session of 1 minute", { session_minutes: 1 }],
    ["a session of 480 minutes", { session_minutes: 480 }],
    ["a gap of 120 minutes", { gap_minutes: 120 }],
    ["times 00:00 to 23:59", { start_time: "00:00", end_time: "23:59" }],
  ])("accepts %s", async (_n, over) => {
    await clear();
    await insertTemplate(over);
  });
});

describe("0014 event_template_breaks", () => {
  it("stores breaks, labels up to 40 characters, and an empty label by default", async () => {
    await clear();
    const { id } = (await insertTemplate())!;
    await insertTemplateBreak(id, { label: "x".repeat(40) });
    await t.env.DB.prepare("INSERT INTO event_template_breaks (template_id, start_time, end_time) VALUES (?, '11:00', '11:10')").bind(id).run();
    const { results } = await t.env.DB.prepare("SELECT label FROM event_template_breaks WHERE template_id = ? ORDER BY start_time").bind(id).all();
    expect(results).toEqual([{ label: "x".repeat(40) }, { label: "" }]);
  });

  it("refuses a 41-character label, a NULL label, bad times and a break that ends before it starts", async () => {
    await clear();
    const { id } = (await insertTemplate())!;
    await expect(insertTemplateBreak(id, { label: "x".repeat(41) })).rejects.toThrow(CHECK);
    await expect(insertTemplateBreak(id, { label: null })).rejects.toThrow(/NOT NULL constraint failed/);
    await expect(insertTemplateBreak(id, { start_time: "10:5" })).rejects.toThrow(CHECK);
    await expect(insertTemplateBreak(id, { end_time: "24:00" })).rejects.toThrow(CHECK);
    await expect(insertTemplateBreak(id, { end_time: "10:00" })).rejects.toThrow(CHECK);
  });

  it("needs an existing template, and goes when its template goes", async () => {
    await clear();
    await expect(insertTemplateBreak(999_999)).rejects.toThrow(/FOREIGN KEY constraint failed/);
    const keep = (await insertTemplate({ name: "Keep" }))!;
    const drop = (await insertTemplate({ name: "Drop" }))!;
    await insertTemplateBreak(keep.id);
    await insertTemplateBreak(drop.id);
    await insertTemplateBreak(drop.id, { start_time: "11:00", end_time: "11:15" });
    await t.env.DB.prepare("DELETE FROM event_templates WHERE id = ?").bind(drop.id).run();
    const { results } = await t.env.DB.prepare("SELECT template_id FROM event_template_breaks").all();
    expect(results).toEqual([{ template_id: keep.id }]);
  });

  it("has an index on template_id", async () => {
    expect(await t.env.DB.prepare("SELECT name FROM pragma_index_list('event_template_breaks')").all()).toMatchObject({
      results: expect.arrayContaining([{ name: "event_template_breaks_template_id" }]),
    });
  });
});

describe("0014 events.share_message", () => {
  const shareOf = (id: number) => t.env.DB.prepare("SELECT share_message AS m FROM events WHERE id = ?").bind(id).first<{ m: string }>();
  const setShare = (id: number, value: unknown) => t.env.DB.prepare("UPDATE events SET share_message = ? WHERE id = ?").bind(value, id).run();

  it("is NOT NULL with a default of the empty string, so events made without it stay on the built-in wording", async () => {
    const col = await t.env.DB.prepare("SELECT \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('events') WHERE name = 'share_message'")
      .first<{ nn: number; d: string }>();
    expect(col).toEqual({ nn: 1, d: "''" });
    const { id } = await insertEvent(t.env.DB);
    expect(await shareOf(id)).toEqual({ m: "" });
  });

  it("holds up to 1000 characters, and refuses 1001 and NULL", async () => {
    const { id } = await insertEvent(t.env.DB);
    await setShare(id, "m".repeat(1000));
    await expect(setShare(id, "m".repeat(1001))).rejects.toThrow(CHECK);
    await expect(setShare(id, null)).rejects.toThrow(/NOT NULL constraint failed/);
    expect(await shareOf(id)).toEqual({ m: "m".repeat(1000) });
  });

  it("has no link to a template", async () => {
    const { results } = await t.env.DB.prepare("SELECT name FROM pragma_table_info('events') WHERE name LIKE '%template%'").all();
    expect(results).toEqual([]);
  });
});

describe("0014 on a database that already carries data from 0013", () => {
  const MIGRATIONS = join(import.meta.dirname, "../../migrations");
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "slot-booker-upgrade-")); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const wrangler = (...args: string[]) =>
    execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", dir, "--json", ...args], {
      encoding: "utf8", stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });

  it("keeps the events, breaks and bookings, gives the events an empty share message, and adds the empty template tables", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    const before = files.filter((f) => f < "0014");
    expect(before.at(-1)).toMatch(/^0013_/);
    const all = join(dir, "up-to-0013.sql");
    writeFileSync(all, before.map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n"));
    wrangler("--file", all);
    wrangler("--command",
      `INSERT INTO events (name, start_utc, end_utc, session_minutes, venue_postcode, slug, details, listed)
       VALUES ('Old', '2026-03-14T09:00:00Z', '2026-03-14T12:00:00Z', 15, 'AB1 2CD', 'old-slug-aaaaaaaaaaaaaa', 'Bring water', 0)`);
    wrangler("--command", "INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (1, '2026-03-14T10:00:00Z', '2026-03-14T10:30:00Z', 'Lunch')");
    wrangler("--command",
      `INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key)
       VALUES (1, '2026-03-14T09:00:00Z', 'Rex', 'Sam Jones', 'rex', 'sam jones')`);

    wrangler("--file", join(MIGRATIONS, files.find((f) => f.startsWith("0014_"))!));

    const rows = (sql: string) => (JSON.parse(wrangler("--command", sql)) as { results: Record<string, unknown>[] }[])[0].results;
    expect(rows("SELECT name, details, listed, share_message FROM events")).toEqual([
      { name: "Old", details: "Bring water", listed: 0, share_message: "" },
    ]);
    expect(rows("SELECT label FROM breaks")).toEqual([{ label: "Lunch" }]);
    expect(rows("SELECT dog_name FROM bookings")).toEqual([{ dog_name: "Rex" }]);
    expect(rows("SELECT (SELECT COUNT(*) FROM event_templates) AS t, (SELECT COUNT(*) FROM event_template_breaks) AS b")).toEqual([{ t: 0, b: 0 }]);
    wrangler("--command", "INSERT INTO event_templates (name, is_default, venue_postcode, start_time, end_time, session_minutes) VALUES ('T', 1, 'AB1 2CD', '09:00', '12:00', 15)");
    wrangler("--command", "UPDATE events SET share_message = 'Hello' WHERE id = 1");
    expect(rows("SELECT share_message FROM events")).toEqual([{ share_message: "Hello" }]);
  }, 120_000);
});

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStagedDb, migrationFile, statementsOf, type StagedDb } from "./staged-db";

// 0018 adds the booking form's fields (event_fields, event_template_fields) and gives every existing event and template
// the Dog and Handler fields it always had. Every case starts from a real local D1 migrated through 0017 and holding
// events, templates and bookings the way the earlier migrations leave them.

const statements = () => statementsOf(readFileSync(migrationFile("0018"), "utf8"));
async function runFile(db: D1Database, only?: (statements: string[]) => string[]): Promise<void> {
  const all = statements();
  for (const s of only ? only(all) : all) await db.prepare(s).run();
}
const all = async (db: D1Database, sql: string) => (await db.prepare(sql).all<Record<string, unknown>>()).results;

async function dump(db: D1Database) {
  const out: Record<string, unknown> = {};
  out.event_fields = await all(db, "SELECT * FROM event_fields ORDER BY event_id, position");
  out.event_template_fields = await all(db, "SELECT * FROM event_template_fields ORDER BY template_id, position");
  out.bookings = await all(db, "SELECT * FROM bookings ORDER BY id");
  out.schema = await all(db, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  return out;
}


let at17: StagedDb; // through 0017, with three events, two templates and two bookings
let reference: Record<string, unknown>; // 0018 run once, cleanly, by a plain apply of the file
const cleanup: StagedDb[] = [];

beforeAll(async () => {
  at17 = await createStagedDb("0014");
  const db = at17.env.DB;
  const event = (id: number, slug: string) => db.prepare(
    `INSERT INTO events (id, slug, name, start_utc, end_utc, session_minutes, gap_minutes, venue_postcode, details, listed)
     VALUES (?, ?, ?, '2026-10-17T08:00:00Z', '2026-10-17T10:00:00Z', 30, 0, 'AB1 2CD', '', 1)`,
  ).bind(id, slug, `Event ${id}`);
  await db.batch([
    event(1, "event-one-aaaaaaaaaaaa"), event(2, "event-two-aaaaaaaaaaaa"),
    db.prepare(
      `INSERT INTO event_templates (id, name, is_default, venue_postcode, start_time, end_time, session_minutes)
       VALUES (1, 'Standard', 1, 'AB1 2CD', '09:00', '12:00', 15), (2, 'Evening', 0, 'AB1 2CD', '18:00', '20:00', 20)`,
    ),
    db.prepare(
      `INSERT INTO bookings (id, event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key, token)
       VALUES (1, 1, '2026-10-17T08:00:00Z', 'Zoë', 'Ann Lee', 'zoë', 'ann lee', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'),
              (2, 1, '2026-10-17T08:30:00Z', 'Rex', 'Sam', 'rex', 'sam', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2')`,
    ),
  ]);
  await at17.applyThrough("0017");
  const db17 = at17.env.DB; // applyThrough opens a new connection
  // An event made after 0016 and before 0018, by the code that only knew lanes: a layout row and a lane, and no fields.
  await db17.batch([
    db17.prepare(
      `INSERT INTO events (id, slug, name, start_utc, end_utc, session_minutes, gap_minutes, venue_postcode, details, listed)
       VALUES (3, 'event-three-aaaaaaaaaa', 'Event 3', '2026-10-17T08:00:00Z', '2026-10-17T10:00:00Z', 30, 0, 'AB1 2CD', '', 1)`,
    ),
    db17.prepare("INSERT INTO event_layout (event_id, capacity, identity_limit) VALUES (3, 2, 3)"),
    db17.prepare("INSERT INTO event_lanes (event_id, position, name) VALUES (3, 1, '')"),
    db17.prepare(
      `INSERT INTO bookings (event_id, lane_id, slot_start_utc, value_1, value_2, identity_key, token)
       VALUES (3, (SELECT id FROM event_lanes WHERE event_id = 3), '2026-10-17T08:00:00Z', 'Moss', 'Pat', 'moss' || char(31) || 'pat', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3')`,
    ),
  ]);
  const clean = await at17.fork();
  cleanup.push(clean);
  await runFile(clean.env.DB);
  reference = await dump(clean.env.DB);
}, 300_000);
afterAll(async () => { await Promise.all([at17, ...cleanup].map((s) => s?.dispose())); });

describe("0018 applied by wrangler", () => {
  let full: StagedDb;
  beforeAll(async () => {
    full = await at17.fork();
    cleanup.push(full);
    await full.applyThrough("0018");
  }, 300_000);
  const db = () => full.env.DB;

  it("gives every event, including the one made after 0016, Dog and Handler: required, 80 characters, both in the identity", async () => {
    expect(await all(db(), "SELECT * FROM event_fields ORDER BY event_id, position")).toEqual(
      [1, 2, 3].flatMap((event_id) => [
        { event_id, position: 1, label: "Dog", required: 1, max_length: 80, in_identity: 1 },
        { event_id, position: 2, label: "Handler", required: 1, max_length: 80, in_identity: 1 },
      ]),
    );
  });

  it("gives every template the same two fields", async () => {
    expect(await all(db(), "SELECT * FROM event_template_fields ORDER BY template_id, position")).toEqual(
      [1, 2].flatMap((template_id) => [
        { template_id, position: 1, label: "Dog", required: 1, max_length: 80, in_identity: 1 },
        { template_id, position: 2, label: "Handler", required: 1, max_length: 80, in_identity: 1 },
      ]),
    );
  });

  it("changes nothing about the bookings, the layout (not even the identity limit) or the lanes", async () => {
    expect(await all(db(), "SELECT id, event_id, value_1, value_2, value_3, value_4, identity_key, identity_seq FROM bookings ORDER BY id")).toEqual([
      { id: 1, event_id: 1, value_1: "Zoë", value_2: "Ann Lee", value_3: "", value_4: "", identity_key: "zoë\u001fann lee", identity_seq: 1 },
      { id: 2, event_id: 1, value_1: "Rex", value_2: "Sam", value_3: "", value_4: "", identity_key: "rex\u001fsam", identity_seq: 1 },
      { id: 3, event_id: 3, value_1: "Moss", value_2: "Pat", value_3: "", value_4: "", identity_key: "moss\u001fpat", identity_seq: 1 },
    ]);
    expect(await all(db(), "SELECT event_id, capacity, identity_limit, config_rev FROM event_layout ORDER BY event_id")).toEqual([
      { event_id: 1, capacity: 1, identity_limit: 1, config_rev: 0 }, { event_id: 2, capacity: 1, identity_limit: 1, config_rev: 0 },
      { event_id: 3, capacity: 2, identity_limit: 3, config_rev: 0 },
    ]);
    expect(await all(db(), "SELECT COUNT(*) AS n FROM event_lanes")).toEqual([{ n: 3 }]);
  });

  it("has the same schema and rows as running the file by hand", async () => {
    expect(await dump(db())).toEqual(reference);
  });

  it("has a label index that ignores case, and no other index on the tables", async () => {
    expect(await all(db(), "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('event_fields', 'event_template_fields') AND name NOT LIKE 'sqlite_%' ORDER BY name")).toEqual([
      { name: "event_fields_label", tbl_name: "event_fields" }, { name: "event_template_fields_label", tbl_name: "event_template_fields" },
    ]);
  });

  it("checks one row: position 1 to 4, label 1 to 40 characters, max length 1 to 80, flags 0 or 1", async () => {
    const insert = (over: Record<string, unknown>) => {
      const row = { event_id: 2, position: 3, label: "Notes", required: 0, max_length: 80, in_identity: 0, ...over };
      const columns = Object.keys(row);
      return db().prepare(`INSERT INTO event_fields (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
    };
    for (const bad of [{ position: 0 }, { position: 5 }, { label: "" }, { label: "x".repeat(41) }, { max_length: 0 }, { max_length: 81 }, { required: 2 }, { in_identity: 2 }]) {
      await expect(insert(bad), JSON.stringify(bad)).rejects.toThrow(/CHECK constraint failed/);
    }
    await expect(insert({ position: 1 })).rejects.toThrow(/UNIQUE constraint failed/); // the primary key
    await expect(insert({ label: "HANDLER" })).rejects.toThrow(/UNIQUE constraint failed/); // the label ignoring case, in the same event
    await insert({ label: "x".repeat(40), max_length: 1 });
    await db().prepare("DELETE FROM event_fields WHERE event_id = 2 AND position = 3").run();
    // The defaults are required, 80 characters and not in the identity. (Events 1 and 2 both have a Dog: a label is only unique within an event.)
    await db().prepare("INSERT INTO event_fields (event_id, position, label) VALUES (2, 3, 'Notes')").run();
    expect(await all(db(), "SELECT required, max_length, in_identity FROM event_fields WHERE event_id = 2 AND position = 3")).toEqual([{ required: 1, max_length: 80, in_identity: 0 }]);
    await db().prepare("DELETE FROM event_fields WHERE event_id = 2 AND position = 3").run();
  });

  it("checks a template's field row the same way", async () => {
    const insert = (over: Record<string, unknown>) => {
      const row = { template_id: 2, position: 3, label: "Notes", required: 0, max_length: 80, in_identity: 0, ...over };
      const columns = Object.keys(row);
      return db().prepare(`INSERT INTO event_template_fields (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
    };
    for (const bad of [{ position: 5 }, { label: "" }, { label: "x".repeat(41) }, { max_length: 81 }, { required: 2 }, { in_identity: 2 }]) {
      await expect(insert(bad), JSON.stringify(bad)).rejects.toThrow(/CHECK constraint failed/);
    }
    await expect(insert({ label: "dog" })).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insert({ template_id: 99 })).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await insert({});
    await db().prepare("DELETE FROM event_template_fields WHERE template_id = 2 AND position = 3").run();
  });

  it("deletes an event's fields with the event, and a template's with the template", async () => {
    await db().prepare("DELETE FROM events WHERE id = 2").run();
    await db().prepare("DELETE FROM event_templates WHERE id = 2").run();
    expect(await all(db(), "SELECT DISTINCT event_id FROM event_fields ORDER BY event_id")).toEqual([{ event_id: 1 }, { event_id: 3 }]);
    expect(await all(db(), "SELECT DISTINCT template_id FROM event_template_fields")).toEqual([{ template_id: 1 }]);
    expect(await all(db(), "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("applying again does nothing", async () => {
    const before = await dump(db());
    await full.applyThrough("0018");
    expect(await dump(db())).toEqual(before);
  });
});

describe("0018 can be run again", () => {
  it("gives the same database whether the file ran once, twice or three times", async () => {
    const f = await at17.fork();
    cleanup.push(f);
    await runFile(f.env.DB);
    await runFile(f.env.DB);
    await runFile(f.env.DB);
    expect(await dump(f.env.DB)).toEqual(reference);
  }, 120_000);

  // The file stopped after statement `n`, as an interrupted run would: running the whole file again finishes it.
  const cuts: [string, (s: string) => boolean][] = [
    ["after creating the first table", (s) => s.startsWith("CREATE TABLE IF NOT EXISTS event_fields")],
    ["after creating both tables and indexes, before the backfill", (s) => s.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS event_template_fields_label")],
    ["after the Dog fields of the events", (s) => s.includes("SELECT id, 1, 'Dog', 1, 80, 1 FROM events")],
    ["after the fields of the events, before the templates'", (s) => s.includes("SELECT id, 2, 'Handler', 1, 80, 1 FROM events")],
    ["after the Dog fields of the templates", (s) => s.includes("SELECT id, 1, 'Dog', 1, 80, 1 FROM event_templates")],
  ];
  it.each(cuts)("finishes a run that stopped %s", async (_name, isLast) => {
    const cut = statements().findIndex(isLast);
    expect(cut, "the cut point exists").toBeGreaterThanOrEqual(0);
    const half = await at17.fork();
    cleanup.push(half);
    await runFile(half.env.DB, (s) => s.slice(0, cut + 1));
    await runFile(half.env.DB);
    expect(await dump(half.env.DB)).toEqual(reference);
  }, 120_000);

  it("leaves a field that already exists alone, and does not clash with a label that has been taken since", async () => {
    const f = await at17.fork();
    cleanup.push(f);
    await runFile(f.env.DB);
    // An admin has since renamed Dog to Horse and made Handler optional; the file run again must not undo that.
    await f.env.DB.prepare("UPDATE event_fields SET label = 'Horse' WHERE event_id = 1 AND position = 1").run();
    await f.env.DB.prepare("UPDATE event_fields SET required = 0, in_identity = 0 WHERE event_id = 1 AND position = 2").run();
    await runFile(f.env.DB);
    expect(await all(f.env.DB, "SELECT position, label, required, in_identity FROM event_fields WHERE event_id = 1 ORDER BY position")).toEqual([
      { position: 1, label: "Horse", required: 1, in_identity: 1 }, { position: 2, label: "Handler", required: 0, in_identity: 0 },
    ]);
  }, 120_000);
});


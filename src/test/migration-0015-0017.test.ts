/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityKey } from "../core/identity";
import { createStagedDb, migrationFile, statementsOf, type StagedDb } from "./staged-db";

// The bookings rebuild for lanes and places: 0015 sets the table aside, 0016 builds the new schema and copies the
// rows (re-runnable), 0017 drops the old table. Every case starts from a real local D1 at migration 0014 holding
// v1.0-shaped data, so what is checked is what an existing club's database goes through.

const sqlOf = (prefix: string) => statementsOf(readFileSync(migrationFile(prefix), "utf8"));
const SEP = "\u001f";

async function runFile(db: D1Database, prefix: string, only?: (statements: string[]) => string[]): Promise<void> {
  const all = sqlOf(prefix);
  for (const s of only ? only(all) : all) await db.prepare(s).run();
}

const TOKENS = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4"];
/** [id, event id, slot, dog, handler, created_at, token, idempotency key] as v1.0 stored them (keys are identityKey of the names). */
const LEGACY: [number, number, string, string, string, string, string | null, string | null][] = [
  [1, 1, "2026-10-17T08:00:00Z", "Zoë", "Ann Lee", "2026-09-20T18:42:10Z", TOKENS[0], "idem-key-aaaaaaaaaaaaaaaa"],
  [2, 1, "2026-10-17T09:00:00Z", "Rex 🐶", "Sam Smith", "2026-09-20T10:15:00Z", TOKENS[1], null],
  [3, 3, "2026-10-17T05:00:00Z", "Lost Tag", "Ed Cole", "2026-09-26T17:00:00Z", TOKENS[2], null], // an orphan: 05:00 is not a slot of event 3
  [4, 1, "2026-10-17T09:30:00Z", "ΣΊΣΥΦΟΣ", "Παναγιώτης", "2026-09-21T07:05:33Z", TOKENS[3], "idem-key-bbbbbbbbbbbbbbbb"],
  [5, 1, "2026-10-17T08:30:00Z", "No Token", "Old Timer", "2026-09-22T12:00:00Z", null, null], // from before tokens were made (the column is nullable)
];

async function seedLegacy(db: D1Database): Promise<void> {
  const event = (id: number, slug: string, start: string, end: string) => db.prepare(
    `INSERT INTO events (id, slug, name, start_utc, end_utc, session_minutes, gap_minutes, venue_postcode, details, listed)
     VALUES (?, ?, ?, ?, ?, 30, 0, 'AB1 2CD', 'Bring water', 1)`,
  ).bind(id, slug, `Event ${id}`, start, end);
  await db.batch([
    event(1, "event-one-aaaaaaaaaaaa", "2026-10-17T08:00:00Z", "2026-10-17T10:00:00Z"),
    event(2, "event-two-aaaaaaaaaaaa", "2026-10-18T08:00:00Z", "2026-10-18T09:00:00Z"), // no bookings at all
    event(3, "event-three-aaaaaaaaaa", "2026-10-17T10:00:00Z", "2026-10-17T11:00:00Z"),
    db.prepare("INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (1, '2026-10-17T08:30:00Z', '2026-10-17T09:00:00Z', 'Tea')"),
    db.prepare(
      `INSERT INTO event_templates (id, name, is_default, venue_postcode, start_time, end_time, session_minutes)
       VALUES (1, 'Standard', 1, 'AB1 2CD', '09:00', '12:00', 15), (2, 'Evening', 0, 'AB1 2CD', '18:00', '20:00', 20)`,
    ),
    db.prepare("INSERT INTO event_template_breaks (template_id, start_time, end_time, label) VALUES (1, '10:30', '10:45', 'Tea')"),
    ...LEGACY.map(([id, ev, slot, dog, handler, created, token, idem]) =>
      db.prepare(
        `INSERT INTO bookings (id, event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key, created_at, token, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, ev, slot, dog, handler, identityKey(dog), identityKey(handler), created, token, idem)),
    // A booking that existed and was cleared. The migration does not carry the id counter over (remote D1 may refuse writes to sqlite_sequence), so its id may be issued again.
    db.prepare(
      `INSERT INTO bookings (id, event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key, token)
       VALUES (9, 2, '2026-10-18T08:00:00Z', 'Gone', 'Gone', 'gone', 'gone', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9')`),
    db.prepare("DELETE FROM bookings WHERE id = 9"),
  ]);
}

const all = async (db: D1Database, sql: string) => (await db.prepare(sql).all<Record<string, unknown>>()).results;

/** Everything the migration touches, in a form two databases can be compared by. */
async function dump(db: D1Database) {
  const tables = ["events", "breaks", "event_layout", "event_lanes", "event_templates", "event_template_breaks", "event_template_layout", "event_template_lanes", "bookings"];
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = await all(db, `SELECT * FROM ${t} ORDER BY ${t === "event_layout" ? "event_id" : t === "event_template_layout" ? "template_id" : "id"}`);
  // The token made for the booking that had none is random, so only its shape is compared.
  for (const b of out.bookings as { token: string }[]) if (/^[0-9a-f]{32}$/.test(b.token) && !TOKENS.includes(b.token)) b.token = "<random 32 hex>";
  out.schema = await all(db, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
  return out;
}

let base: StagedDb; // at 0014 with the v1.0 data
let after15: StagedDb; // the same, with 0015 applied
let reference: Record<string, unknown>; // 0016 and 0017 run once, cleanly, on a copy of after15
const cleanup: StagedDb[] = [];

beforeAll(async () => {
  base = await createStagedDb("0014");
  await seedLegacy(base.env.DB);
  after15 = await base.fork();
  await after15.applyThrough("0015");
  const clean = await after15.fork();
  cleanup.push(clean);
  await runFile(clean.env.DB, "0016");
  await runFile(clean.env.DB, "0017");
  reference = await dump(clean.env.DB);
}, 300_000);
afterAll(async () => { await Promise.all([base, after15, ...cleanup].map((s) => s?.dispose())); });

describe("0015 to 0017 applied by wrangler to a v1.0 database", () => {
  let full: StagedDb;
  beforeAll(async () => {
    full = await base.fork();
    cleanup.push(full);
    await full.applyThrough("0017");
  }, 300_000);
  const db = () => full.env.DB;

  it("keeps every booking: id, event, slot, names, created_at, token and idempotency key", async () => {
    const rows = await all(db(), "SELECT id, event_id, slot_start_utc, value_1, value_2, value_3, value_4, created_at, token, idempotency_key FROM bookings ORDER BY id");
    expect(rows).toHaveLength(LEGACY.length);
    for (const [i, [id, ev, slot, dog, handler, created, token, idem]] of LEGACY.entries()) {
      expect(rows[i]).toEqual({
        id, event_id: ev, slot_start_utc: slot, value_1: dog, value_2: handler, value_3: "", value_4: "", created_at: created,
        token: token ?? expect.stringMatching(/^[0-9a-f]{32}$/), idempotency_key: idem,
      });
    }
  });

  it("builds the identity key from the stored keys joined with U+001F, at place 1 and number 1, in the event's only lane", async () => {
    const rows = await all(db(), "SELECT id, event_id, lane_id, place, identity_key, identity_seq FROM bookings ORDER BY id");
    const lanes = new Map((await all(db(), "SELECT id, event_id FROM event_lanes")).map((l) => [l.event_id, l.id]));
    for (const [i, [id, ev, , dog, handler]] of LEGACY.entries()) {
      expect(rows[i]).toEqual({ id, event_id: ev, lane_id: lanes.get(ev), place: 1, identity_key: identityKey(dog) + SEP + identityKey(handler), identity_seq: 1 });
    }
    expect(String(rows[0].identity_key)).toBe(`zoë${SEP}ann lee`);
  });

  it("gives every event one unnamed lane and a layout of capacity 1 and identity limit 1, and every template the same", async () => {
    expect(await all(db(), "SELECT event_id, position, name FROM event_lanes ORDER BY event_id")).toEqual([
      { event_id: 1, position: 1, name: "" }, { event_id: 2, position: 1, name: "" }, { event_id: 3, position: 1, name: "" },
    ]);
    expect(await all(db(), "SELECT * FROM event_layout ORDER BY event_id")).toEqual([1, 2, 3].map((event_id) => ({ event_id, capacity: 1, identity_limit: 1, config_rev: 0 })));
    expect(await all(db(), "SELECT template_id, position, name FROM event_template_lanes ORDER BY template_id")).toEqual([
      { template_id: 1, position: 1, name: "" }, { template_id: 2, position: 1, name: "" },
    ]);
    expect(await all(db(), "SELECT * FROM event_template_layout ORDER BY template_id")).toEqual([1, 2].map((template_id) => ({ template_id, capacity: 1, identity_limit: 1 })));
  });

  it("leaves the events, breaks, templates and template breaks as they were", async () => {
    expect(await all(db(), "SELECT id, slug, name FROM events ORDER BY id")).toHaveLength(3);
    expect(await all(db(), "SELECT label FROM breaks")).toEqual([{ label: "Tea" }]);
    expect(await all(db(), "SELECT id, name, is_default FROM event_templates ORDER BY id")).toEqual([
      { id: 1, name: "Standard", is_default: 1 }, { id: 2, name: "Evening", is_default: 0 },
    ]);
    expect(await all(db(), "SELECT label FROM event_template_breaks")).toEqual([{ label: "Tea" }]);
  });

  it("drops the legacy table and its constraints, and has exactly the new unique rules", async () => {
    expect(await all(db(), "SELECT name FROM sqlite_master WHERE name LIKE '%legacy%'")).toEqual([]);
    const indexes = await all(db(), "SELECT name, \"unique\" AS u FROM pragma_index_list('bookings') WHERE origin = 'c' ORDER BY name");
    expect(indexes.map((i) => i.name)).toEqual(["bookings_idempotency_key", "bookings_identity_seq", "bookings_lane_id", "bookings_one_per_place", "bookings_token"]);
    const columns = async (name: string) => (await all(db(), `SELECT name FROM pragma_index_info('${name}') ORDER BY seqno`)).map((c) => c.name);
    expect(await columns("bookings_one_per_place")).toEqual(["event_id", "lane_id", "slot_start_utc", "place"]);
    expect(await columns("bookings_identity_seq")).toEqual(["event_id", "identity_key", "identity_seq"]);
    expect(await columns("bookings_idempotency_key")).toEqual(["event_id", "idempotency_key"]);
    expect(await columns("bookings_token")).toEqual(["token"]);
    // The old rules are gone: one booking per slot, and one per dog and handler (the old index's name is not back either).
    expect(await all(db(), "SELECT name FROM sqlite_master WHERE name = 'bookings_one_run_per_dog_handler_keys'")).toEqual([]);
    expect(await all(db(), "SELECT name FROM pragma_index_list('bookings') WHERE origin = 'u'")).toEqual([]);
  });

  it("does not write to sqlite_sequence (remote D1 may refuse it), so the counter starts at the highest id copied: the next booking is 6, and the cleared booking 9's id may be reused", async () => {
    expect(statements16().filter((x) => /sqlite_sequence/i.test(x))).toEqual([]);
    const row = await db().prepare(
      `INSERT INTO bookings (event_id, lane_id, slot_start_utc, value_1, identity_key, token) VALUES (2, (SELECT id FROM event_lanes WHERE event_id = 2), '2026-10-18T08:00:00Z', 'Next', 'next', 'cccccccccccccccccccccccccccccc1') RETURNING id`,
    ).first<{ id: number }>();
    expect(row!.id).toBe(6);
  });

  it("enforces the new rules: a second place in the same slot is fine, the same place, identity number, key or token is not", async () => {
    const insert = (over: Record<string, unknown>) => {
      const row = { event_id: 1, lane_id: 1, slot_start_utc: "2026-10-17T08:00:00Z", place: 2, value_1: "New", identity_key: "new", identity_seq: 1, token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1", idempotency_key: null, ...over };
      const columns = Object.keys(row);
      return db().prepare(`INSERT INTO bookings (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).bind(...Object.values(row)).run();
    };
    await insert({});
    await expect(insert({ identity_key: "other", token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2" })).rejects.toThrow(/UNIQUE constraint failed/); // same place
    await expect(insert({ place: 3, token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb3" })).rejects.toThrow(/UNIQUE constraint failed/); // same identity number
    await insert({ place: 3, identity_key: "new", identity_seq: 2, token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb3" });
    await expect(insert({ place: 4, identity_key: "x", token: aTokenOf(1) })).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insert({ place: 4, identity_key: "x", token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb5", idempotency_key: "idem-key-aaaaaaaaaaaaaaaa" })).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(insert({ place: 0, identity_key: "y", token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb6" })).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert({ lane_id: 999, place: 4, identity_key: "z", token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb7" })).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("refuses a booking in a lane that belongs to another event, and a lane or event that does not exist", async () => {
    const lane = (ev: number) => `(SELECT id FROM event_lanes WHERE event_id = ${ev})`;
    const book = (ev: number, laneSql: string, token: string) => db().prepare(
      `INSERT INTO bookings (event_id, lane_id, slot_start_utc, value_1, identity_key, token) VALUES (${ev}, ${laneSql}, '2026-10-18T08:30:00Z', 'Stray', 'stray-${token}', 'dddddddddddddddddddddddddddddd${token}')`,
    ).run();
    await expect(book(2, lane(1), "01")).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(book(1, lane(3), "02")).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await book(2, lane(2), "03"); // its own lane is fine
    await db().prepare("DELETE FROM bookings WHERE token LIKE 'dddddddddddddddddddddddddddddd%'").run();
  });

  it("has a lane position check wide enough to park lanes while they are reordered, but not unlimited", async () => {
    const lane = (position: number) => db().prepare("INSERT INTO event_lanes (event_id, position, name) VALUES (2, ?, ?)").bind(position, `L${position}`).run();
    await lane(105);
    await lane(1000);
    await expect(lane(1001)).rejects.toThrow(/CHECK constraint failed/);
    await expect(lane(0)).rejects.toThrow(/CHECK constraint failed/);
    await db().prepare("DELETE FROM event_lanes WHERE event_id = 2 AND position > 1").run();
  });

  it("has no foreign key violations", async () => {
    expect(await all(db(), "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("deletes an event with its lanes, layout and bookings, even though a booking's lane has no ON DELETE action", async () => {
    await db().prepare("DELETE FROM events WHERE id = 1").run();
    expect(await all(db(), "SELECT COUNT(*) AS n FROM bookings WHERE event_id = 1")).toEqual([{ n: 0 }]);
    expect(await all(db(), "SELECT COUNT(*) AS n FROM event_lanes WHERE event_id = 1")).toEqual([{ n: 0 }]);
    expect(await all(db(), "SELECT COUNT(*) AS n FROM event_layout WHERE event_id = 1")).toEqual([{ n: 0 }]);
    expect(await all(db(), "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("refuses to delete a lane that still has bookings", async () => {
    await expect(db().prepare("DELETE FROM event_lanes WHERE event_id = 3").run()).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("applying again does nothing and 0017 can be run once more", async () => {
    const before = await dump(db());
    await full.applyThrough("0017");
    await runFile(db(), "0017");
    expect(await dump(db())).toEqual(before);
  });
});

const aTokenOf = (i: number) => TOKENS[i - 1];

describe("0016 can be run again", () => {
  it("gives the same database as a single run, whether run twice in a row or again on a database where it already finished", async () => {
    const twice = await after15.fork();
    cleanup.push(twice);
    await runFile(twice.env.DB, "0016");
    await runFile(twice.env.DB, "0016");
    await runFile(twice.env.DB, "0016");
    await runFile(twice.env.DB, "0017");
    expect(await dump(twice.env.DB)).toEqual(reference);
    expect(await all(twice.env.DB, "PRAGMA foreign_key_check")).toEqual([]);
  }, 120_000);

  it("runs 0017 twice without an error", async () => {
    const f = await after15.fork();
    cleanup.push(f);
    await runFile(f.env.DB, "0016");
    await runFile(f.env.DB, "0017");
    await runFile(f.env.DB, "0017");
    expect(await dump(f.env.DB)).toEqual(reference);
  }, 120_000);

  // 0016 stopped after statement `n` (as a failed or interrupted run would): running the whole file again finishes it.
  const cuts: [string, (s: string) => boolean][] = [
    ["after creating the side tables and before the backfill", (s) => s.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS event_template_lanes_name")],
    ["after the backfill, before the legacy indexes are dropped", (s) => s.startsWith("INSERT INTO event_template_lanes")],
    ["after dropping the legacy indexes", (s) => s.startsWith("DROP INDEX IF EXISTS bookings_one_run_per_dog_handler_keys")],
    ["after creating the new bookings table, before the copy", (s) => s.startsWith("CREATE TABLE IF NOT EXISTS bookings")],
    ["after the copy, before any index of the new table", (s) => s.startsWith("INSERT OR IGNORE INTO bookings")],
    ["after the check that every legacy row arrived, before any index", (s) => s.startsWith("SELECT CASE WHEN (SELECT COUNT(*) FROM bookings_legacy)")],
    ["after the first two unique indexes", (s) => s.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS bookings_identity_seq")],
  ];
  it.each(cuts)("finishes a run that stopped %s", async (_name, isLast) => {
    const half = await after15.fork();
    cleanup.push(half);
    await runFile(half.env.DB, "0016", (statements) => statements.slice(0, statements.findIndex(isLast) + 1));
    expect(statements16().findIndex(isLast), "the cut point exists").toBeGreaterThanOrEqual(0);
    await runFile(half.env.DB, "0016");
    await runFile(half.env.DB, "0017");
    expect(await dump(half.env.DB)).toEqual(reference);
    expect(await all(half.env.DB, "PRAGMA foreign_key_check")).toEqual([]);
  }, 120_000);

  it("fails, and leaves the old table in place, if a legacy booking did not reach the new table", async () => {
    const f = await after15.fork();
    cleanup.push(f);
    // OR IGNORE would hide a row that breaks a constraint of the new table. Here a squatter holds legacy booking 1's token under an index of its own.
    await runFile(f.env.DB, "0016", (s) => s.slice(0, s.findIndex((x) => x.startsWith("INSERT OR IGNORE INTO bookings"))));
    await f.env.DB.prepare("CREATE UNIQUE INDEX squat ON bookings (token)").run();
    await f.env.DB.prepare(
      `INSERT INTO bookings (id, event_id, lane_id, slot_start_utc, value_1, identity_key, token)
       VALUES (100, 2, (SELECT id FROM event_lanes WHERE event_id = 2), '2026-10-18T08:00:00Z', 'Squatter', 'squatter', ?)`,
    ).bind(TOKENS[0]).run();
    await expect(runFile(f.env.DB, "0016")).rejects.toThrow(/integer overflow/);
    expect(await all(f.env.DB, "SELECT COUNT(*) AS n FROM bookings_legacy")).toEqual([{ n: LEGACY.length }]);
  }, 120_000);
});

const statements16 = () => sqlOf("0016");

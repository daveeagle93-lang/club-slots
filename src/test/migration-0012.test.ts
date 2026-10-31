/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityKey } from "../core/identity";
import { generateSlug } from "../core/slug";
import { createStagedDb, type StagedDb } from "./staged-db";
import { hex } from "./format-chars";

// The migration rewrites the keys of the bookings table as it was when 0012 ran, so this runs on a database migrated
// only as far as 0014 (the last migration before the bookings table was rebuilt for lanes and places, 0015).
let t: StagedDb;
beforeAll(async () => { t = await createStagedDb("0014"); }, 120_000);
afterAll(() => t.dispose());

/** Every code point with the Unicode property Default_Ignorable_Code_Point, found by scanning the whole range. */
const IGNORABLE: number[] = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (/^\p{Default_Ignorable_Code_Point}$/u.test(String.fromCodePoint(cp))) IGNORABLE.push(cp);
}

/** The key as the application computed it before 0012: NFKC, trim, collapse whitespace, lower-case. */
const oldKey = (s: string): string => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");

const MIGRATION = readFileSync(join(import.meta.dirname, "../../migrations/0012_strip_default_ignorables_from_keys.sql"), "utf8");

/** Runs the migration file again, statement by statement (D1's exec() reads one statement per line). */
async function runMigration(): Promise<void> {
  const sql = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await t.env.DB.prepare(statement).run();
  }
}

/** An event of the schema at 0014 (it has no lanes or layout yet). */
async function insertEvent(db: D1Database): Promise<{ id: number }> {
  return (await db.prepare(
    `INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode)
     VALUES (?, 'Test event', '2026-06-13T08:00:00Z', '2026-06-13T11:00:00Z', 15, 'AB1 2CD') RETURNING id`,
  ).bind(generateSlug()).first<{ id: number }>())!;
}

const BASE = Date.parse("2026-06-13T00:00:00Z");
let next = 0;
/** A booking with explicit keys and its own slot, so rows never clash unless the test makes them. */
const insertRow = () => t.env.DB.prepare(
  "INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key) VALUES (?, ?, ?, ?, ?, ?)",
);
let insert: D1PreparedStatement;
beforeAll(() => { insert = insertRow(); });
const row = (eventId: number, dogName: string, handlerName: string, dogKey: string, handlerKey: string) =>
  insert.bind(eventId, new Date(BASE + 1000 * next++).toISOString().replace(".000Z", "Z"), dogName, handlerName, dogKey, handlerKey);

/** In pages: one result of tens of thousands of rows takes the local D1 far longer than the same rows in pieces. */
async function keysOf(eventId: number) {
  const all: { dog: string; handler: string; dk: string; hk: string }[] = [];
  for (let after = 0; ;) {
    const { results } = await t.env.DB.prepare(
      "SELECT id, dog_name AS dog, handler_name AS handler, dog_key AS dk, handler_key AS hk FROM bookings WHERE event_id = ? AND id > ? ORDER BY id LIMIT 1000",
    ).bind(eventId, after).all<{ id: number; dog: string; handler: string; dk: string; hk: string }>();
    if (results.length === 0) return all;
    after = results[results.length - 1].id;
    all.push(...results.map(({ dog, handler, dk, hk }) => ({ dog, handler, dk, hk })));
  }
}

describe("0012 strip default-ignorable code points from identity keys", () => {
  it("scans a plausible set of default-ignorable code points", () => {
    expect(IGNORABLE).toHaveLength(4174);
    for (const cp of [0x00ad, 0x034f, 0x115f, 0x1160, 0x3164, 0xfe0f, 0xffa0, 0xe0100, 0xe01ef]) expect(IGNORABLE, hex(cp)).toContain(cp);
  });

  it("makes every stored key equal identityKey(name) for every default-ignorable code point, in each position", { timeout: 120_000 }, async () => {
    const { id } = await insertEvent(t.env.DB);
    const names: string[] = [];
    for (const cp of IGNORABLE) {
      const c = String.fromCodePoint(cp);
      // U+FEFF is also JavaScript whitespace, so an old key already turned one inside a word into a space; that cannot be undone.
      const word = cp === 0xfeff ? "Rex" : `Re${c}x`;
      names.push(`${c}${word}${c}`, `Rex ${c} ${c} Jones`, c);
    }
    // One handler per row, so the new keys cannot clash with each other.
    const statements = names.map((n, i) => row(id, n, `Handler ${i}`, oldKey(n), `handler ${i}`));
    for (let i = 0; i < statements.length; i += 500) await t.env.DB.batch(statements.slice(i, i + 500));

    await runMigration();

    const after = await keysOf(id);
    expect(after).toHaveLength(names.length);
    const wrong = after.filter((r) => r.dk !== identityKey(r.dog)).map((r) => `${JSON.stringify(r.dog)} -> ${JSON.stringify(r.dk)}`);
    expect(wrong.slice(0, 10)).toEqual([]);
    expect(after.map((r) => r.dog)).toEqual(names); // display names untouched
    expect(after.every((r, i) => r.hk === `handler ${i}`)).toBe(true);
  });

  it("strips the handler key too", async () => {
    const { id } = await insertEvent(t.env.DB);
    await t.env.DB.batch([row(id, "Rex", "Sam️ Jones", "rex", oldKey("Sam️ Jones"))]);
    await runMigration();
    expect(await keysOf(id)).toEqual([{ dog: "Rex", handler: "Sam️ Jones", dk: "rex", hk: "sam jones" }]);
  });

  it("does not abort when stripping would make two bookings of one event collide: one of each colliding pair is stripped, the other keeps its old key", async () => {
    const { id } = await insertEvent(t.env.DB);
    const rex = "Rex\uFE0F";
    const fidoA = "Fido\uFE0F";
    const fidoB = "Fido\u3164";
    await t.env.DB.batch([
      row(id, "Rex", "Sam", "rex", "sam"),
      row(id, rex, "Sam", oldKey(rex), "sam"),
      row(id, fidoA, "Ann", oldKey(fidoA), "ann"),
      row(id, fidoB, "Ann", oldKey(fidoB), "ann"),
    ]);
    await runMigration(); // does not throw
    const after = await keysOf(id);
    expect(after).toHaveLength(4); // nothing deleted
    expect(after.map((r) => r.dog)).toEqual(["Rex", rex, fidoA, fidoB]); // display names untouched
    // The first is already stripped, so the second cannot be (it would be a duplicate) and keeps its old key.
    expect(after.slice(0, 2).map((r) => r.dk)).toEqual(["rex", oldKey(rex)]);
    // Both of the second pair would become "fido": which one is updated first depends on SQLite's scan order, so only the shape is pinned.
    const pair = after.slice(2).map((r) => r.dk);
    expect(pair.filter((k) => k === "fido")).toHaveLength(1);
    expect(pair.filter((k) => k === oldKey(fidoA) || k === oldKey(fidoB))).toHaveLength(1);
    expect(new Set(after.map((r) => r.dk)).size).toBe(after.length); // and no two keys are equal
  });

  it("still processes the rows around a colliding one", async () => {
    const { id } = await insertEvent(t.env.DB);
    await t.env.DB.batch([
      row(id, "Rex", "Sam", "rex", "sam"),
      row(id, "Rex️", "Sam", oldKey("Rex️"), "sam"),
      row(id, "Bella️", "Sam", oldKey("Bella️"), "sam"),
    ]);
    await runMigration();
    expect((await keysOf(id)).map((r) => r.dk)).toEqual(["rex", "rex️", "bella"]);
  });

  it("is per event: the same stripped key in two events is no collision", async () => {
    const a = await insertEvent(t.env.DB);
    const b = await insertEvent(t.env.DB);
    await t.env.DB.batch([
      row(a.id, "Rex", "Sam", "rex", "sam"),
      row(b.id, "Rex️", "Sam", oldKey("Rex️"), "sam"),
    ]);
    await runMigration();
    expect((await keysOf(b.id)).map((r) => r.dk)).toEqual(["rex"]);
  });

  it("leaves untouched rows exactly as they were", async () => {
    const { id } = await insertEvent(t.env.DB);
    const plain = [["Rex", "Sam Jones"], ["Zoë", "Ann"], ["Ｒｅｘ", "Ann Lee"], ["犬", "太郎"], ["O'Brien", "Mary-Jane"], ["x y", "z"]];
    await t.env.DB.batch(plain.map(([d, h]) => row(id, d, h, oldKey(d), oldKey(h))));
    const before = await keysOf(id);
    await runMigration();
    expect(await keysOf(id)).toEqual(before);
    expect(before.map((r) => r.dk)).toEqual(plain.map(([d]) => oldKey(d)));
  });

  it("is idempotent", async () => {
    const { id } = await insertEvent(t.env.DB);
    await t.env.DB.batch([row(id, "Rex ️", "Sam", oldKey("Rex ️"), "sam")]);
    await runMigration();
    const once = await keysOf(id);
    await runMigration();
    expect(await keysOf(id)).toEqual(once);
  });
});

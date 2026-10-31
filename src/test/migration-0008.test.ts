import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, insertBreak, insertEvent, type TestEnv } from "./db";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

const withKey = (slug: string, key: string | null) =>
  t.env.DB.prepare(
    "INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode, idempotency_key) VALUES (?, 'E', '2026-06-13T08:00:00Z', '2026-06-13T09:00:00Z', 15, 'AB1 2CD', ?)",
  ).bind(slug, key).run();

describe("0008 breaks.label", () => {
  it("defaults to the empty string, so existing breaks stay unnamed", async () => {
    const { id } = await insertEvent(t.env.DB);
    await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
    const row = await t.env.DB.prepare("SELECT label FROM breaks WHERE event_id = ?").bind(id).first<{ label: string }>();
    expect(row?.label).toBe("");
  });

  it("stores a label, and refuses NULL and an over-long value", async () => {
    const { id } = await insertEvent(t.env.DB);
    const insert = (label: unknown) =>
      t.env.DB.prepare("INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (?, '2026-06-13T09:00:00Z', '2026-06-13T09:30:00Z', ?)")
        .bind(id, label).run();
    await insert("Lunch");
    await expect(insert(null)).rejects.toThrow(/NOT NULL constraint failed/);
    await expect(insert("x".repeat(101))).rejects.toThrow(/CHECK constraint failed/);
    await insert("x".repeat(100));
  });
});

describe("0008 events.idempotency_key", () => {
  it("is NULL for events inserted without one, and any number of those coexist", async () => {
    const a = await insertEvent(t.env.DB);
    const b = await insertEvent(t.env.DB);
    const { results } = await t.env.DB.prepare("SELECT idempotency_key AS k FROM events WHERE id IN (?, ?)").bind(a.id, b.id).all<{ k: string | null }>();
    expect(results.map((r) => r.k)).toEqual([null, null]);
  });

  it("is unique across events when set", async () => {
    await withKey("key-test-slug-aaaaaaaaaa", "event-key-aaaaaaaaaaaaaa");
    await expect(withKey("key-test-slug-bbbbbbbbbb", "event-key-aaaaaaaaaaaaaa")).rejects.toThrow(/UNIQUE constraint failed/);
    await withKey("key-test-slug-cccccccccc", "event-key-bbbbbbbbbbbbbb");
    await withKey("key-test-slug-dddddddddd", null);
    await withKey("key-test-slug-eeeeeeeeee", null);
  });
});

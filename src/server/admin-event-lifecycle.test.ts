import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../test/db";
import { clearPastEvents, deleteEvent } from "./admin-event-lifecycle";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });
beforeEach(async () => { await t.env.DB.prepare("DELETE FROM events").run(); });

const count = async (table: string): Promise<number> => (await t.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const rows = async () => [await count("events"), await count("breaks"), await count("bookings")];

async function seed(name = "Show") {
  const e = await insertEvent(t.env.DB, { name, startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z" });
  await insertBreak(t.env.DB, e.id, "2026-10-24T08:30:00Z", "2026-10-24T08:40:00Z");
  await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Alpha", "Ann");
  return e;
}

describe("deleteEvent: lanes and layout", () => {
  it("deletes an event whose lanes hold bookings in several places, taking its lanes and layout, and leaves another event's lanes alone", async () => {
    const e = await insertEvent(t.env.DB, { name: "Show", capacity: 2, lanes: ["Ring 1", "Ring 2"], startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z" });
    for (const laneId of e.laneIds) {
      await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", `A${laneId}`, "H", { laneId });
      await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", `B${laneId}`, "H", { laneId });
    }
    const keep = await seed("Keeper");
    expect(await deleteEvent(t.env.DB, e.slug, "Show")).toEqual({ kind: "deleted", slug: e.slug, name: "Show", bookings: 4 });
    expect(await count("event_lanes")).toBe(1);
    expect(await count("event_layout")).toBe(1);
    expect((await t.env.DB.prepare("SELECT event_id FROM event_lanes").first<{ event_id: number }>())!.event_id).toBe(keep.id);
    expect((await t.env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("also works when the lanes were added after the bookings and the event has no bookings at all", async () => {
    const e = await insertEvent(t.env.DB, { name: "Empty", lanes: ["Ring 1", "Ring 2"] });
    expect(await deleteEvent(t.env.DB, e.slug, "Empty")).toMatchObject({ kind: "deleted", bookings: 0 });
    expect(await count("event_lanes")).toBe(0);
  });

  it("a raw DELETE of the event row (as the app's own batch relies on for the lanes) cascades bookings and lanes in one statement", async () => {
    const e = await insertEvent(t.env.DB, { lanes: ["Ring 1", "Ring 2"] });
    await insertBooking(t.env.DB, e.id, "2026-06-13T08:00:00Z", "A", "H", { laneId: e.laneIds[1] });
    await t.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(e.id).run();
    expect(await rows()).toEqual([0, 0, 0]);
    expect(await count("event_lanes")).toBe(0);
  });
});

describe("deleteEvent: a request lands between the read and the batch", () => {
  it("deletes a booking added after the read too, counts it, and leaves no orphan rows", async () => {
    const e = await seed();
    let late = 0;
    const result = await deleteEvent(t.env.DB, e.slug, "Show", {
      afterRead: async () => { late = await insertBooking(t.env.DB, e.id, "2026-10-24T08:15:00Z", "Late", "Lee"); },
    });
    expect(late).toBeGreaterThan(0);
    expect(result).toEqual({ kind: "deleted", slug: e.slug, name: "Show", bookings: 2 });
    expect(await rows()).toEqual([0, 0, 0]);
  });

  it("answers not_found, deleting nothing else, when the event was deleted after the read (a second delete racing the first)", async () => {
    const e = await seed();
    const keep = await seed("Keeper");
    const result = await deleteEvent(t.env.DB, e.slug, "Show", {
      afterRead: async () => { await t.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(e.id).run(); },
    });
    expect(result).toEqual({ kind: "not_found" });
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE event_id = ?").bind(keep.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("refuses, deleting nothing, when the event was renamed after the confirmation was read", async () => {
    const e = await seed();
    const result = await deleteEvent(t.env.DB, e.slug, "Show", {
      afterRead: async () => { await t.env.DB.prepare("UPDATE events SET name = 'Renamed' WHERE id = ?").bind(e.id).run(); },
    });
    expect(result).toEqual({ kind: "confirmation_mismatch" });
    expect(await rows()).toEqual([1, 1, 1]);
  });

  it("two simultaneous deletes: one deletes, the other gets not_found, and every row is gone", async () => {
    const e = await seed();
    const results = await Promise.all([deleteEvent(t.env.DB, e.slug, "Show"), deleteEvent(t.env.DB, e.slug, "Show")]);
    expect(results.map((r) => r.kind).sort()).toEqual(["deleted", "not_found"]);
    expect(await rows()).toEqual([0, 0, 0]);
  });
});

describe("clearPastEvents", () => {
  const NOW = new Date("2026-10-01T12:00:00Z");
  const PAST = { startUtc: "2026-09-01T08:00:00Z", endUtc: "2026-09-01T11:00:00Z" };

  async function seedPast(name = "Old") {
    const e = await insertEvent(t.env.DB, { name, ...PAST });
    await insertBreak(t.env.DB, e.id, "2026-09-01T08:30:00Z", "2026-09-01T08:40:00Z");
    await insertBooking(t.env.DB, e.id, "2026-09-01T08:00:00Z", "Alpha", "Ann");
    await insertBooking(t.env.DB, e.id, "2026-09-01T08:15:00Z", "Bravo", "Bob");
    return e;
  }

  it("does not delete an event that was edited to end in the future after the request was checked: the condition runs inside the batch", async () => {
    const e = await seedPast();
    const other = await seedPast("Other");
    const result = await clearPastEvents(t.env.DB, NOW, [e.slug, other.slug], {
      beforeBatch: async () => {
        await t.env.DB.prepare("UPDATE events SET start_utc = '2026-10-24T08:00:00Z', end_utc = '2026-10-24T11:00:00Z' WHERE id = ?").bind(e.id).run();
      },
    });
    expect(result).toEqual({ deletedEvents: 1, deletedBookings: 2, skipped: [{ slug: e.slug, reason: "not_past" }] });
    expect(await rows()).toEqual([1, 1, 2]); // the edited event keeps its break and bookings
  });

  it("rolls everything back when one statement of the batch fails", async () => {
    const e = await seedPast();
    const other = await seedPast("Other");
    // Bookings and breaks are deleted first; the failing event delete must undo them.
    await t.env.DB.prepare("CREATE TRIGGER force_clear_failure BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'forced failure'); END").run();
    try {
      await expect(clearPastEvents(t.env.DB, NOW, [e.slug, other.slug])).rejects.toThrow(/forced failure/);
      expect(await rows()).toEqual([2, 2, 4]);
    } finally {
      await t.env.DB.prepare("DROP TRIGGER force_clear_failure").run();
    }
    expect(await clearPastEvents(t.env.DB, NOW, [e.slug, other.slug])).toEqual({ deletedEvents: 2, deletedBookings: 4, skipped: [] });
  });
});

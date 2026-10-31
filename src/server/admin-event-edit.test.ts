import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, insertBooking, insertBookingOf, insertBreak, insertEvent, insertsBooking, interceptBatches, type TestEnv, type TestField } from "../test/db";
import { addBooking, moveBooking } from "./admin-bookings";
import { createBooking, validateBookingInput } from "./bookings";
import { eventDetail, loadBookings, saveEventEdit } from "./admin-event-edit";
import { parseEventDraft, type EventDraft } from "./admin-events";
import { loadEventBySlug } from "./events";

const NOW = new Date("2026-10-01T12:00:00Z");

/** A booking of the Dog and Handler form as the admin API shows it: its labelled values. */
const dh = (dog: string, handler: string) => ({ fields: [{ label: "Dog", value: dog }, { label: "Handler", value: handler }] });

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

// 2026-10-24 (BST), 09:00-12:00 with a 10:00-10:30 break. Slot starts (Z): 08:00 08:15 08:30 08:45 | 09:30 ... 10:45.
async function seed() {
  const e = await insertEvent(t.env.DB, {
    startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, name: "Original",
  });
  await insertBreak(t.env.DB, e.id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z", "Lunch");
  const keep = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Alpha", "Ann");
  const b = await insertBooking(t.env.DB, e.id, "2026-10-24T10:30:00Z", "Bravo", "Bob");
  const c = await insertBooking(t.env.DB, e.id, "2026-10-24T10:45:00Z", "Charlie", "Cat");
  return { ...e, keep, b, c };
}

/** The edit that ends the event at 11:30 (10:30Z), dropping the 10:30Z and 10:45Z slots. */
function shortened(over: Record<string, unknown> = {}): EventDraft {
  const r = parseEventDraft({
    name: "Edited", date: "2026-10-24", start: "09:00", end: "11:30", sessionMinutes: 15, gapMinutes: 0, costPence: 1500,
    venuePostcode: "AB1 2CD", details: "", breaks: [{ start: "10:00", end: "10:30", label: "Renamed lunch" }], ...over,
  }, { now: NOW, requireFuture: false });
  if (!("draft" in r)) throw new Error(JSON.stringify(r.fields));
  return r.draft;
}

async function snapshot(eventId: number): Promise<string> {
  const q = async (sql: string) => (await t.env.DB.prepare(sql).bind(eventId).all()).results;
  return JSON.stringify([
    await q("SELECT * FROM events WHERE id = ?"), await q("SELECT * FROM breaks WHERE event_id = ? ORDER BY id"),
    await q("SELECT * FROM bookings WHERE event_id = ? ORDER BY id"),
  ]);
}

const load = async (slug: string) => (await loadEventBySlug(t.env.DB, slug))!;

describe("saveEventEdit: listed", () => {
  const listedOf = async (id: number) => (await t.env.DB.prepare("SELECT listed FROM events WHERE id = ?").bind(id).first<{ listed: number }>())!.listed;

  it("leaves listed as it is in the database when the draft omits it, even if it changed after the event was loaded", async () => {
    const e = await seed();
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened(), [e.b, e.c], {
      afterRead: async () => { await t.env.DB.prepare("UPDATE events SET listed = 0 WHERE id = ?").bind(e.id).run(); },
    });
    expect(result.kind).toBe("saved");
    expect(await listedOf(e.id)).toBe(0);
  });

  it("still writes listed when the draft says it, either way", async () => {
    const e = await seed();
    await saveEventEdit(t.env.DB, await load(e.slug), shortened({ listed: false }), [e.b, e.c]);
    expect(await listedOf(e.id)).toBe(0);
    await saveEventEdit(t.env.DB, await load(e.slug), shortened({ listed: true }), []);
    expect(await listedOf(e.id)).toBe(1);
  });
});

describe("saveEventEdit: a booking lands between the read and the save", () => {
  it("aborts the whole batch, writing nothing, and returns the fresh list including the newcomer", async () => {
    const e = await seed();
    // Bravo cancels, so the 10:30Z slot is free; only Charlie (10:45Z) is affected and confirmed.
    await t.env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(e.b).run();
    const was = JSON.parse(await snapshot(e.id)) as unknown[][];
    let newcomer = 0;
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened(), [e.c], {
      // Delta books the 10:30Z slot after the read: the edit removes that slot too, but Delta was never confirmed.
      afterRead: async () => { newcomer = await insertBooking(t.env.DB, e.id, "2026-10-24T10:30:00Z", "Delta", "Dee"); },
    });
    expect(result).toEqual({
      kind: "bookings_affected",
      affected: [
        { id: newcomer, slotStart: "2026-10-24T10:30:00Z", ...dh("Delta", "Dee"), lane: { id: e.laneId, name: "" } },
        { id: e.c, slotStart: "2026-10-24T10:45:00Z", ...dh("Charlie", "Cat"), lane: { id: e.laneId, name: "" } },
      ],
    });
    // Event fields not updated, breaks not replaced, the confirmed booking not deleted: only the newcomer is new.
    const after = JSON.parse(await snapshot(e.id)) as unknown[][];
    expect(after[0]).toEqual(was[0]);
    expect(after[1]).toEqual(was[1]);
    expect((after[2] as { id: number }[]).map((b) => b.id)).toEqual([e.keep, e.c, newcomer]);
    expect(after[2].slice(0, 2)).toEqual(was[2]);
  });

  it("saves normally when the booking lands on a slot that stays", async () => {
    const e = await seed();
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened(), [e.b, e.c], {
      afterRead: async () => { await insertBooking(t.env.DB, e.id, "2026-10-24T08:15:00Z", "Echo", "Eli"); },
    });
    expect(result.kind).toBe("saved");
    const names = (await t.env.DB.prepare("SELECT value_1 FROM bookings WHERE event_id = ? ORDER BY slot_start_utc").bind(e.id).all<{ value_1: string }>()).results;
    expect(names.map((r) => r.value_1)).toEqual(["Alpha", "Echo"]);
  });

  it("aborts with every confirmed booking still in place when a newcomer takes another removed slot", async () => {
    const e = await seed();
    // The deeper cut (end 11:15) also removes the 10:15Z slot, which Foxtrot books after the read.
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened({ end: "11:15" }), [e.b, e.c], {
      afterRead: async () => { await insertBooking(t.env.DB, e.id, "2026-10-24T10:15:00Z", "Foxtrot", "Fay"); },
    });
    expect(result.kind === "bookings_affected" && result.affected.map((a) => a.fields[0].value)).toEqual(["Foxtrot", "Bravo", "Charlie"]);
    const names = (await t.env.DB.prepare("SELECT value_1 FROM bookings WHERE event_id = ? ORDER BY slot_start_utc").bind(e.id).all<{ value_1: string }>()).results;
    expect(names.map((r) => r.value_1)).toEqual(["Alpha", "Foxtrot", "Bravo", "Charlie"]);
    expect((await load(e.slug)).name).toBe("Original");
  });

  it("lets two identical confirmed saves both succeed, removing each booking once", async () => {
    const e = await seed();
    const event = await load(e.slug);
    const [one, two] = await Promise.all([
      saveEventEdit(t.env.DB, event, shortened(), [e.b, e.c]),
      saveEventEdit(t.env.DB, event, shortened(), [e.b, e.c]),
    ]);
    expect(one.kind).toBe("saved");
    expect(two.kind).toBe("saved");
    const removed = [one, two].flatMap((r) => (r.kind === "saved" ? r.removed.map((b) => b.id) : [])).sort();
    expect(removed).toEqual([e.b, e.c].sort());
  });
});

describe("saveEventEdit: the event is deleted between the read and the save", () => {
  const strayRows = async (): Promise<number> => (await t.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM bookings WHERE event_id NOT IN (SELECT id FROM events))
          + (SELECT COUNT(*) FROM breaks WHERE event_id NOT IN (SELECT id FROM events)) AS n`,
  ).first<{ n: number }>())!.n;
  const deleteIt = (id: number) => async () => { await t.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run(); };

  it("answers not_found and writes nothing, for a draft with breaks (which would insert rows for a missing event)", async () => {
    const e = await seed();
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened(), [e.b, e.c], { afterRead: deleteIt(e.id) });
    expect(result).toEqual({ kind: "not_found" });
    expect(await snapshot(e.id)).toBe(JSON.stringify([[], [], []]));
    expect(await strayRows()).toBe(0);
  });

  it("answers not_found, not saved, for a draft with no breaks (nothing else would fail)", async () => {
    const e = await seed();
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened({ breaks: [] }), [e.b, e.c], { afterRead: deleteIt(e.id) });
    expect(result).toEqual({ kind: "not_found" });
    expect(await strayRows()).toBe(0);
  });

  it("leaves another event untouched", async () => {
    const e = await seed();
    const other = await seed();
    const before = await snapshot(other.id);
    await saveEventEdit(t.env.DB, await load(e.slug), shortened(), [e.b, e.c], { afterRead: deleteIt(e.id) });
    expect(await snapshot(other.id)).toBe(before);
  });
});

describe("bookings of an event with several lanes and places", () => {
  it("loadBookings lists them by slot, then lane position, then place", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const late = await insertBooking(t.env.DB, e.id, "2026-10-24T08:15:00Z", "Late", "H", { laneId: l1 });
    const r2p1 = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "R2P1", "H", { laneId: l2, place: 1 });
    const r1p2 = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "R1P2", "H", { laneId: l1, place: 2 });
    const r1p1 = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "R1P1", "H", { laneId: l1, place: 1 });
    expect((await loadBookings(t.env.DB, { id: e.id, fields: [] })).map((b) => b.id)).toEqual([r1p1, r1p2, r2p1, late]);
  });

  it("the schedule detail has no `booking` key (the bookings are in `places`), and the lineup text has one line per place, by time, lane and place", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T08:30:00Z", capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Second", "H", { laneId: e.laneIds[1], place: 1 });
    await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "First", "H", { laneId: e.laneIds[0], place: 1 });
    const detail = await eventDetail(t.env.DB, (await loadEventBySlug(t.env.DB, e.slug))!);
    expect(detail.slots.every((s) => !("booking" in s))).toBe(true);
    expect(detail.slots[0].places.map((p) => p.bookings.map((b) => b.fields[0].value))).toEqual([["First"], ["Second"]]);
    expect(detail.lineup.split("\n").slice(3)).toEqual([
      "09:00 Ring 1 — First — H", "09:00 Ring 1 — free", "09:00 Ring 2 — Second — H", "09:00 Ring 2 — free",
      "09:15 Ring 1 — free", "09:15 Ring 1 — free", "09:15 Ring 2 — free", "09:15 Ring 2 — free",
    ]);
  });

  it("the lineup of one unnamed lane with two places keeps the v1.0 line shape", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T08:30:00Z", capacity: 2 });
    await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Rex", "Sam", { place: 1 });
    const detail = await eventDetail(t.env.DB, (await loadEventBySlug(t.env.DB, e.slug))!);
    expect(detail.lineup.split("\n").slice(3)).toEqual(["09:00 — Rex — Sam", "09:00 — free", "09:15 — free", "09:15 — free"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Lanes and places: editing the layout, the clash diff, renumbering, the revision, and the races
// ---------------------------------------------------------------------------------------------------------------------

/** 2026-10-24 (BST) 09:00-10:00, 15-minute sessions: four slots, s[0] to s[3] (08:00Z to 08:45Z). */
const S = ["2026-10-24T08:00:00Z", "2026-10-24T08:15:00Z", "2026-10-24T08:30:00Z", "2026-10-24T08:45:00Z"];

async function seedLanes(o: { lanes?: string[]; capacity?: number } = {}) {
  const e = await insertEvent(t.env.DB, { startUtc: S[0], endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 15, lanes: o.lanes ?? ["Ring 1", "Ring 2"], capacity: o.capacity ?? 3 });
  return e;
}

/**
 * A draft for the event: the same times (09:00-10:00 London), with the given lanes and capacity (omitted keys stay omitted). A
 * request that sends the layout carries the `configRev` of its page (parseEventDraft needs one); these tests are about the engine
 * and stand for a page loaded just now, so the draft keeps no revision (it is then checked against the event as read) unless `over`
 * names one.
 */
function draftFor(event: { laneIds: number[] }, over: Record<string, unknown> = {}, capacity = 3): EventDraft {
  const r = parseEventDraft({
    name: "Edited", date: "2026-10-24", start: "09:00", end: "10:00", sessionMinutes: 15, gapMinutes: 0, costPence: 1250,
    venuePostcode: "AB1 2CD", details: "Test details", breaks: [], configRev: 0, ...over,
  }, { now: NOW, requireFuture: false, layout: { laneIds: event.laneIds, capacity }, requireConfigRev: true });
  if (!("draft" in r)) throw new Error(JSON.stringify(r.fields));
  return "configRev" in over ? r.draft : { ...r.draft, configRev: undefined };
}

const layoutRows = async (id: number) => ({
  lanes: (await t.env.DB.prepare("SELECT id, position, name FROM event_lanes WHERE event_id = ? ORDER BY position").bind(id).all<{ id: number; position: number; name: string }>()).results,
  layout: await t.env.DB.prepare("SELECT capacity, config_rev FROM event_layout WHERE event_id = ?").bind(id).first<{ capacity: number; config_rev: number }>(),
});
const placesOf = async (id: number) =>
  (await t.env.DB.prepare("SELECT id, lane_id, slot_start_utc, place FROM bookings WHERE event_id = ? ORDER BY slot_start_utc, lane_id, place").bind(id).all<{ id: number; lane_id: number; slot_start_utc: string; place: number }>()).results;
const bookedAt = (id: number, created: string) => t.env.DB.prepare("UPDATE bookings SET created_at = ? WHERE id = ?").bind(created, id).run();

describe("saveEventEdit: lanes", () => {
  it("renames a lane in place: same id, same bookings", async () => {
    const e = await seedLanes();
    const b = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam", { laneId: e.laneIds[0] });
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: e.laneIds[0], name: "Main ring" }, { id: e.laneIds[1], name: "Ring 2" }] }), []);
    expect(result.kind).toBe("saved");
    expect((await layoutRows(e.id)).lanes).toEqual([{ id: e.laneIds[0], position: 1, name: "Main ring" }, { id: e.laneIds[1], position: 2, name: "Ring 2" }]);
    expect((await placesOf(e.id)).map((r) => [r.id, r.lane_id])).toEqual([[b, e.laneIds[0]]]);
    expect(result.kind === "saved" && result.event.lanes.map((l) => l.name)).toEqual(["Main ring", "Ring 2"]);
  });

  it("swaps the names of two lanes, and reorders them, without clashing half-way", async () => {
    const e = await seedLanes({ lanes: ["A", "B", "C"] });
    const [a, b, c] = e.laneIds;
    const book = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam", { laneId: b });
    // B first, then C renamed "A", then A renamed "C": names and positions all move at once.
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: b, name: "B" }, { id: c, name: "A" }, { id: a, name: "C" }] }), []);
    expect(result.kind).toBe("saved");
    expect((await layoutRows(e.id)).lanes).toEqual([{ id: b, position: 1, name: "B" }, { id: c, position: 2, name: "A" }, { id: a, position: 3, name: "C" }]);
    expect((await placesOf(e.id)).map((r) => [r.id, r.lane_id])).toEqual([[book, b]]);
  });

  it("renames to a name another lane had before, and to a name that differs only in case", async () => {
    const e = await seedLanes({ lanes: ["Ring 1", "Ring 2"] });
    const [a, b] = e.laneIds;
    expect((await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: a, name: "Ring 2" }, { id: b, name: "ring 1" }] }), [])).kind).toBe("saved");
    expect((await layoutRows(e.id)).lanes.map((l) => l.name)).toEqual(["Ring 2", "ring 1"]);
  });

  it("adds new lanes (new ids), keeping the listed ones", async () => {
    const e = await seedLanes({ lanes: ["Ring 1"] });
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ name: "Ring 0" }, { id: e.laneIds[0], name: "Ring 1" }, { name: "Ring 2" }] }), []);
    expect(result.kind).toBe("saved");
    const lanes = (await layoutRows(e.id)).lanes;
    expect(lanes.map((l) => [l.position, l.name])).toEqual([[1, "Ring 0"], [2, "Ring 1"], [3, "Ring 2"]]);
    expect(lanes[1].id).toBe(e.laneIds[0]);
    expect(new Set(lanes.map((l) => l.id)).size).toBe(3);
  });

  it("goes from one unnamed lane to several named ones and back to one unnamed", async () => {
    const e = await seedLanes({ lanes: [""] });
    expect((await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: e.laneIds[0], name: "North" }, { name: "South" }] }), [])).kind).toBe("saved");
    expect((await layoutRows(e.id)).lanes.map((l) => l.name)).toEqual(["North", "South"]);
    expect((await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: e.laneIds[0], name: "" }] }), [])).kind).toBe("saved");
    expect((await layoutRows(e.id)).lanes).toEqual([{ id: e.laneIds[0], position: 1, name: "" }]);
  });

  it("removes an unlisted lane that has no bookings, and bumps nothing else", async () => {
    const e = await seedLanes({ lanes: ["Ring 1", "Ring 2"] });
    const keep = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam", { laneId: e.laneIds[0] });
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: e.laneIds[0], name: "Ring 1" }] }), []);
    expect(result).toMatchObject({ kind: "saved", removed: [] });
    expect((await layoutRows(e.id)).lanes.map((l) => l.id)).toEqual([e.laneIds[0]]);
    expect((await placesOf(e.id)).map((r) => r.id)).toEqual([keep]);
  });

  it("leaves lanes and capacity as they are when the draft doesn't send them", async () => {
    const e = await seedLanes();
    const was = await layoutRows(e.id);
    expect((await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e), [])).kind).toBe("saved");
    expect(await layoutRows(e.id)).toEqual(was);
  });
});

describe("saveEventEdit: the layout revision (config_rev)", () => {
  const revOf = async (id: number) => (await layoutRows(id)).layout!.config_rev;
  const lanesOf = (e: { laneIds: number[] }, names: string[]) => names.map((name, i) => (e.laneIds[i] === undefined ? { name } : { id: e.laneIds[i], name }));

  it("goes up by one for a rename, a reorder, an added lane, a removed lane and a capacity change, and not for anything else", async () => {
    const e = await seedLanes({ lanes: ["A", "B"], capacity: 2 });
    const [a, b] = e.laneIds;
    const edit = async (over: Record<string, unknown>) => {
      const before = await revOf(e.id);
      const r = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, over, (await layoutRows(e.id)).layout!.capacity), []);
      expect(r.kind).toBe("saved");
      return (await revOf(e.id)) - before;
    };
    expect(await edit({ name: "Another name", costPence: 900, details: "x", listed: false })).toBe(0);
    expect(await edit({ breaks: [{ start: "09:30", end: "09:45" }] })).toBe(0);
    expect(await edit({ lanes: [{ id: a, name: "A" }, { id: b, name: "B" }], capacity: 2 })).toBe(0); // the same layout again
    expect(await edit({ lanes: [{ id: a, name: "A2" }, { id: b, name: "B" }] })).toBe(1);
    expect(await edit({ lanes: [{ id: a, name: "a2" }, { id: b, name: "B" }] })).toBe(1); // case only
    expect(await edit({ lanes: [{ id: b, name: "B" }, { id: a, name: "a2" }] })).toBe(1);
    expect(await edit({ capacity: 4 })).toBe(1);
    expect(await edit({ lanes: [{ id: b, name: "B" }, { id: a, name: "a2" }, { name: "C" }] })).toBe(1);
    expect(await edit({ lanes: [{ id: b, name: "B" }, { id: a, name: "a2" }] })).toBe(1);
    expect(await edit({ capacity: 1, lanes: [{ id: a, name: "a2" }] })).toBe(1); // two changes in one save: one step
    expect(await edit({ capacity: 1 })).toBe(0);
    expect(await revOf(e.id)).toBe(7);
  });

  it("is also a step when the event has no layout row yet (an event inserted by hand): the row is made", async () => {
    const e = await seedLanes({ lanes: ["A"] });
    await t.env.DB.prepare("DELETE FROM event_layout WHERE event_id = ?").bind(e.id).run();
    const r = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { capacity: 2 }, 1), []);
    expect(r.kind).toBe("saved");
    expect((await layoutRows(e.id)).layout).toEqual({ capacity: 2, config_rev: 1 });
  });

  it("returns the event with its new lanes, capacity and revision", async () => {
    const e = await seedLanes({ lanes: ["A"] });
    const r = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: lanesOf(e, ["A", "B"]), capacity: 2 }), []);
    expect(r.kind).toBe("saved");
    if (r.kind !== "saved") return;
    expect(r.event).toMatchObject({ capacity: 2, configRev: 1 });
    expect(r.event.lanes.map((l) => l.name)).toEqual(["A", "B"]);
    expect(r.event).toEqual(await load(e.slug));
  });
});

describe("saveEventEdit: the clash diff", () => {
  /** Ring 1 and Ring 2, capacity 3, 4 slots. Returns the helpers and ids of the bookings made. */
  async function crowd() {
    const e = await seedLanes({ lanes: ["Ring 1", "Ring 2"], capacity: 3 });
    const [r1, r2] = e.laneIds;
    const book = async (slot: string, lane: number, dog: string, created: string, place?: number) => {
      const id = await insertBooking(t.env.DB, e.id, slot, dog, "H", { laneId: lane, place });
      await bookedAt(id, created);
      return id;
    };
    return { ...e, r1, r2, book };
  }
  const idsOf = (r: Awaited<ReturnType<typeof saveEventEdit>>) => (r.kind === "bookings_affected" ? r.affected.map((b) => b.id) : []);

  it("lowering the capacity with room: nobody is affected, and places are renumbered down so they stay 1..n", async () => {
    const c = await crowd();
    const a = await c.book(S[0], c.r1, "A", "2026-09-01T10:00:00Z", 1);
    const b = await c.book(S[0], c.r1, "B", "2026-09-01T10:01:00Z", 3); // place 2 was cleared
    const x = await c.book(S[1], c.r1, "X", "2026-09-01T10:02:00Z", 2); // the only one in its group, at place 2
    const y = await c.book(S[0], c.r2, "Y", "2026-09-01T10:03:00Z", 1);
    const result = await saveEventEdit(t.env.DB, await load(c.slug), draftFor(c, { capacity: 2 }), []);
    expect(result).toMatchObject({ kind: "saved", removed: [] });
    expect(await placesOf(c.id)).toEqual([
      { id: a, lane_id: c.r1, slot_start_utc: S[0], place: 1 }, { id: b, lane_id: c.r1, slot_start_utc: S[0], place: 2 },
      { id: y, lane_id: c.r2, slot_start_utc: S[0], place: 1 }, { id: x, lane_id: c.r1, slot_start_utc: S[1], place: 1 },
    ].sort((p, q) => (p.slot_start_utc < q.slot_start_utc ? -1 : p.slot_start_utc > q.slot_start_utc ? 1 : p.lane_id - q.lane_id || p.place - q.place)));
    expect((await layoutRows(c.id)).layout).toEqual({ capacity: 2, config_rev: 1 });
  });

  it("lowering the capacity without room: only the bookings that don't fit are affected, the latest made first, ties by id", async () => {
    const c = await crowd();
    const first = await c.book(S[0], c.r1, "First", "2026-09-01T10:00:00Z", 2); // earliest booked, though at place 2
    const second = await c.book(S[0], c.r1, "Second", "2026-09-01T10:05:00Z", 1);
    const tieA = await c.book(S[0], c.r1, "TieA", "2026-09-01T10:09:00Z", 3);
    const tieB = await c.book(S[1], c.r1, "TieB", "2026-09-01T10:00:00Z", 1);
    const tieC = await c.book(S[1], c.r1, "TieC", "2026-09-01T10:00:00Z", 2);
    const fine = await c.book(S[0], c.r2, "Fine", "2026-09-01T10:00:00Z", 1);
    const before = await placesOf(c.id);
    const refused = await saveEventEdit(t.env.DB, await load(c.slug), draftFor(c, { capacity: 2 }), []);
    expect(refused).toMatchObject({ kind: "bookings_affected" });
    expect(idsOf(refused)).toEqual([tieA]); // Ring 1 at S[0] has 3 for 2 places; the latest made goes. S[1] has exactly 2.
    expect(await placesOf(c.id)).toEqual(before);
    expect((await layoutRows(c.id)).layout).toEqual({ capacity: 3, config_rev: 0 });
    const saved = await saveEventEdit(t.env.DB, await load(c.slug), draftFor(c, { capacity: 2 }), [tieA]);
    expect(saved).toMatchObject({ kind: "saved", removed: [{ id: tieA, lane: { id: c.r1, name: "Ring 1" } }] });
    // Second was at place 1 and First at place 2: their order stays, now 1 and 2.
    expect((await placesOf(c.id)).filter((r) => r.slot_start_utc === S[0] && r.lane_id === c.r1).map((r) => [r.id, r.place])).toEqual([[second, 1], [first, 2]]);
    // The other groups are untouched apart from the renumbering: exactly 2 at S[1] and one in Ring 2.
    expect((await placesOf(c.id)).filter((r) => [tieB, tieC, fine].includes(r.id)).map((r) => [r.id, r.place])).toEqual([[fine, 1], [tieB, 1], [tieC, 2]]);
  });

  it("flags the later id when two bookings were made at the same instant", async () => {
    const c = await crowd();
    await c.book(S[0], c.r1, "One", "2026-09-01T10:00:00Z", 1);
    const t2 = await c.book(S[0], c.r1, "Two", "2026-09-01T10:00:00Z", 2);
    const t3 = await c.book(S[0], c.r1, "Three", "2026-09-01T10:00:00Z", 3);
    expect(idsOf(await saveEventEdit(t.env.DB, await load(c.slug), draftFor(c, { capacity: 1 }), []))).toEqual([t2, t3]);
  });

  it("a slot removed, a lane removed and a capacity lowered at once: each stranded booking is listed once, in slot, lane, place order", async () => {
    const c = await crowd();
    const gone = await c.book(S[3], c.r1, "SlotGone", "2026-09-01T10:00:00Z"); // the slot leaves (end 09:45)
    const laneGone = await c.book(S[0], c.r2, "LaneGone", "2026-09-01T10:00:00Z"); // Ring 2 is removed
    const slotAndLane = await c.book(S[3], c.r2, "Both", "2026-09-01T10:00:00Z");
    const over1 = await c.book(S[1], c.r1, "Over1", "2026-09-01T10:00:00Z");
    const over2 = await c.book(S[1], c.r1, "Over2", "2026-09-01T10:01:00Z");
    const stays = await c.book(S[2], c.r1, "Stays", "2026-09-01T10:00:00Z");
    const draft = draftFor(c, { end: "09:45", lanes: [{ id: c.r1, name: "Ring 1" }], capacity: 1 });
    const refused = await saveEventEdit(t.env.DB, await load(c.slug), draft, []);
    expect(idsOf(refused)).toEqual([laneGone, over2, gone, slotAndLane]); // by slot, then lane, then place; each once
    const all = new Set(idsOf(refused));
    const saved = await saveEventEdit(t.env.DB, await load(c.slug), draft, [...all]);
    expect(saved.kind).toBe("saved");
    expect((await placesOf(c.id)).map((r) => r.id).sort()).toEqual([over1, stays].sort());
    expect((await layoutRows(c.id)).lanes.map((l) => l.id)).toEqual([c.r1]);
    expect((await layoutRows(c.id)).layout).toEqual({ capacity: 1, config_rev: 1 });
  });

  it("refuses unless every stranded booking is confirmed, changing nothing; confirmed ids that aren't stranded are left alone", async () => {
    const c = await crowd();
    const a = await c.book(S[0], c.r1, "A", "2026-09-01T10:00:00Z");
    const b = await c.book(S[0], c.r1, "B", "2026-09-01T10:01:00Z");
    const d = await c.book(S[0], c.r2, "D", "2026-09-01T10:00:00Z");
    const gone = await c.book(S[3], c.r1, "Gone", "2026-09-01T10:00:00Z");
    const draft = draftFor(c, { end: "09:45", capacity: 1 });
    const before = await snapshot(c.id);
    expect(idsOf(await saveEventEdit(t.env.DB, await load(c.slug), draft, [gone]))).toEqual([b, gone]); // b is stranded too, and not confirmed
    expect(await snapshot(c.id)).toBe(before);
    // Confirming the stranded ones plus a booking that is not stranded (a stale or sloppy confirmation) removes only the stranded.
    const saved = await saveEventEdit(t.env.DB, await load(c.slug), draft, [b, gone, a, d, 999999]);
    expect(saved).toMatchObject({ kind: "saved" });
    expect(saved.kind === "saved" && saved.removed.map((r) => r.id).sort()).toEqual([b, gone].sort());
    expect((await placesOf(c.id)).map((r) => r.id).sort()).toEqual([a, d].sort());
  });

  it("raising the capacity strands nobody, renumbers nothing and leaves places as they are", async () => {
    const c = await crowd();
    await c.book(S[0], c.r1, "A", "2026-09-01T10:00:00Z", 1);
    await c.book(S[0], c.r1, "B", "2026-09-01T10:01:00Z", 3);
    const before = await placesOf(c.id);
    expect((await saveEventEdit(t.env.DB, await load(c.slug), draftFor(c, { capacity: 5 }), [])).kind).toBe("saved");
    expect(await placesOf(c.id)).toEqual(before);
  });

  it("renumbers every lane and time at once without a UNIQUE clash, keeping each group's order (many groups, places up to the old capacity)", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: S[0], endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 15, lanes: ["A", "B"], capacity: 6 });
    const expected = new Map<number, number>();
    for (const slot of S) for (const lane of e.laneIds) {
      // places 2, 4 and 6 are taken: after lowering to 3 they must become 1, 2, 3
      for (const place of [6, 2, 4]) expected.set(await insertBooking(t.env.DB, e.id, slot, `D${expected.size}`, "H", { laneId: lane, place }), place === 2 ? 1 : place === 4 ? 2 : 3);
    }
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { capacity: 3 }, 6), []);
    expect(result).toMatchObject({ kind: "saved", removed: [] });
    expect(new Map((await placesOf(e.id)).map((r) => [r.id, r.place]))).toEqual(expected);
  });

  it("a lowered capacity with the schedule shortened: bookings on removed slots are removed, the rest renumbered", async () => {
    const c = await crowd();
    const a = await c.book(S[0], c.r1, "A", "2026-09-01T10:00:00Z", 3);
    const gone = await c.book(S[3], c.r1, "Gone", "2026-09-01T10:00:00Z", 1);
    const saved = await saveEventEdit(t.env.DB, await load(c.slug), draftFor(c, { end: "09:45", capacity: 1 }), [gone]);
    expect(saved.kind).toBe("saved");
    expect(await placesOf(c.id)).toEqual([{ id: a, lane_id: c.r1, slot_start_utc: S[0], place: 1 }]);
  });
});

describe("saveEventEdit: races on the layout", () => {
  it("a booking that lands in a group the lowered capacity can't hold aborts the batch, writing nothing, and the newcomer is listed", async () => {
    const e = await seedLanes({ lanes: ["Ring 1"], capacity: 2 });
    const keep = await insertBooking(t.env.DB, e.id, S[0], "Keep", "H", { laneId: e.laneIds[0] });
    await t.env.DB.prepare("UPDATE bookings SET created_at = '2026-09-01T10:00:00Z' WHERE id = ?").bind(keep).run();
    let newcomer = 0;
    const before = await snapshot(e.id);
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { capacity: 1 }, 2), [], {
      afterRead: async () => { newcomer = await insertBooking(t.env.DB, e.id, S[0], "Late", "H", { laneId: e.laneIds[0] }); },
    });
    expect(result).toMatchObject({ kind: "bookings_affected", affected: [{ id: newcomer, fields: [{ label: "Dog", value: "Late" }, { label: "Handler", value: expect.any(String) }] }] });
    expect(JSON.parse(await snapshot(e.id))[0]).toEqual(JSON.parse(before)[0]);
    expect((await layoutRows(e.id)).layout).toEqual({ capacity: 2, config_rev: 0 });
    expect((await placesOf(e.id)).map((r) => r.id)).toEqual([keep, newcomer]);
  });

  it("a booking that lands in a lane being removed aborts the batch with the newcomer listed", async () => {
    const e = await seedLanes({ lanes: ["Ring 1", "Ring 2"] });
    let newcomer = 0;
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: e.laneIds[0], name: "Ring 1" }] }), [], {
      afterRead: async () => { newcomer = await insertBooking(t.env.DB, e.id, S[1], "Late", "H", { laneId: e.laneIds[1] }); },
    });
    expect(result).toMatchObject({ kind: "bookings_affected", affected: [{ id: newcomer, lane: { id: e.laneIds[1], name: "Ring 2" } }] });
    expect((await layoutRows(e.id)).lanes).toHaveLength(2);
  });

  it("a booking that lands in a lane that stays, within capacity, saves normally", async () => {
    const e = await seedLanes({ lanes: ["Ring 1", "Ring 2"] });
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: e.laneIds[0], name: "Ring 1" }], capacity: 2 }), [], {
      afterRead: async () => { await insertBooking(t.env.DB, e.id, S[1], "Late", "H", { laneId: e.laneIds[0] }); },
    });
    expect(result.kind).toBe("saved");
    expect((await placesOf(e.id)).map((r) => r.place)).toEqual([1]);
  });

  it("a confirmed booking that moved after the read is not removed from its new place: the read is repeated and it is no longer stranded", async () => {
    const e = await seedLanes({ lanes: ["Ring 1"] });
    const mover = await insertBooking(t.env.DB, e.id, S[3], "Mover", "H", { laneId: e.laneIds[0] });
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { end: "09:45" }), [mover], {
      afterRead: async () => { await t.env.DB.prepare("UPDATE bookings SET slot_start_utc = ? WHERE id = ?").bind(S[0], mover).run(); },
    });
    expect(result).toMatchObject({ kind: "saved", removed: [] });
    expect((await placesOf(e.id)).map((r) => [r.id, r.slot_start_utc])).toEqual([[mover, S[0]]]);
  });

  it("a confirmed booking that was swapped to another place after the read is listed again if it is still stranded", async () => {
    const e = await seedLanes({ lanes: ["Ring 1"], capacity: 2 });
    const a = await insertBooking(t.env.DB, e.id, S[0], "A", "H", { laneId: e.laneIds[0], place: 1 });
    const b = await insertBooking(t.env.DB, e.id, S[0], "B", "H", { laneId: e.laneIds[0], place: 2 });
    await t.env.DB.prepare("UPDATE bookings SET created_at = '2026-09-01T10:00:00Z' WHERE id = ?").bind(a).run();
    await t.env.DB.prepare("UPDATE bookings SET created_at = '2026-09-01T10:05:00Z' WHERE id = ?").bind(b).run();
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { capacity: 1 }, 2), [b], {
      afterRead: async () => {
        await t.env.DB.batch([
          t.env.DB.prepare("UPDATE bookings SET place = 9 WHERE id = ?").bind(a),
          t.env.DB.prepare("UPDATE bookings SET place = 1 WHERE id = ?").bind(b),
          t.env.DB.prepare("UPDATE bookings SET place = 2 WHERE id = ?").bind(a),
        ]);
      },
    });
    // b moved from place 2 to 1 under the edit's feet: the batch aborted, the read was repeated, b is still the later booking, and is removed.
    expect(result).toMatchObject({ kind: "saved", removed: [{ id: b }] });
    expect((await placesOf(e.id)).map((r) => [r.id, r.place])).toEqual([[a, 1]]);
  });

  it("another admin editing the lanes first makes a draft that sends lanes fail with layout_changed, writing nothing", async () => {
    const e = await seedLanes({ lanes: ["Ring 1", "Ring 2"] });
    const stale = await load(e.slug);
    expect((await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: e.laneIds[0], name: "Renamed" }, { id: e.laneIds[1], name: "Ring 2" }] }), [])).kind).toBe("saved");
    const before = await snapshot(e.id);
    const result = await saveEventEdit(t.env.DB, stale, draftFor(e, { name: "Stale save", lanes: [{ id: e.laneIds[0], name: "Mine" }, { id: e.laneIds[1], name: "Ring 2" }] }), []);
    expect(result).toEqual({ kind: "layout_changed" });
    expect(await snapshot(e.id)).toBe(before);
    expect((await layoutRows(e.id)).lanes.map((l) => l.name)).toEqual(["Renamed", "Ring 2"]);
  });

  it("the same, when only the capacity is sent, and when the stale draft sends a lane that was deleted meanwhile", async () => {
    const e = await seedLanes({ lanes: ["Ring 1", "Ring 2"] });
    const stale = await load(e.slug);
    await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: e.laneIds[0], name: "Ring 1" }] }), []);
    expect(await saveEventEdit(t.env.DB, stale, draftFor(e, { capacity: 2 }), [])).toEqual({ kind: "layout_changed" });
    expect(await saveEventEdit(t.env.DB, stale, draftFor(e, { lanes: [{ id: e.laneIds[1], name: "Ring 2" }] }), [])).toEqual({ kind: "layout_changed" });
  });

  it("a draft that doesn't send the layout saves over a changed layout (last write wins on the other fields) and leaves the layout alone", async () => {
    const e = await seedLanes({ lanes: ["Ring 1", "Ring 2"] });
    const stale = await load(e.slug);
    await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: e.laneIds[0], name: "Renamed" }, { id: e.laneIds[1], name: "Ring 2" }] }), []);
    const result = await saveEventEdit(t.env.DB, stale, draftFor(e, { name: "Only the name" }), []);
    expect(result.kind).toBe("saved");
    expect((await layoutRows(e.id)).lanes.map((l) => l.name)).toEqual(["Renamed", "Ring 2"]);
    expect((await load(e.slug)).name).toBe("Only the name");
  });

  it("the event deleted between the read and the save: not_found, nothing written, for a draft with lanes too", async () => {
    const e = await seedLanes();
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: e.laneIds[0], name: "X" }], capacity: 2 }), [], {
      afterRead: async () => { await t.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(e.id).run(); },
    });
    expect(result).toEqual({ kind: "not_found" });
    expect(await t.env.DB.prepare("SELECT COUNT(*) AS n FROM event_lanes WHERE event_id = ?").bind(e.id).first()).toEqual({ n: 0 });
  });
});

describe("an edit of the layout racing the booking tools", () => {
  const input = (event: Awaited<ReturnType<typeof load>>, slot: string, dog: string) => {
    const r = validateBookingInput({ slot, laneId: event.lanes[0].id, field1: dog, field2: "H", idempotencyKey: `idem-${dog}-aaaaaaaaaaaaaaaaaaaa` }, event);
    if (!("slot" in r)) throw new Error(JSON.stringify(r));
    return r;
  };
  const renameLane = async (e: Awaited<ReturnType<typeof seedLanes>>) =>
    saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { lanes: [{ id: e.laneIds[0], name: "Renamed" }, { id: e.laneIds[1], name: "Ring 2" }] }), []);

  it("a public booking that read the layout before the edit fails its guard and writes nothing", async () => {
    const e = await seedLanes();
    const event = await load(e.slug);
    expect((await renameLane(e)).kind).toBe("saved");
    const result = await createBooking(t.env.DB, event, { start: S[0], end: S[1] }, input(event, S[0], "Rex"), NOW);
    expect(result).toEqual({ kind: "schedule_changed" });
    expect(await placesOf(e.id)).toEqual([]);
  });

  it("the edit landing between the booking's read and its insert (inside the booking's own batch) aborts that insert", async () => {
    const e = await seedLanes();
    const event = await load(e.slug);
    let edited = false;
    const racing = interceptBatches(t.env.DB, async (sqls, run) => {
      if (insertsBooking(sqls) && !edited) { edited = true; expect((await renameLane(e)).kind).toBe("saved"); }
      return run();
    });
    const result = await createBooking(racing, event, { start: S[0], end: S[1] }, input(event, S[0], "Rex"), NOW);
    expect(edited).toBe(true);
    expect(result).toEqual({ kind: "schedule_changed" });
    expect(await placesOf(e.id)).toEqual([]);
  });

  it("a public booking made after the edit's read, into a group the edit lowers, is listed and nothing is written", async () => {
    const e = await seedLanes({ lanes: ["Ring 1"], capacity: 2 });
    const event = await load(e.slug);
    const first = await createBooking(t.env.DB, event, { start: S[0], end: S[1] }, input(event, S[0], "First"), NOW);
    expect(first.kind).toBe("created");
    let late: Awaited<ReturnType<typeof createBooking>> | undefined;
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { capacity: 1 }, 2), [], {
      afterRead: async () => { late = await createBooking(t.env.DB, event, { start: S[0], end: S[1] }, input(event, S[0], "Late"), NOW); },
    });
    expect(late?.kind).toBe("created");
    expect(result).toMatchObject({ kind: "bookings_affected", affected: [{ fields: [{ label: "Dog", value: "Late" }, { label: "Handler", value: expect.any(String) }] }] });
    expect((await layoutRows(e.id)).layout).toEqual({ capacity: 2, config_rev: 0 });
  });

  it("an admin add that read the layout before the edit is refused as event_changed, and so is a move", async () => {
    const e = await seedLanes();
    const event = await load(e.slug);
    const moving = await insertBooking(t.env.DB, e.id, S[0], "Mover", "H", { laneId: e.laneIds[0] });
    expect((await renameLane(e)).kind).toBe("saved");
    expect(await addBooking(t.env.DB, event, { slot: S[1], laneId: e.laneIds[0], field1: "Rex", field2: "Sam" })).toMatchObject({ code: "event_changed", status: 409 });
    expect(await moveBooking(t.env.DB, event, moving, { fromSlot: S[0], toSlot: S[1] })).toMatchObject({ code: "event_changed", status: 409 });
    expect((await placesOf(e.id)).map((r) => r.slot_start_utc)).toEqual([S[0]]);
  });

  it("an edit racing an admin move (the edit lands between the move's read and its batch): the move fails with event_changed and nothing moved", async () => {
    const e = await seedLanes();
    const event = await load(e.slug);
    const moving = await insertBooking(t.env.DB, e.id, S[0], "Mover", "H", { laneId: e.laneIds[0] });
    const result = await moveBooking(t.env.DB, event, moving, { fromSlot: S[0], toSlot: S[1] }, { afterRead: async () => { await renameLane(e); } });
    expect(result).toMatchObject({ code: "event_changed", status: 409 });
    expect((await placesOf(e.id)).map((r) => r.slot_start_utc)).toEqual([S[0]]);
  });

  it("an edit racing an admin add: the add fails with event_changed and writes nothing", async () => {
    const e = await seedLanes();
    const event = await load(e.slug);
    const result = await addBooking(t.env.DB, event, { slot: S[1], laneId: e.laneIds[0], field1: "Rex", field2: "Sam" }, { afterRead: async () => { await renameLane(e); } });
    expect(result).toMatchObject({ code: "event_changed", status: 409 });
    expect(await placesOf(e.id)).toEqual([]);
  });

  it("an edit that changes nothing in the layout does not stop a booking that read the event before it", async () => {
    const e = await seedLanes();
    const event = await load(e.slug);
    expect((await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { name: "Renamed event", costPence: 100 }), [])).kind).toBe("saved");
    expect((await createBooking(t.env.DB, event, { start: S[0], end: S[1] }, input(event, S[0], "Rex"), NOW)).kind).toBe("created");
  });
});

describe("saveEventEdit: the booking form's fields and the identity limit", () => {
  const F = (label: string, over: Record<string, unknown> = {}) => ({ label, required: true, maxLength: 80, identity: false, ...over });
  const RIDER_PONY = [F("Rider", { identity: true }), F("Pony", { identity: true }), F("Phone", { required: false, maxLength: 12 })];

  async function seedForm(o: Pick<NonNullable<Parameters<typeof insertEvent>[1]>, "fields" | "identityLimit"> = {}) {
    return insertEvent(t.env.DB, { startUtc: S[0], endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 15, ...o });
  }
  const edit = async (e: { slug: string; laneIds: number[] }, over: Record<string, unknown>, remove: number[] = [], hooks = {}) =>
    saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, over, 1), remove, hooks);
  const formOf = async (id: number) => (await t.env.DB.prepare("SELECT position, label, required, max_length, in_identity FROM event_fields WHERE event_id = ? ORDER BY position").bind(id).all()).results;
  const revOf = async (id: number) => (await layoutRows(id)).layout!.config_rev;
  const limitOf = async (id: number) => (await t.env.DB.prepare("SELECT identity_limit FROM event_layout WHERE event_id = ?").bind(id).first<{ identity_limit: number }>())!.identity_limit;

  it("replaces the fields as a whole, in order, and returns the event with them", async () => {
    const e = await seedForm();
    const r = await edit(e, { fields: RIDER_PONY });
    expect(r.kind).toBe("saved");
    expect(await formOf(e.id)).toEqual([
      { position: 1, label: "Rider", required: 1, max_length: 80, in_identity: 1 },
      { position: 2, label: "Pony", required: 1, max_length: 80, in_identity: 1 },
      { position: 3, label: "Phone", required: 0, max_length: 12, in_identity: 0 },
    ]);
    if (r.kind !== "saved") return;
    expect(r.event.fields).toEqual([
      { position: 1, label: "Rider", required: true, maxLength: 80, identity: true },
      { position: 2, label: "Pony", required: true, maxLength: 80, identity: true },
      { position: 3, label: "Phone", required: false, maxLength: 12, identity: false },
    ]);
    expect(r.event).toEqual(await load(e.slug));
  });

  it("leaves the fields and the limit alone when the draft doesn't send them", async () => {
    const e = await seedForm({ identityLimit: 3 });
    expect((await edit(e, { name: "Only the name" })).kind).toBe("saved");
    expect((await formOf(e.id)).map((f) => f.label)).toEqual(["Dog", "Handler"]);
    expect(await limitOf(e.id)).toBe(3);
    expect(await revOf(e.id)).toBe(0);
  });

  describe("the revision (config_rev)", () => {
    it("goes up for a changed number of fields, identity set, required flag, longest value or identity limit, and not for a label or the same form again", async () => {
      const e = await seedForm();
      const step = async (over: Record<string, unknown>) => {
        const before = await revOf(e.id);
        expect((await edit(e, over)).kind, JSON.stringify(over)).toBe("saved");
        return (await revOf(e.id)) - before;
      };
      const dog = F("Dog", { identity: true }), handler = F("Handler", { identity: true });
      expect(await step({ fields: [dog, handler] })).toBe(0); // the same form again
      expect(await step({ fields: [F("Horse", { identity: true }), F("Rider", { identity: true })] })).toBe(0); // labels only
      expect(await step({ fields: [F("Horse", { identity: true }), F("Rider", { identity: true }), F("Notes", { required: false })] })).toBe(1); // a field added
      expect(await step({ fields: [F("Horse", { identity: true }), F("Rider", { identity: true }), F("Notes", { required: true })] })).toBe(1); // required
      expect(await step({ fields: [F("Horse", { identity: true }), F("Rider", { identity: true }), F("Notes", { maxLength: 10 })] })).toBe(1); // longest value
      expect(await step({ fields: [F("Horse", { identity: true }), F("Rider"), F("Notes", { maxLength: 10 })] })).toBe(1); // identity set
      expect(await step({ identityLimit: 4 })).toBe(1);
      expect(await step({ identityLimit: 4 })).toBe(0);
      expect(await step({ fields: [F("Horse", { identity: true })], identityLimit: 2 })).toBe(1); // two changes, one step
      expect(await revOf(e.id)).toBe(6);
    });

    it("makes a booking that read the form before the edit fail its guard and write nothing", async () => {
      const e = await seedForm();
      const stale = await load(e.slug);
      expect((await edit(e, { fields: [F("Dog", { identity: true }), F("Handler", { identity: false, required: false })] })).kind).toBe("saved");
      const r = validateBookingInput({ slot: S[0], laneId: e.laneId, field1: "Rex", field2: "Sam", idempotencyKey: "k".repeat(22) }, stale);
      if (!("values" in r)) throw new Error(JSON.stringify(r));
      expect(await createBooking(t.env.DB, stale, { start: S[0], end: S[1] }, r, NOW)).toEqual({ kind: "schedule_changed" });
      expect(await placesOf(e.id)).toEqual([]);
    });

    it("does not stop a booking that read the form before a label-only edit", async () => {
      const e = await seedForm();
      const stale = await load(e.slug);
      expect((await edit(e, { fields: [F("Hound", { identity: true }), F("Handler", { identity: true })] })).kind).toBe("saved");
      const r = validateBookingInput({ slot: S[0], laneId: e.laneId, field1: "Rex", field2: "Sam", idempotencyKey: "k".repeat(22) }, stale);
      if (!("values" in r)) throw new Error(JSON.stringify(r));
      expect((await createBooking(t.env.DB, stale, { start: S[0], end: S[1] }, r, NOW)).kind).toBe("created");
    });
  });

  describe("an event with no bookings", () => {
    it("may change the number of fields and the identity fields freely", async () => {
      const e = await seedForm();
      expect((await edit(e, { fields: [F("Car reg", { identity: true })] })).kind).toBe("saved");
      expect((await formOf(e.id)).map((f) => f.label)).toEqual(["Car reg"]);
      expect((await edit(e, { fields: [F("Rider"), F("Pony", { identity: true })] })).kind).toBe("saved");
      expect((await formOf(e.id)).map((f) => [f.label, f.in_identity])).toEqual([["Rider", 0], ["Pony", 1]]);
    });

    it("swaps two labels without meeting the unique label index half-way", async () => {
      const e = await seedForm();
      expect((await edit(e, { fields: [F("Handler", { identity: true }), F("Dog", { identity: true })] })).kind).toBe("saved");
      expect((await formOf(e.id)).map((f) => f.label)).toEqual(["Handler", "Dog"]);
    });
  });

  describe("an event with bookings: fields_locked", () => {
    async function booked() {
      const e = await seedForm({ fields: RIDER_PONY.map(({ label, required, maxLength, identity }) => ({ label, required, maxLength, identity })) });
      await insertBooking(t.env.DB, e.id, S[0], "Ann", "Biscuit");
      return e;
    }

    it("refuses a changed number of fields and a changed identity set, writing nothing", async () => {
      const e = await booked();
      const before = await snapshot(e.id);
      const form = await formOf(e.id);
      for (const fields of [
        [F("Rider", { identity: true }), F("Pony", { identity: true })], // one fewer
        [...RIDER_PONY, F("Notes", { required: false })], // one more
        [F("Rider", { identity: true }), F("Pony"), F("Phone", { required: false, maxLength: 12 })], // another identity set
        [F("Rider", { identity: true }), F("Pony", { identity: true }), F("Phone", { identity: true })], // a third identity field
      ]) {
        expect(await edit(e, { name: "Not saved", fields }), JSON.stringify(fields)).toEqual({ kind: "fields_locked" });
      }
      expect(await snapshot(e.id)).toBe(before);
      expect(await formOf(e.id)).toEqual(form);
      expect(await revOf(e.id)).toBe(0);
    });

    it("still lets labels, required flags, longest values and the identity limit change, and bumps config_rev for what matters", async () => {
      const e = await booked();
      const r = await edit(e, { name: "Saved", identityLimit: 2, fields: [F("Horse rider", { identity: true }), F("Pony name", { identity: true, maxLength: 30 }), F("Mobile", { required: true, maxLength: 15 })] });
      expect(r.kind).toBe("saved");
      expect((await formOf(e.id)).map((f) => [f.label, f.required, f.max_length, f.in_identity])).toEqual([
        ["Horse rider", 1, 80, 1], ["Pony name", 1, 30, 1], ["Mobile", 1, 15, 0],
      ]);
      expect(await limitOf(e.id)).toBe(2);
      expect(await revOf(e.id)).toBe(1);
      expect((await load(e.slug)).name).toBe("Saved");
    });

    it("lets a draft that doesn't send the fields save, whatever the bookings", async () => {
      const e = await booked();
      expect((await edit(e, { name: "Fine" })).kind).toBe("saved");
    });

    it("says fields_locked rather than listing stranded bookings, and a send of the same shape is not locked", async () => {
      const e = await booked();
      expect(await edit(e, { end: "09:30", fields: [F("Rider", { identity: true })] })).toEqual({ kind: "fields_locked" });
      expect((await edit(e, { fields: RIDER_PONY.map((f) => ({ ...f })) })).kind).toBe("saved");
    });

    it("stops a booking that lands between the read and the save too: the batch writes nothing and the answer is fields_locked", async () => {
      const e = await seedForm();
      const before = await snapshot(e.id);
      const result = await edit(e, { name: "Not saved", fields: [F("Car reg", { identity: true })] }, [], {
        afterRead: async () => { await insertBooking(t.env.DB, e.id, S[1], "Rex", "Sam"); },
      });
      expect(result).toEqual({ kind: "fields_locked" });
      expect(JSON.parse(await snapshot(e.id))[0]).toEqual(JSON.parse(before)[0]);
      expect((await formOf(e.id)).map((f) => f.label)).toEqual(["Dog", "Handler"]);
      expect(await revOf(e.id)).toBe(0);
    });

    it("stops the removal of the last booking in the same save: clear the booking first, then change the form", async () => {
      const e = await booked();
      expect(await edit(e, { fields: [F("Car reg", { identity: true })] }, [(await placesOf(e.id))[0].id])).toEqual({ kind: "fields_locked" });
      expect(await placesOf(e.id)).toHaveLength(1);
    });
  });

  it("makes a draft that sends the fields fail with layout_changed when the form was edited after the event was read", async () => {
    const e = await seedForm();
    const stale = await load(e.slug);
    expect((await edit(e, { fields: [F("Dog", { identity: true }), F("Handler", { identity: true }), F("Notes", { required: false })] })).kind).toBe("saved");
    const before = await snapshot(e.id);
    expect(await saveEventEdit(t.env.DB, stale, draftFor(e, { name: "Stale", fields: [F("Mine", { identity: true })] }, 1), [])).toEqual({ kind: "layout_changed" });
    expect(await saveEventEdit(t.env.DB, stale, draftFor(e, { name: "Stale", identityLimit: 5 }, 1), [])).toEqual({ kind: "layout_changed" });
    expect(await snapshot(e.id)).toBe(before);
    expect((await formOf(e.id)).map((f) => f.label)).toEqual(["Dog", "Handler", "Notes"]);
  });

  it("lists a stranded booking with its labelled values", async () => {
    const e = await seedForm({ fields: [{ label: "Rider", identity: true }, { label: "Pony", identity: true }, { label: "Phone", required: false }] });
    await insertBookingOf(t.env.DB, e.id, [{ label: "Rider", identity: true }, { label: "Pony", identity: true }, { label: "Phone" }], S[3], ["Ann", "Biscuit", "111"]);
    const r = await edit(e, { end: "09:30" });
    expect(r).toMatchObject({ kind: "bookings_affected", affected: [{ fields: [{ label: "Rider", value: "Ann" }, { label: "Pony", value: "Biscuit" }, { label: "Phone", value: "111" }] }] });
  });
});

describe("saveEventEdit: the revision of the page the draft was made on", () => {
  const F = (label: string, over: Record<string, unknown> = {}) => ({ label, required: true, maxLength: 80, identity: false, ...over });
  const KINDS: Record<string, (e: { laneIds: number[] }) => Record<string, unknown>> = {
    lanes: (e) => ({ lanes: [{ id: e.laneIds[0], name: "Mine" }, { id: e.laneIds[1], name: "Ring 2" }] }),
    capacity: () => ({ capacity: 2 }),
    fields: () => ({ fields: [F("Horse", { identity: true, maxLength: 40 }), F("Rider", { identity: true })] }),
    identityLimit: () => ({ identityLimit: 3 }),
  };
  const everything = async (id: number) => JSON.stringify([
    await snapshot(id), await layoutRows(id),
    (await t.env.DB.prepare("SELECT * FROM event_fields WHERE event_id = ? ORDER BY position").bind(id).all()).results,
    (await t.env.DB.prepare("SELECT identity_limit FROM event_layout WHERE event_id = ?").bind(id).first()),
  ]);

  it.each(Object.keys(KINDS))("refuses a draft with %s made on an older revision (layout_changed) before reading or writing anything", async (key) => {
    const e = await seedLanes();
    await t.env.DB.prepare("UPDATE event_layout SET config_rev = 1 WHERE event_id = ?").bind(e.id).run(); // someone else's edit
    const before = await everything(e.id);
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { ...KINDS[key](e), configRev: 0 }), []);
    expect(result.kind).toBe("layout_changed");
    expect(await everything(e.id)).toBe(before);
  });

  it.each(Object.keys(KINDS))("saves a draft with %s made on the current revision, and raises it", async (key) => {
    const e = await seedLanes();
    await t.env.DB.prepare("UPDATE event_layout SET config_rev = 4 WHERE event_id = ?").bind(e.id).run();
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { ...KINDS[key](e), configRev: 4 }), []);
    expect(result.kind).toBe("saved");
    expect(result.kind === "saved" && result.event.configRev).toBe(5);
    expect((await layoutRows(e.id)).layout!.config_rev).toBe(5);
  });

  it("compares the revision the draft carries inside the batch: an edit that lands after the read refuses it, writing nothing", async () => {
    const e = await seedLanes();
    const before = await everything(e.id);
    const result = await saveEventEdit(t.env.DB, await load(e.slug), draftFor(e, { capacity: 2, configRev: 0 }), [], {
      afterRead: async () => { await t.env.DB.prepare("UPDATE event_layout SET config_rev = config_rev + 1 WHERE event_id = ?").bind(e.id).run(); },
    });
    expect(result.kind).toBe("layout_changed");
    expect(await t.env.DB.prepare("SELECT capacity, config_rev FROM event_layout WHERE event_id = ?").bind(e.id).first()).toEqual({ capacity: 3, config_rev: 1 });
    expect((await everything(e.id)).replace(/"config_rev":\d/g, "")).toBe(before.replace(/"config_rev":\d/g, ""));
  });

  it("does not look at the revision for a draft that sends none of the layout: last write wins, as before", async () => {
    const e = await seedLanes();
    await t.env.DB.prepare("UPDATE event_layout SET config_rev = 9 WHERE event_id = ?").bind(e.id).run();
    const draft = { ...draftFor(e, {}), configRev: 0 };
    expect((await saveEventEdit(t.env.DB, await load(e.slug), draft, [])).kind).toBe("saved");
    expect((await layoutRows(e.id)).layout!.config_rev).toBe(9);
  });
});

describe("eventDetail: the lineup (pasted into a club chat) prints only the fields that identify a booking", () => {
  const SLOT = "2026-10-24T08:00:00Z";
  const lineupOf = async (fields: TestField[], rows: string[][]) => {
    const e = await insertEvent(t.env.DB, { startUtc: SLOT, endUtc: "2026-10-24T08:30:00Z", sessionMinutes: 15, fields, capacity: rows.length });
    for (const values of rows) await insertBookingOf(t.env.DB, e.id, fields, SLOT, values);
    const detail = await eventDetail(t.env.DB, (await loadEventBySlug(t.env.DB, e.slug))!);
    return { detail, lines: detail.lineup.split("\n").slice(3, 3 + rows.length) };
  };

  it("leaves out an optional field that holds a phone number, which the admin pages still show", async () => {
    const { detail, lines } = await lineupOf([{ label: "Dog", identity: true }, { label: "Handler", identity: true }, { label: "Phone", required: false }], [["Rex", "Sam", "07700 900123"]]);
    expect(lines).toEqual(["09:00 — Rex — Sam"]);
    expect(detail.lineup).not.toContain("07700");
    expect(detail.slots[0].places[0].bookings[0].fields).toEqual([{ label: "Dog", value: "Rex" }, { label: "Handler", value: "Sam" }, { label: "Phone", value: "07700 900123" }]);
  });

  it("leaves out a required field that does not identify a booking", async () => {
    const { lines } = await lineupOf([{ label: "Name", identity: true }, { label: "Medical notes" }], [["Ann Lee", "Asthma, carries an inhaler"]]);
    expect(lines).toEqual(["09:00 — Ann Lee"]);
  });

  it("prints the identity fields in the form's order, wherever the other fields sit between them", async () => {
    const fields = [{ label: "Rider", identity: true }, { label: "Phone", required: false }, { label: "Pony", identity: true }, { label: "Notes", required: false }];
    const { lines } = await lineupOf(fields, [["Ann", "07700 900123", "Biscuit", "Nervous"], ["Bea", "", "Nutmeg", ""]]);
    expect(lines).toEqual(["09:00 — Ann — Biscuit", "09:00 — Bea — Nutmeg"]);
  });

  it("prints every field of a form where every field identifies a booking, and keeps the Dog and Handler line as it was", async () => {
    expect((await lineupOf([{ label: "Dog", identity: true }, { label: "Handler", identity: true }], [["Rex", "Sam"]])).lines).toEqual(["09:00 — Rex — Sam"]);
    expect((await lineupOf([{ label: "A", identity: true }, { label: "B", identity: true }, { label: "C", identity: true }], [["x", "y", "z"]])).lines).toEqual(["09:00 — x — y — z"]);
  });

  it("applies to a form of one field and to named lanes", async () => {
    expect((await lineupOf([{ label: "Car reg", identity: true }], [["AB12 CDE"]])).lines).toEqual(["09:00 — AB12 CDE"]);
    const e = await insertEvent(t.env.DB, { startUtc: SLOT, endUtc: "2026-10-24T08:15:00Z", sessionMinutes: 15, lanes: ["Ring 1", "Ring 2"], fields: [{ label: "Dog", identity: true }, { label: "Phone", required: false }] });
    await insertBookingOf(t.env.DB, e.id, [{ label: "Dog", identity: true }, { label: "Phone" }], SLOT, ["Rex", "07700 900123"], { laneId: e.laneIds[1] });
    const detail = await eventDetail(t.env.DB, (await loadEventBySlug(t.env.DB, e.slug))!);
    expect(detail.lineup.split("\n").slice(3)).toEqual(["09:00 Ring 1 — free", "09:00 Ring 2 — Rex"]);
  });
});

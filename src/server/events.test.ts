import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, insertBooking, insertEvent, interceptBatches, type TestEnv } from "../test/db";
import { bookingWindow, computeSlotViews, eventSummary, isSlotBookable, loadEventBySlug, type EventRow } from "./events";

const START = "2026-06-13T08:00:00Z";
const DOG_HANDLER_FIELDS: EventRow["fields"] = [
  { position: 1, label: "Dog", required: true, maxLength: 80, identity: true },
  { position: 2, label: "Handler", required: true, maxLength: 80, identity: true },
];
const event = (o: Partial<EventRow> = {}): EventRow => ({
  id: 1, slug: "x", name: "Test", startUtc: START, endUtc: "2026-06-13T11:00:00Z", sessionMinutes: 15, gapMinutes: 0,
  costPence: 0, venuePostcode: "AB1 2CD", details: "", shareMessage: "", archived: false, listed: true, breaks: [],
  lanes: [{ id: 1, position: 1, name: "" }], fields: DOG_HANDLER_FIELDS, capacity: 1, identityLimit: 1, configRev: 0, ...o,
});
const at = (iso: string) => new Date(iso);

describe("bookingWindow", () => {
  // [offset minutes, now, expected open, expected closesAt]
  it.each([
    [0, "2026-06-13T07:59:59Z", true, "2026-06-13T08:00:00Z"],
    [0, "2026-06-13T08:00:00Z", false, "2026-06-13T08:00:00Z"], // exactly at closing: closed
    [0, "2026-06-13T08:00:01Z", false, "2026-06-13T08:00:00Z"],
    [30, "2026-06-13T08:29:59Z", true, "2026-06-13T08:30:00Z"],
    [30, "2026-06-13T08:30:00Z", false, "2026-06-13T08:30:00Z"],
    [-30, "2026-06-13T07:29:59Z", true, "2026-06-13T07:30:00Z"],
    [-30, "2026-06-13T07:30:00Z", false, "2026-06-13T07:30:00Z"],
    [10080, "2026-06-20T07:59:59Z", true, "2026-06-20T08:00:00Z"],
    [-10080, "2026-06-06T08:00:00Z", false, "2026-06-06T08:00:00Z"],
  ])("offset %d at %s: open=%s", (offset, now, open, closesAt) => {
    expect(bookingWindow(event(), offset, at(now))).toEqual({ open, closesAt });
  });

  it("is never open for an archived event, whatever the time", () => {
    expect(bookingWindow(event({ archived: true }), 0, at("2026-01-01T00:00:00Z")))
      .toEqual({ open: false, closesAt: START });
  });
});

describe("isSlotBookable", () => {
  const SLOT_START = "2026-06-13T08:30:00Z";
  const open = { open: true };

  it.each([
    ["1 s before the slot starts", "2026-06-13T08:29:59Z", true],
    ["exactly at the slot's start", SLOT_START, false],
    ["1 s after the slot starts", "2026-06-13T08:30:01Z", false],
  ])("window open, %s", (_what, now, expected) => {
    expect(isSlotBookable(SLOT_START, open, at(now))).toBe(expected);
  });

  it("is never bookable when the window is closed, even for a future slot", () => {
    expect(isSlotBookable(SLOT_START, { open: false }, at("2026-06-13T07:00:00Z"))).toBe(false);
  });

  it("applies the same rule for a negative, zero and positive offset", () => {
    const now = at("2026-06-13T08:30:00Z"); // exactly the slot's start
    for (const offset of [-30, 0, 60]) {
      expect(isSlotBookable(SLOT_START, bookingWindow(event(), offset, now), now)).toBe(false);
    }
    const before = at("2026-06-13T07:00:00Z");
    expect(isSlotBookable(SLOT_START, bookingWindow(event(), -30, before), before)).toBe(true);
    expect(isSlotBookable(SLOT_START, bookingWindow(event(), 0, before), before)).toBe(true);
    expect(isSlotBookable(SLOT_START, bookingWindow(event(), 60, before), before)).toBe(true);
  });
});

describe("loadEventBySlug and computeSlotViews with lanes and places", () => {
  let t: TestEnv;
  beforeAll(async () => { t = await createTestEnv(); });
  afterAll(async () => { await t.dispose(); });
  const NOW = new Date("2026-06-01T00:00:00Z");
  const DAY = { startUtc: START, endUtc: "2026-06-13T09:00:00Z", sessionMinutes: 15 }; // 08:00 08:15 08:30 08:45

  it("loads the event, its breaks, lanes in order, fields, capacity, identity limit and revision in ONE batch", async () => {
    const e = await insertEvent(t.env.DB, {
      ...DAY, capacity: 3, identityLimit: 2, lanes: ["Ring 2", "Ring 1"],
      fields: [{ label: "Rider", identity: true }, { label: "Pony", identity: true }, { label: "Notes", required: false, maxLength: 20 }],
    });
    await t.env.DB.prepare("UPDATE event_layout SET config_rev = 7 WHERE event_id = ?").bind(e.id).run();
    let batches = 0;
    let singles = 0;
    const counted = interceptBatches(t.env.DB, async (_sqls, run) => { batches++; return run(); });
    const original = counted.prepare.bind(counted);
    (counted as { prepare: unknown }).prepare = (sql: string) => { singles++; return original(sql); };
    const loaded = await loadEventBySlug(counted, e.slug);
    expect(loaded).toMatchObject({
      id: e.id, capacity: 3, identityLimit: 2, configRev: 7,
      lanes: [{ id: e.laneIds[0], position: 1, name: "Ring 2" }, { id: e.laneIds[1], position: 2, name: "Ring 1" }],
      fields: [
        { position: 1, label: "Rider", required: true, maxLength: 80, identity: true },
        { position: 2, label: "Pony", required: true, maxLength: 80, identity: true },
        { position: 3, label: "Notes", required: false, maxLength: 20, identity: false },
      ],
    });
    expect(batches).toBe(1);
    expect(singles).toBe(5); // the five statements of that one batch, and no query of its own
  });

  it("gives an event with no layout row capacity 1, limit 1, revision 0", async () => {
    const e = await insertEvent(t.env.DB, DAY);
    await t.env.DB.prepare("DELETE FROM event_layout WHERE event_id = ?").bind(e.id).run();
    expect(await loadEventBySlug(t.env.DB, e.slug)).toMatchObject({ capacity: 1, identityLimit: 1, configRev: 0, lanes: [{ id: e.laneId, name: "" }] });
  });

  it("repairs a lane-less event with one unnamed lane (see event-layout-repair.test.ts), so it can be booked", async () => {
    const e = await insertEvent(t.env.DB, DAY);
    await t.env.DB.batch([
      t.env.DB.prepare("DELETE FROM event_layout WHERE event_id = ?").bind(e.id),
      t.env.DB.prepare("DELETE FROM event_lanes WHERE event_id = ?").bind(e.id),
    ]);
    expect(await loadEventBySlug(t.env.DB, e.slug)).toMatchObject({ capacity: 1, identityLimit: 1, configRev: 0, lanes: [{ position: 1, name: "" }] });
  });

  it("gives an event with no field rows the Dog and Handler form (an event made by the previous version between the migration and the deploy), and books it as such", async () => {
    const e = await insertEvent(t.env.DB, DAY);
    await t.env.DB.prepare("DELETE FROM event_fields WHERE event_id = ?").bind(e.id).run();
    expect((await loadEventBySlug(t.env.DB, e.slug))!.fields).toEqual(DOG_HANDLER_FIELDS);
  });

  it("returns null for an unknown event, a malformed slug", async () => {
    expect(await loadEventBySlug(t.env.DB, "nosuchevent0000000000")).toBeNull();
    expect(await loadEventBySlug(t.env.DB, "bad slug")).toBeNull();
  });

  it("offers the fields (position, label, required, longest value) publicly, and not which of them identify a booking", async () => {
    const e = await insertEvent(t.env.DB, { ...DAY, fields: [{ label: "Rider", identity: true }, { label: "Notes", required: false, maxLength: 20 }] });
    const summary = eventSummary((await loadEventBySlug(t.env.DB, e.slug))!);
    expect(summary.fields).toEqual([
      { position: 1, label: "Rider", required: true, maxLength: 80 }, { position: 2, label: "Notes", required: false, maxLength: 20 },
    ]);
  });

  it("offers the lanes (id and name) and capacity publicly, and nothing else about them", async () => {
    const e = await insertEvent(t.env.DB, { ...DAY, capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    const summary = eventSummary((await loadEventBySlug(t.env.DB, e.slug))!);
    expect(summary).toMatchObject({ capacity: 2, lanes: [{ id: e.laneIds[0], name: "Ring 1" }, { id: e.laneIds[1], name: "Ring 2" }] });
    expect(Object.keys(summary.lanes[0]).sort()).toEqual(["id", "name"]);
  });

  it("counts the free places per lane per slot, and is free while any lane has a place", async () => {
    const e = await insertEvent(t.env.DB, { ...DAY, capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    const [a, b] = e.laneIds;
    await insertBooking(t.env.DB, e.id, "2026-06-13T08:00:00Z", "A", "A", { laneId: a });
    await insertBooking(t.env.DB, e.id, "2026-06-13T08:15:00Z", "B", "B", { laneId: a });
    await insertBooking(t.env.DB, e.id, "2026-06-13T08:15:00Z", "C", "C", { laneId: a });
    await insertBooking(t.env.DB, e.id, "2026-06-13T08:30:00Z", "D", "D", { laneId: a });
    await insertBooking(t.env.DB, e.id, "2026-06-13T08:30:00Z", "E", "E", { laneId: a });
    await insertBooking(t.env.DB, e.id, "2026-06-13T08:30:00Z", "F", "F", { laneId: b });
    await insertBooking(t.env.DB, e.id, "2026-06-13T08:30:00Z", "G", "G", { laneId: b });
    const views = await computeSlotViews(t.env.DB, (await loadEventBySlug(t.env.DB, e.slug))!, NOW);
    expect(views.map((v) => [v.start.slice(11, 16), v.status, v.places])).toEqual([
      ["08:00", "free", [{ laneId: a, free: 1 }, { laneId: b, free: 2 }]],
      ["08:15", "free", [{ laneId: a, free: 0 }, { laneId: b, free: 2 }]], // lane 1 full, lane 2 untouched
      ["08:30", "taken", [{ laneId: a, free: 0 }, { laneId: b, free: 0 }]], // every lane full
      ["08:45", "free", [{ laneId: a, free: 2 }, { laneId: b, free: 2 }]],
    ]);
  });

  it("says past for a started slot with places left, and taken for a started slot with none (booked wins)", async () => {
    const e = await insertEvent(t.env.DB, { ...DAY, capacity: 2 });
    await insertBooking(t.env.DB, e.id, "2026-06-13T08:00:00Z", "A", "A");
    await insertBooking(t.env.DB, e.id, "2026-06-13T08:00:00Z", "B", "B");
    await insertBooking(t.env.DB, e.id, "2026-06-13T08:15:00Z", "C", "C");
    const views = await computeSlotViews(t.env.DB, (await loadEventBySlug(t.env.DB, e.slug))!, new Date("2026-06-13T08:40:00Z"));
    expect(views.map((v) => [v.start.slice(11, 16), v.status])).toEqual([["08:00", "taken"], ["08:15", "past"], ["08:30", "past"], ["08:45", "free"]]);
  });
});

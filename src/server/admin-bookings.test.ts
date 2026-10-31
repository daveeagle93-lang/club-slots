import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityKeyOf } from "../core/identity";
import { generateSchedule } from "../core/schedule";
import { isValidToken } from "../core/slug";
import { createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../test/db";
import { addBooking, clearBooking, moveBooking, swapBookings, type Failure } from "./admin-bookings";
import { createBooking, validateBookingInput } from "./bookings";
import { loadEventBySlug } from "./events";

const IDEM = "abcdefghijklmnopqrstuv";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

const caught = async (p: Promise<unknown>): Promise<Error> => {
  try { await p; } catch (e) { return e as Error; }
  throw new Error("expected a failure");
};

/** 2026-10-24 (BST) 09:00-12:00, 15-minute sessions, lunch 10:00-10:30: ten slots. s[i] are their UTC starts. */
async function seed(over: Parameters<typeof insertEvent>[1] = {}) {
  const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, ...over });
  await insertBreak(t.env.DB, e.id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z", "Lunch");
  const event = (await loadEventBySlug(t.env.DB, e.slug))!;
  const s = generateSchedule({ start: event.startUtc, end: event.endUtc, sessionMinutes: 15, gapMinutes: 0, breaks: event.breaks }).slots.map((x) => x.start);
  return { ...e, event, s };
}

const rows = async (eventId: number) =>
  (await t.env.DB.prepare("SELECT * FROM bookings WHERE event_id = ? ORDER BY id").bind(eventId).all()).results;
const slotsOf = async (eventId: number) =>
  Object.fromEntries((await t.env.DB.prepare("SELECT id, slot_start_utc FROM bookings WHERE event_id = ?").bind(eventId).all<{ id: number; slot_start_utc: string }>())
    .results.map((r) => [r.id, r.slot_start_utc]));

/** What a booking of the Dog and Handler form shows in the admin API: its labelled values. */
const dh = (dog: string, handler: string) => ({ fields: [{ label: "Dog", value: dog }, { label: "Handler", value: handler }] });

const failed = (r: unknown): Failure => {
  if (!r || typeof r !== "object" || "ok" in r) throw new Error(`expected a failure, got ${JSON.stringify(r)}`);
  return r as Failure;
};
const ok = <T>(r: { ok: T } | Failure): T => {
  if (!("ok" in r)) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r.ok;
};

describe("addBooking", () => {
  it("adds the booking with a generated token, no idempotency key and identity keys, names trimmed", async () => {
    const e = await seed();
    const b = ok(await addBooking(t.env.DB, e.event, { slot: e.s[2], field1: "  Rex ", field2: "Sam  Smith" }));
    expect(b).toEqual({ id: expect.any(Number), slotStart: e.s[2], ...dh("Rex", "Sam  Smith"), lane: { id: e.event.lanes[0].id, name: "" } });
    const row = (await rows(e.id))[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      id: b.id, slot_start_utc: e.s[2], value_1: "Rex", value_2: "Sam  Smith", lane_id: e.event.lanes[0].id, place: 1,
      identity_key: identityKeyOf(["Rex", "Sam Smith"]), identity_seq: 1, idempotency_key: null,
    });
    expect(isValidToken(row.token as string)).toBe(true);
  });

  it("gives each booking its own token", async () => {
    const e = await seed();
    await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "A", field2: "H" });
    await addBooking(t.env.DB, e.event, { slot: e.s[1], field1: "B", field2: "H" });
    const tokens = (await rows(e.id)).map((r) => (r as { token: string }).token);
    expect(new Set(tokens).size).toBe(2);
  });

  it("reports a taken slot with who holds it, and writes nothing", async () => {
    const e = await seed();
    const holder = await insertBooking(t.env.DB, e.id, e.s[3], "Rex", "Sam Smith");
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[3], field1: "Bella", field2: "Alex Jones" }));
    expect(f).toMatchObject({ status: 409, code: "slot_taken", extra: { bookings: [{ id: holder, ...dh("Rex", "Sam Smith") }] } });
    expect(await rows(e.id)).toHaveLength(1);
  });

  it("reports the same dog and handler as a duplicate, naming the existing booking, whatever the case, spacing or Unicode form", async () => {
    const e = await seed();
    const first = ok(await addBooking(t.env.DB, e.event, { slot: e.s[4], field1: "Zoë", field2: "Sam Smith" }));
    for (const [dog, handler] of [["ZOË", "sam smith"], ["  zoë ", "SAM   SMITH"], ["Zoë", "Ｓam Smith"]]) {
      const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[5], field1: dog, field2: handler }));
      expect(f, `${dog}/${handler}`).toMatchObject({
        status: 409, code: "duplicate_booking",
        extra: { booking: { id: first.id, slotStart: e.s[4], ...dh("Zoë", "Sam Smith") } },
      });
    }
    expect(await rows(e.id)).toHaveLength(1);
  });

  it("reports a repeat that hides an invisible character as a duplicate, and stores the display names as entered", async () => {
    const e = await seed();
    const first = ok(await addBooking(t.env.DB, e.event, { slot: e.s[4], field1: "Rex \u2764\uFE0F", field2: "Sam Smith" }));
    for (const [dog, handler] of [["Rex \u2764", "Sam Smith"], ["Rex\u3164 \u2764\uFE0F", "Sam\uFE0F Smith"]]) {
      const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[5], field1: dog, field2: handler }));
      expect(f, `${dog}/${handler}`).toMatchObject({
        status: 409, code: "duplicate_booking",
        extra: { booking: { id: first.id, slotStart: e.s[4], ...dh("Rex \u2764\uFE0F", "Sam Smith") } },
      });
    }
    expect(await rows(e.id)).toHaveLength(1);
  });

  it("refuses a name with no letter or number, writing nothing", async () => {
    const e = await seed();
    for (const dogName of ["\u3164", "\u2800", "\uFE0F", "\u{1F436}"]) {
      expect(failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: dogName, field2: "Sam" })), dogName).toMatchObject({
        status: 400, code: "invalid_input", extra: { fields: { field1: "Dog must contain at least one letter or number." } },
      });
    }
    expect(await rows(e.id)).toHaveLength(0);
  });

  it("answers a clash on the same slot with the same pair as a duplicate, and a different pair as slot_taken even if that pair booked elsewhere", async () => {
    const e = await seed();
    const rex = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "Rex", field2: "Sam" }));
    const bella = ok(await addBooking(t.env.DB, e.event, { slot: e.s[1], field1: "Bella", field2: "Alex" }));
    expect(failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "rex", field2: "sam" })).code).toBe("duplicate_booking");
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "Bella", field2: "Alex" }));
    expect(f).toMatchObject({ code: "slot_taken", extra: { bookings: [{ id: rex.id }] } });
    expect(bella.id).not.toBe(rex.id);
  });

  it("lets one handler book several slots with different dogs, and one dog name with different handlers", async () => {
    const e = await seed();
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "Rex", field2: "Sam" }));
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[1], field1: "Bella", field2: "Sam" }));
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[2], field1: "Rex", field2: "Pat" }));
  });

  it("rejects a time that is not a slot of the schedule (a break, an off-grid time, a made-up date, another event's slot)", async () => {
    const e = await seed();
    for (const slot of ["2026-10-24T09:00:00Z", "2026-10-24T08:05:00Z", "2026-10-25T08:00:00Z", "nonsense", ""]) {
      expect(failed(await addBooking(t.env.DB, e.event, { slot, field1: "Rex", field2: "Sam" })), slot).toMatchObject({ status: 400, code: "invalid_slot" });
    }
    expect(await rows(e.id)).toHaveLength(0);
  });

  it("validates the values exactly as the public form does, and asks for a slot", async () => {
    const e = await seed();
    const odd = [undefined, 5, "", "   ", "x".repeat(81), "a​b", "tab\there", "lone\uD800", "‮evil"];
    for (const dog of odd) {
      for (const handler of ["Sam", ...odd.slice(0, 3)]) {
        const input = { slot: e.s[0], field1: dog, field2: handler };
        const publicFields = (validateBookingInput({ ...input, idempotencyKey: IDEM }, e.event) as { fields?: Record<string, string> }).fields ?? {};
        const f = failed(await addBooking(t.env.DB, e.event, input));
        expect(f.code).toBe("invalid_input");
        expect((f.extra as { fields: Record<string, string> }).fields, JSON.stringify(input)).toEqual(publicFields);
      }
    }
    expect(failed(await addBooking(t.env.DB, e.event, { field1: "Rex", field2: "Sam" })).extra).toEqual({ fields: { slot: "Choose a slot." } });
    expect(ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "x".repeat(80), field2: `a${"😀".repeat(79)}` })).fields[0].value).toHaveLength(80);
    expect(await rows(e.id)).toHaveLength(1);
  });

  it("books past slots, after the cut-off, and on an archived event: it is an admin override", async () => {
    const e = await seed({ startUtc: "2020-03-07T09:00:00Z", endUtc: "2020-03-07T10:00:00Z", archived: true });
    const b = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "Late", field2: "Lee" }));
    expect(b.slotStart).toBe(e.s[0]);
    expect(e.event.archived).toBe(true);
  });

  it("aborts, writing nothing, when the event was edited between the read and the write", async () => {
    const e = await seed();
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "Rex", field2: "Sam" }, {
      afterRead: async () => { await t.env.DB.prepare("UPDATE events SET end_utc = '2026-10-24T10:00:00Z' WHERE id = ?").bind(e.id).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "event_changed", message: "The event was edited while you were working. Reload the page." });
    expect(await rows(e.id)).toHaveLength(0);
  });

  it("aborts when a break was added after the read", async () => {
    const e = await seed();
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "Rex", field2: "Sam" }, {
      afterRead: async () => { await insertBreak(t.env.DB, e.id, "2026-10-24T10:30:00Z", "2026-10-24T10:40:00Z"); },
    }));
    expect(f.code).toBe("event_changed");
    expect(await rows(e.id)).toHaveLength(0);
  });
});

describe("an event deleted between the read and the write", () => {
  const strayRows = async (): Promise<number> => (await t.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM bookings WHERE event_id NOT IN (SELECT id FROM events))
          + (SELECT COUNT(*) FROM breaks WHERE event_id NOT IN (SELECT id FROM events)) AS n`,
  ).first<{ n: number }>())!.n;
  const deleteIt = (id: number) => async () => {
    await t.env.DB.batch([
      t.env.DB.prepare("DELETE FROM bookings WHERE event_id = ?").bind(id),
      t.env.DB.prepare("DELETE FROM breaks WHERE event_id = ?").bind(id),
      t.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id),
    ]);
  };

  it("add answers a clean 409 event_changed, never an error, and inserts nothing", async () => {
    const e = await seed();
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "Rex", field2: "Sam" }, { afterRead: deleteIt(e.id) }));
    expect(f).toMatchObject({ status: 409, code: "event_changed" });
    expect(await rows(e.id)).toHaveLength(0);
    expect(await strayRows()).toBe(0);
  });

  it("move answers a clean 409 event_changed and leaves no stray rows", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const f = failed(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], toSlot: e.s[5] }, { afterRead: deleteIt(e.id) }));
    expect(f).toMatchObject({ status: 409, code: "event_changed" });
    expect(await strayRows()).toBe(0);
  });

  it("swap answers a clean 409 event_changed and leaves no stray rows", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, e.s[1], "Bella", "Alex");
    const f = failed(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[0] }, b: { id: b, slot: e.s[1] } }, { afterRead: deleteIt(e.id) }));
    expect(f).toMatchObject({ status: 409, code: "event_changed" });
    expect(await strayRows()).toBe(0);
  });

  it("clear answers not_found once the event and its bookings are gone", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    await deleteIt(e.id)();
    expect(failed(await clearBooking(t.env.DB, e.event, a))).toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("clearBooking", () => {
  it("removes only that booking and returns it", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, e.s[1], "Bella", "Alex");
    expect(ok(await clearBooking(t.env.DB, e.event, a))).toEqual({ id: a, slotStart: e.s[0], ...dh("Rex", "Sam"), lane: { id: e.event.lanes[0].id, name: "" } });
    expect(Object.keys(await slotsOf(e.id))).toEqual([String(b)]);
  });

  it("answers not_found the second time, with no error state", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    ok(await clearBooking(t.env.DB, e.event, a));
    expect(failed(await clearBooking(t.env.DB, e.event, a))).toMatchObject({ status: 404, code: "not_found" });
  });

  it("does not touch a booking of another event", async () => {
    const e = await seed();
    const other = await seed();
    const theirs = await insertBooking(t.env.DB, other.id, other.s[0], "Rex", "Sam");
    expect(failed(await clearBooking(t.env.DB, e.event, theirs)).status).toBe(404);
    expect(await slotsOf(other.id)).toEqual({ [theirs]: other.s[0] });
  });

  it("clears an orphan whose slot is not in the schedule", async () => {
    const e = await seed();
    const orphan = await insertBooking(t.env.DB, e.id, "2026-10-24T06:00:00Z", "Lost", "Lou");
    expect(ok(await clearBooking(t.env.DB, e.event, orphan)).fields).toEqual(dh("Lost", "Lou").fields);
  });
});

describe("moveBooking", () => {
  const move = (e: Awaited<ReturnType<typeof seed>>, id: number, fromSlot: unknown, toSlot: unknown, hooks = {}) =>
    moveBooking(t.env.DB, e.event, id, { fromSlot, toSlot }, hooks);

  it("moves the booking to a free slot and leaves everything else alone", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const other = await insertBooking(t.env.DB, e.id, e.s[1], "Bella", "Alex");
    expect(ok(await move(e, a, e.s[0], e.s[5]))).toEqual({ id: a, slotStart: e.s[5], ...dh("Rex", "Sam"), lane: { id: e.event.lanes[0].id, name: "" } });
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[5], [other]: e.s[1] });
  });

  it("refuses a taken slot, naming its holder, and changes nothing", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, e.s[1], "Bella", "Alex");
    const before = await rows(e.id);
    expect(failed(await move(e, a, e.s[0], e.s[1]))).toMatchObject({ status: 409, code: "slot_taken", extra: { bookings: [{ id: b, ...dh("Bella", "Alex") }] } });
    expect(await rows(e.id)).toEqual(before);
  });

  it("refuses a slot that is not in the schedule (400 invalid_slot), moving to the same slot (400 same_slot) and non-string slots", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    expect(failed(await move(e, a, e.s[0], "2026-10-24T09:00:00Z"))).toMatchObject({ status: 400, code: "invalid_slot" });
    expect(failed(await move(e, a, e.s[0], e.s[0]))).toMatchObject({ status: 400, code: "same_slot" });
    expect(failed(await move(e, a, undefined, e.s[3])).code).toBe("invalid_input");
    expect(failed(await move(e, a, e.s[0], 5)).code).toBe("invalid_input");
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[0] });
  });

  it("answers 409 changed when the booking is no longer at fromSlot", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    expect(failed(await move(e, a, e.s[2], e.s[5]))).toMatchObject({ status: 409, code: "changed" });
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[0] });
  });

  it("answers 404 for a booking of another event or one that does not exist", async () => {
    const e = await seed();
    const other = await seed();
    const theirs = await insertBooking(t.env.DB, other.id, other.s[0], "Rex", "Sam");
    expect(failed(await move(e, theirs, other.s[0], e.s[5])).status).toBe(404);
    expect(failed(await move(e, 999999, e.s[0], e.s[5])).status).toBe(404);
    expect(await slotsOf(other.id)).toEqual({ [theirs]: other.s[0] });
  });

  it("moves into past or closed slots and on an archived event (admin override), and moves an orphan into the schedule", async () => {
    const e = await seed({ startUtc: "2020-03-07T09:00:00Z", endUtc: "2020-03-07T10:00:00Z", archived: true });
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    expect(ok(await move(e, a, e.s[0], e.s[2])).slotStart).toBe(e.s[2]);
    const orphan = await insertBooking(t.env.DB, e.id, "2020-03-07T06:00:00Z", "Lost", "Lou");
    expect(ok(await move(e, orphan, "2020-03-07T06:00:00Z", e.s[1])).slotStart).toBe(e.s[1]);
  });

  it("lets exactly one of two simultaneous moves into the same free slot win; the loser stays put", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, e.s[1], "Bella", "Alex");
    const [ra, rb] = await Promise.all([move(e, a, e.s[0], e.s[5]), move(e, b, e.s[1], e.s[5])]);
    const results = [ra, rb];
    expect(results.filter((r) => "ok" in r)).toHaveLength(1);
    const loser = failed(results.find((r) => !("ok" in r)));
    expect(loser).toMatchObject({ status: 409, code: "slot_taken" });
    const held = await slotsOf(e.id);
    expect(Object.values(held).sort()).toHaveLength(2);
    expect(Object.values(held).filter((s) => s === e.s[5])).toHaveLength(1);
    const winnerId = "ok" in ra ? a : b;
    expect(held[winnerId]).toBe(e.s[5]);
    expect(held[winnerId === a ? b : a]).toBe(winnerId === a ? e.s[1] : e.s[0]);
  });

  it("lets exactly one of a public booking and a move into the same free slot win", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const now = new Date("2026-10-01T12:00:00Z");
    const [moved, booked] = await Promise.all([
      move(e, a, e.s[0], e.s[5]),
      createBooking(t.env.DB, e.event, { start: e.s[5], end: e.s[5] }, { slot: e.s[5], laneId: e.event.lanes[0].id, values: ["Pub", "Lic"], idempotencyKey: IDEM }, now),
    ]);
    expect(("ok" in moved ? 1 : 0) + (booked.kind === "created" ? 1 : 0)).toBe(1);
    if ("ok" in moved) expect(booked.kind).toBe("slot_taken");
    else expect(moved).toMatchObject({ status: 409, code: "slot_taken", extra: { bookings: [{ fields: [{ label: "Dog", value: "Pub" }, { label: "Handler", value: "Lic" }] }] } });
    expect(Object.values(await slotsOf(e.id)).filter((s) => s === e.s[5])).toHaveLength(1);
    expect(await rows(e.id)).toHaveLength(2);
  });

  it("aborts, writing nothing, when the event was edited between the read and the write", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const f = failed(await move(e, a, e.s[0], e.s[5], {
      afterRead: async () => { await t.env.DB.prepare("UPDATE events SET session_minutes = 10 WHERE id = ?").bind(e.id).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "event_changed" });
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[0] });
  });
});

describe("swapBookings", () => {
  const swap = (e: Awaited<ReturnType<typeof seed>>, a: [number, string], b: [number, string], hooks = {}) =>
    swapBookings(t.env.DB, e.event, { a: { id: a[0], slot: a[1] }, b: { id: b[0], slot: b[1] } }, hooks);
  const PARKING = "0001-01-01T00:00:00Z";

  async function pair() {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam Smith");
    const b = await insertBooking(t.env.DB, e.id, e.s[6], "Bella", "Alex Jones");
    return { e, a, b };
  }

  it("swaps the slots of two bookings from different dogs and handlers, leaving the people with their bookings", async () => {
    const { e, a, b } = await pair();
    expect(ok(await swap(e, [a, e.s[1]], [b, e.s[6]]))).toEqual({ a: { id: a, slotStart: e.s[6], lane: { id: e.laneId, name: "" } }, b: { id: b, slotStart: e.s[1], lane: { id: e.laneId, name: "" } } });
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[6], [b]: e.s[1] });
    const names = (await rows(e.id)).map((r) => (r as { id: number; value_1: string }).value_1);
    expect(names).toEqual(["Rex", "Bella"]);
  });

  it("swaps back and forth without leaving anything on the parking slot", async () => {
    const { e, a, b } = await pair();
    ok(await swap(e, [a, e.s[1]], [b, e.s[6]]));
    ok(await swap(e, [a, e.s[6]], [b, e.s[1]]));
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[1], [b]: e.s[6] });
  });

  it("refuses to swap an orphan with a booking in the schedule, in either order, and changes nothing", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam");
    const orphanSlot = "2026-10-24T06:00:00Z";
    const orphan = await insertBooking(t.env.DB, e.id, orphanSlot, "Lost", "Lou");
    const before = await rows(e.id);
    for (const [x, y] of [[[a, e.s[1]], [orphan, orphanSlot]], [[orphan, orphanSlot], [a, e.s[1]]]] as [number, string][][]) {
      expect(failed(await swap(e, x, y)), `${x} ${y}`).toMatchObject({ status: 400, code: "invalid_slot", message: "That time isn't one of this event's slots." });
    }
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[1], [orphan]: orphanSlot });
    expect(await rows(e.id)).toEqual(before);
  });

  it("refuses to swap two orphans", async () => {
    const e = await seed();
    const x = await insertBooking(t.env.DB, e.id, "2026-10-24T06:00:00Z", "Lost", "Lou");
    const y = await insertBooking(t.env.DB, e.id, "2026-10-24T06:15:00Z", "Gone", "Gus");
    expect(failed(await swap(e, [x, "2026-10-24T06:00:00Z"], [y, "2026-10-24T06:15:00Z"])).code).toBe("invalid_slot");
    expect(await slotsOf(e.id)).toEqual({ [x]: "2026-10-24T06:00:00Z", [y]: "2026-10-24T06:15:00Z" });
  });

  it("refuses with 409 changed, writing nothing, when either booking is no longer where the admin saw it", async () => {
    const { e, a, b } = await pair();
    const before = await rows(e.id);
    expect(failed(await swap(e, [a, e.s[2]], [b, e.s[6]])).code).toBe("changed");
    expect(failed(await swap(e, [a, e.s[1]], [b, e.s[7]])).code).toBe("changed");
    expect(failed(await swap(e, [a, e.s[6]], [b, e.s[1]])).code).toBe("changed");
    expect(await rows(e.id)).toEqual(before);
  });

  it("refuses a booking swapped with itself (400)", async () => {
    const { e, a } = await pair();
    expect(failed(await swap(e, [a, e.s[1]], [a, e.s[1]]))).toMatchObject({ status: 400, code: "same_booking" });
  });

  it("answers 404 for another event's booking, alone or mixed with its own, and writes nothing", async () => {
    const { e, a } = await pair();
    const other = await seed();
    const theirs = await insertBooking(t.env.DB, other.id, other.s[3], "Foreign", "Fred");
    const before = [await rows(e.id), await rows(other.id)];
    expect(failed(await swap(e, [a, e.s[1]], [theirs, other.s[3]])).status).toBe(404);
    expect(failed(await swap(e, [theirs, other.s[3]], [a, e.s[1]])).status).toBe(404);
    expect(failed(await swap(e, [a, e.s[1]], [999999, e.s[4]])).status).toBe(404);
    expect([await rows(e.id), await rows(other.id)]).toEqual(before);
  });

  it("validates the body shape", async () => {
    const { e } = await pair();
    for (const raw of [{}, { a: 1, b: 2 }, { a: { id: "1", slot: "x" }, b: { id: 2, slot: "y" } }, { a: { id: 1, slot: "x" }, b: { id: -2, slot: "y" } }, { a: null, b: null }]) {
      expect(failed(await swapBookings(t.env.DB, e.event, raw as Record<string, unknown>)).code).toBe("invalid_input");
    }
  });

  it("rolls back completely when its last statement fails: both bookings exactly where they were, nothing parked", async () => {
    const { e, a, b } = await pair();
    const before = await rows(e.id);
    // Fires only on the third UPDATE (the one that takes the first booking off the parking slot), so the first two have already run.
    await t.env.DB.prepare(
      `CREATE TRIGGER force_swap_failure BEFORE UPDATE ON bookings WHEN OLD.slot_start_utc = '${PARKING}'
       BEGIN SELECT RAISE(ABORT, 'forced failure'); END`,
    ).run();
    try {
      const err = await caught(swap(e, [a, e.s[1]], [b, e.s[6]]));
      expect(err.message).toContain("forced failure");
    } finally {
      await t.env.DB.prepare("DROP TRIGGER force_swap_failure").run();
    }
    expect(await rows(e.id)).toEqual(before);
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[1], [b]: e.s[6] });
    const parked = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE slot_start_utc = ?").bind(PARKING).first<{ n: number }>();
    expect(parked!.n).toBe(0);
    // And the swap works once the failure is gone.
    ok(await swap(e, [a, e.s[1]], [b, e.s[6]]));
  });

  it("refuses to run when a booking already holds the parking slot, writing nothing", async () => {
    const { e, a, b } = await pair();
    const squatter = await insertBooking(t.env.DB, e.id, PARKING, "Squat", "Sue");
    const before = await rows(e.id);
    expect(failed(await swap(e, [a, e.s[1]], [b, e.s[6]])).status).toBe(409);
    expect(await rows(e.id)).toEqual(before);
    expect((await slotsOf(e.id))[squatter]).toBe(PARKING);
  });

  it("aborts with event_changed, writing nothing, when the event was edited between the read and the write", async () => {
    const { e, a, b } = await pair();
    const before = await rows(e.id);
    const f = failed(await swap(e, [a, e.s[1]], [b, e.s[6]], {
      afterRead: async () => { await t.env.DB.prepare("UPDATE events SET gap_minutes = 5 WHERE id = ?").bind(e.id).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "event_changed" });
    expect(await rows(e.id)).toEqual(before);
  });

  it("answers changed, writing nothing, when a booking moves between the read and the write", async () => {
    const { e, a, b } = await pair();
    const f = failed(await swap(e, [a, e.s[1]], [b, e.s[6]], {
      afterRead: async () => { await t.env.DB.prepare("UPDATE bookings SET slot_start_utc = ? WHERE id = ?").bind(e.s[8], b).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "changed" });
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[1], [b]: e.s[8] });
  });

  it("keeps a valid permutation, no row stuck on the parking slot and no lost booking, when two overlapping swaps race", async () => {
    for (let round = 0; round < 5; round++) {
      const e = await seed();
      const a = await insertBooking(t.env.DB, e.id, e.s[0], "A", "H1");
      const b = await insertBooking(t.env.DB, e.id, e.s[1], "B", "H2");
      const c = await insertBooking(t.env.DB, e.id, e.s[2], "C", "H3");
      const [x, y] = await Promise.all([swap(e, [a, e.s[0]], [b, e.s[1]]), swap(e, [b, e.s[1]], [c, e.s[2]])]);
      expect([x, y].some((r) => "ok" in r)).toBe(true);
      for (const r of [x, y]) if (!("ok" in r)) expect(r.code).toBe("changed");
      const held = await slotsOf(e.id);
      expect(Object.keys(held).map(Number).sort()).toEqual([a, b, c].sort());
      expect(Object.values(held).sort()).toEqual([e.s[0], e.s[1], e.s[2]]);
    }
  });
});


// The admin tools with lanes and places: add takes a lane (optional with one lane), move can change lane, swap exchanges whole places.
describe("admin tools with capacity and lanes", () => {
  const placesOf = async (eventId: number) =>
    Object.fromEntries((await t.env.DB.prepare("SELECT id, lane_id, slot_start_utc, place FROM bookings WHERE event_id = ?").bind(eventId).all<{ id: number; lane_id: number; slot_start_utc: string; place: number }>())
      .results.map((r) => [r.id, [r.lane_id, r.slot_start_utc, r.place]]));

  it("adds into the named lane at the lowest free place, and says slot_taken only when every place of that lane is taken", async () => {
    const e = await seed({ capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], laneId: l1, field1: "A", field2: "H1" }));
    const b = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], laneId: l1, field1: "B", field2: "H2" }));
    expect(await placesOf(e.id)).toEqual({ [a.id]: [l1, e.s[0], 1], [b.id]: [l1, e.s[0], 2] });
    expect(a.lane).toEqual({ id: l1, name: "Ring 1" });
    const full = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], laneId: l1, field1: "C", field2: "H3" }));
    expect(full).toMatchObject({ status: 409, code: "slot_taken" });
    // Several lanes or places: the holders, all of them, and no v1.0 `booking` key.
    expect(full.extra).toEqual({ bookings: [
      { id: a.id, slotStart: e.s[0], ...dh("A", "H1"), lane: { id: l1, name: "Ring 1" } },
      { id: b.id, slotStart: e.s[0], ...dh("B", "H2"), lane: { id: l1, name: "Ring 1" } },
    ] });
    const other = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], laneId: l2, field1: "C", field2: "H3" }));
    expect(other.lane).toEqual({ id: l2, name: "Ring 2" });
  });

  it("needs a lane when the event has two or more, as a field error 'Choose a lane.', and refuses a lane of another event", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"] });
    const elsewhere = await insertEvent(t.env.DB, { lanes: ["Other"] });
    for (const laneId of [undefined, null, "1", 0, elsewhere.laneId]) {
      expect(failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], laneId, field1: "A", field2: "H" }))).toMatchObject({
        status: 400, code: "invalid_input", extra: { fields: { laneId: "Choose a lane." } },
      });
    }
    expect(await rows(e.id)).toEqual([]);
  });

  it("takes the one lane when laneId is left out, but still refuses a laneId that is not the event's", async () => {
    const e = await seed({ lanes: ["Only"] });
    expect(ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "A", field2: "H" })).lane).toEqual({ id: e.laneId, name: "Only" });
    expect(failed(await addBooking(t.env.DB, e.event, { slot: e.s[1], laneId: e.laneId + 999, field1: "B", field2: "H" }))).toMatchObject({
      extra: { fields: { laneId: "Choose a lane." } },
    });
  });

  it("with one lane and one place, a taken slot lists the holder", async () => {
    const e = await seed();
    const a = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "A", field2: "H1" }));
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "B", field2: "H2" }));
    expect(f).toMatchObject({ status: 409, code: "slot_taken" });
    expect(f.extra).toEqual({
      bookings: [{ id: a.id, slotStart: e.s[0], ...dh("A", "H1"), lane: { id: e.laneId, name: "" } }],
    });
  });

  it("with one lane and capacity above 1, a taken slot has the list only", async () => {
    const e = await seed({ capacity: 2 });
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "A", field2: "H1" }));
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "B", field2: "H2" }));
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "C", field2: "H3" }));
    expect(Object.keys(f.extra!)).toEqual(["bookings"]);
  });

  it("answers duplicate_booking, naming the identity's own booking, when the same dog and handler ask for a full lane they hold a place in", async () => {
    const e = await seed({ capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    const [l1] = e.laneIds;
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], laneId: l1, field1: "A", field2: "H1" }));
    const mine = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], laneId: l1, field1: "B", field2: "H2" }));
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], laneId: l1, field1: "b", field2: "h2" }));
    expect(f).toMatchObject({ status: 409, code: "duplicate_booking", extra: { booking: { id: mine.id, lane: { id: l1, name: "Ring 1" } } } });
  });

  it("numbers a second booking of an identity when the event's limit allows it, and refuses the next as a duplicate", async () => {
    const e = await seed({ identityLimit: 2 });
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "Rex", field2: "Sam" }));
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[1], field1: "rex", field2: "SAM" }));
    expect(failed(await addBooking(t.env.DB, e.event, { slot: e.s[2], field1: "REX", field2: "sam" }))).toMatchObject({ status: 409, code: "duplicate_booking" });
    expect((await t.env.DB.prepare("SELECT identity_seq FROM bookings WHERE event_id = ? ORDER BY id").bind(e.id).all()).results).toEqual([{ identity_seq: 1 }, { identity_seq: 2 }]);
  });

  it("moves a booking to the lowest free place of the target slot, in the lane it was in (toLane left out)", async () => {
    const e = await seed({ capacity: 3, lanes: ["Ring 1", "Ring 2"] });
    const lane2 = e.laneIds[1];
    await insertBooking(t.env.DB, e.id, e.s[5], "X", "X", { laneId: lane2, place: 1 });
    await insertBooking(t.env.DB, e.id, e.s[5], "Y", "Y", { laneId: lane2, place: 3 });
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam", { laneId: lane2, place: 2 });
    ok(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], toSlot: e.s[5] }));
    expect((await placesOf(e.id))[a]).toEqual([lane2, e.s[5], 2]);
  });

  it("refuses a move into a lane-and-slot with no free place, and into one that is free in the first lane only when it is free in the booking's lane", async () => {
    const e = await seed({ capacity: 1, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    await insertBooking(t.env.DB, e.id, e.s[5], "Held", "Ring2", { laneId: l2 });
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam", { laneId: l2 });
    // Ring 1 is free at s[5], but the booking is in Ring 2, which is not.
    expect(failed(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], toSlot: e.s[5] }))).toMatchObject({ status: 409, code: "slot_taken" });
    const b = await insertBooking(t.env.DB, e.id, e.s[1], "Fido", "Ann", { laneId: l1 });
    ok(await moveBooking(t.env.DB, e.event, b, { fromSlot: e.s[1], toSlot: e.s[5] }));
  });

  it("moves a booking to another lane at the same time (toLane), at the lowest free place there, and says so in the answer", async () => {
    const e = await seed({ capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    await insertBooking(t.env.DB, e.id, e.s[1], "Held", "H", { laneId: l2, place: 1 });
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam", { laneId: l1, place: 1 });
    const moved = ok(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[1], fromLane: l1, toSlot: e.s[1], toLane: l2 }));
    expect(moved).toMatchObject({ id: a, slotStart: e.s[1], lane: { id: l2, name: "Ring 2" } });
    expect((await placesOf(e.id))[a]).toEqual([l2, e.s[1], 2]);
  });

  it("moves to another lane and another time at once, and frees the old place", async () => {
    const e = await seed({ capacity: 1, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam", { laneId: l1 });
    ok(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], toSlot: e.s[4], toLane: l2 }));
    expect((await placesOf(e.id))[a]).toEqual([l2, e.s[4], 1]);
    const b = await insertBooking(t.env.DB, e.id, e.s[1], "Fido", "Ann", { laneId: l2 });
    ok(await moveBooking(t.env.DB, e.event, b, { fromSlot: e.s[1], toSlot: e.s[0], toLane: l1 })); // the place a left is free again
  });

  it("answers same_slot for the slot and lane the booking is in, with or without toLane, but moves it to another lane of the same slot", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam", { laneId: l1 });
    expect(failed(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], toSlot: e.s[0] }))).toMatchObject({ status: 400, code: "same_slot" });
    expect(failed(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], toSlot: e.s[0], toLane: l1 }))).toMatchObject({ status: 400, code: "same_slot" });
    expect(failed(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], fromLane: l1, toSlot: e.s[0], toLane: l1 }))).toMatchObject({ code: "same_slot" });
    expect(ok(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], toSlot: e.s[0], toLane: l2 })).lane.id).toBe(l2);
  });

  it("answers slot_taken, naming the holders, for a full target lane, and the v1.0 booking key only for one lane and one place", async () => {
    const e = await seed({ capacity: 1, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const held = await insertBooking(t.env.DB, e.id, e.s[0], "Held", "H", { laneId: l2 });
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam", { laneId: l1 });
    const f = failed(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], toSlot: e.s[0], toLane: l2 }));
    expect(f).toMatchObject({ status: 409, code: "slot_taken" });
    expect(f.extra).toEqual({ bookings: [{ id: held, slotStart: e.s[0], ...dh("Held", "H"), lane: { id: l2, name: "Ring 2" } }] });
    expect((await placesOf(e.id))[a]).toEqual([l1, e.s[0], 1]);
    const single = await seed();
    const h = await insertBooking(t.env.DB, single.id, single.s[3], "Held", "H");
    const m = await insertBooking(t.env.DB, single.id, single.s[0], "Rex", "Sam");
    const g = failed(await moveBooking(t.env.DB, single.event, m, { fromSlot: single.s[0], toSlot: single.s[3] }));
    expect(g.extra).toEqual({ bookings: [{ id: h, slotStart: single.s[3], ...dh("Held", "H"), lane: { id: single.laneId, name: "" } }] });
  });

  it("checks fromLane as it checks fromSlot: a booking in another lane than the admin saw is changed", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam", { laneId: l2 });
    expect(failed(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], fromLane: l1, toSlot: e.s[3] }))).toMatchObject({ status: 409, code: "changed" });
    expect(ok(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], fromLane: l2, toSlot: e.s[3] })).lane.id).toBe(l2);
  });

  it("refuses fromLane or toLane that are not numbers or not the event's lanes, as field errors, before touching anything", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"] });
    const elsewhere = await insertEvent(t.env.DB, { lanes: ["Other"] });
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    expect(failed(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], fromLane: "1", toSlot: e.s[3] }))).toMatchObject({ status: 400, extra: { fields: { fromLane: "Send the lane the booking is in." } } });
    for (const toLane of [null, "2", 0, elsewhere.laneId]) {
      expect(failed(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], toSlot: e.s[3], toLane }))).toMatchObject({ status: 400, extra: { fields: { toLane: "Choose a lane." } } });
    }
    expect((await placesOf(e.id))[a]).toEqual([e.laneIds[0], e.s[0], 1]);
  });

  it("swaps whole places: each booking takes the other's lane, slot and place", async () => {
    const e = await seed({ capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam", { laneId: l1, place: 2 });
    const b = await insertBooking(t.env.DB, e.id, e.s[6], "Bella", "Alex", { laneId: l2, place: 1 });
    const swapped = ok(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[1] }, b: { id: b, slot: e.s[6] } }));
    expect(await placesOf(e.id)).toEqual({ [a]: [l2, e.s[6], 1], [b]: [l1, e.s[1], 2] });
    expect(swapped).toEqual({ a: { id: a, slotStart: e.s[6], lane: { id: l2, name: "Ring 2" } }, b: { id: b, slotStart: e.s[1], lane: { id: l1, name: "Ring 1" } } });
  });

  it("checks the lane of each side when the request names it: a stale lane is changed, and nothing moves", async () => {
    const e = await seed({ capacity: 1, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam", { laneId: l1 });
    const b = await insertBooking(t.env.DB, e.id, e.s[6], "Bella", "Alex", { laneId: l2 });
    const before = await placesOf(e.id);
    for (const [la, lb] of [[l2, l2], [l1, l1], [l2, l1]]) {
      expect(failed(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[1], lane: la }, b: { id: b, slot: e.s[6], lane: lb } })), `${la} ${lb}`)
        .toMatchObject({ status: 409, code: "changed" });
      expect(await placesOf(e.id)).toEqual(before);
    }
    expect(ok(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[1], lane: l1 }, b: { id: b, slot: e.s[6], lane: l2 } }))).toMatchObject({ a: { id: a, lane: { id: l2 } }, b: { id: b, lane: { id: l1 } } });
    expect(await placesOf(e.id)).toEqual({ [a]: [l2, e.s[6], 1], [b]: [l1, e.s[1], 1] });
  });

  it("takes the lane of one side only, and leaves the other side's lane unchecked as before", async () => {
    const e = await seed({ capacity: 1, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam", { laneId: l1 });
    const b = await insertBooking(t.env.DB, e.id, e.s[6], "Bella", "Alex", { laneId: l2 });
    expect(failed(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[1], lane: l2 }, b: { id: b, slot: e.s[6] } })).code).toBe("changed");
    ok(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[1] }, b: { id: b, slot: e.s[6], lane: l2 } }));
    expect(await placesOf(e.id)).toEqual({ [a]: [l2, e.s[6], 1], [b]: [l1, e.s[1], 1] });
  });

  it("answers changed when a booking named with its lane left that lane between the read and the swap", async () => {
    const e = await seed({ capacity: 1, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam", { laneId: l1 });
    const b = await insertBooking(t.env.DB, e.id, e.s[6], "Bella", "Alex", { laneId: l1 });
    const f = failed(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[1], lane: l1 }, b: { id: b, slot: e.s[6], lane: l1 } }, {
      afterRead: async () => { await t.env.DB.prepare("UPDATE bookings SET lane_id = ? WHERE id = ?").bind(l2, a).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "changed" });
    expect(await placesOf(e.id)).toEqual({ [a]: [l2, e.s[1], 1], [b]: [l1, e.s[6], 1] });
  });

  it("refuses a lane that is not a positive whole number", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"] });
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, e.s[6], "Bella", "Alex");
    for (const lane of ["1", 0, -1, 1.5, null]) {
      expect(failed(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[1], lane }, b: { id: b, slot: e.s[6] } })).code, String(lane)).toBe("invalid_input");
    }
  });

  it("swaps two bookings of the same time in different lanes, and two places of one lane and time", async () => {
    const e = await seed({ capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam", { laneId: l1, place: 1 });
    const b = await insertBooking(t.env.DB, e.id, e.s[1], "Bella", "Alex", { laneId: l2, place: 2 });
    const c = await insertBooking(t.env.DB, e.id, e.s[1], "Cleo", "Pat", { laneId: l1, place: 2 });
    ok(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[1] }, b: { id: b, slot: e.s[1] } }));
    expect(await placesOf(e.id)).toEqual({ [a]: [l2, e.s[1], 2], [b]: [l1, e.s[1], 1], [c]: [l1, e.s[1], 2] });
    ok(await swapBookings(t.env.DB, e.event, { a: { id: b, slot: e.s[1] }, b: { id: c, slot: e.s[1] } }));
    expect(await placesOf(e.id)).toEqual({ [a]: [l2, e.s[1], 2], [b]: [l1, e.s[1], 2], [c]: [l1, e.s[1], 1] });
  });

  it("answers changed when a booking was moved to another lane between the read and the swap, and leaves both where they are", async () => {
    const e = await seed({ capacity: 1, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam", { laneId: l1 });
    const b = await insertBooking(t.env.DB, e.id, e.s[6], "Bella", "Alex", { laneId: l1 });
    const f = failed(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[1] }, b: { id: b, slot: e.s[6] } }, {
      afterRead: async () => { await t.env.DB.prepare("UPDATE bookings SET lane_id = ? WHERE id = ?").bind(l2, a).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "changed" });
    expect(await placesOf(e.id)).toEqual({ [a]: [l2, e.s[1], 1], [b]: [l1, e.s[6], 1] });
  });

  it("answers changed when a booking was moved to another place of the same slot between the read and the swap", async () => {
    const e = await seed({ capacity: 2 });
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam", { place: 1 });
    const b = await insertBooking(t.env.DB, e.id, e.s[6], "Bella", "Alex");
    const f = failed(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[1] }, b: { id: b, slot: e.s[6] } }, {
      afterRead: async () => { await t.env.DB.prepare("UPDATE bookings SET place = 2 WHERE id = ?").bind(a).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "changed" });
    expect((await placesOf(e.id))[a]).toEqual([e.laneId, e.s[1], 2]);
  });

  it("answers event_changed, writing nothing, when the layout was edited between the read and the write", async () => {
    const e = await seed({ capacity: 2 });
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "A", field2: "H" }, {
      afterRead: async () => { await t.env.DB.prepare("UPDATE event_layout SET capacity = 1, config_rev = config_rev + 1 WHERE event_id = ?").bind(e.id).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "event_changed" });
    expect(await rows(e.id)).toEqual([]);
  });
});

describe("admin add with a configured booking form", () => {
  const RIDER_PONY: Parameters<typeof insertEvent>[1] = {
    fields: [{ label: "Rider", identity: true }, { label: "Pony", identity: true }, { label: "Phone", required: false, maxLength: 12 }],
  };

  it("takes field1 to field3 and answers with each non-empty value under its label", async () => {
    const e = await seed(RIDER_PONY);
    const b = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: " Ann ", field2: "Biscuit", field3: "111" }));
    expect(b).toEqual({
      id: expect.any(Number), slotStart: e.s[0], lane: { id: e.laneId, name: "" },
      fields: [{ label: "Rider", value: "Ann" }, { label: "Pony", value: "Biscuit" }, { label: "Phone", value: "111" }],
    });
    const blank = ok(await addBooking(t.env.DB, e.event, { slot: e.s[1], field1: "Bea", field2: "Nutmeg" }));
    expect(blank.fields).toEqual([{ label: "Rider", value: "Bea" }, { label: "Pony", value: "Nutmeg" }]);
    expect((await rows(e.id)).map((r) => (r as { value_3: string }).value_3)).toEqual(["111", ""]);
  });

  it("checks each value against its own field, keyed field1 to field4", async () => {
    const e = await seed(RIDER_PONY);
    expect(failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "", field2: "🐴", field3: "x".repeat(13) })).extra).toEqual({
      fields: {
        field1: "Rider is required.",
        field2: "Pony must contain at least one letter or number.",
        field3: "Phone must be at most 12 characters.",
      },
    });
    expect(await rows(e.id)).toEqual([]);
  });

  it("answers a repeat of the identity with the form's own wording, and the booking that holds it", async () => {
    const e = await seed(RIDER_PONY);
    const first = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "Ann", field2: "Biscuit", field3: "111" }));
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[1], field1: "ANN", field2: "biscuit", field3: "222" }));
    expect(f).toMatchObject({ status: 409, code: "duplicate_booking", message: "That rider and pony already have a booking for this event.", extra: { booking: { id: first.id } } });
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[1], field1: "Ann", field2: "Nutmeg" }));
  });

  it("identifies a booking by one field alone, and does not ask a one-field form for a second", async () => {
    const e = await seed({ fields: [{ label: "Car reg", identity: true }] });
    expect(ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "AB12 CDE" })).fields).toEqual([{ label: "Car reg", value: "AB12 CDE" }]);
    expect(failed(await addBooking(t.env.DB, e.event, { slot: e.s[1], field1: "ab12 cde" })).message).toBe("That car reg already has a booking for this event.");
  });

  it("books up to the identity limit when the limit is above 1", async () => {
    const e = await seed({ ...RIDER_PONY, identityLimit: 2 });
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], field1: "Ann", field2: "Biscuit" }));
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[1], field1: "Ann", field2: "Biscuit" }));
    expect(failed(await addBooking(t.env.DB, e.event, { slot: e.s[2], field1: "Ann", field2: "Biscuit" })).code).toBe("duplicate_booking");
    expect((await rows(e.id)).map((r) => (r as { identity_seq: number }).identity_seq)).toEqual([1, 2]);
  });

  it("lists every holder of a full lane with their values", async () => {
    const e = await seed({ ...RIDER_PONY, lanes: ["Ring 1", "Ring 2"] });
    const [l1] = e.laneIds;
    const a = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], laneId: l1, field1: "Ann", field2: "Biscuit", field3: "111" }));
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], laneId: l1, field1: "Bea", field2: "Nutmeg" }));
    expect((f.extra as { bookings: unknown[] }).bookings).toEqual([a]);
  });
});

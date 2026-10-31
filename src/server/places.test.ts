import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityKeyOf } from "../core/identity";
import { createTestEnv, insertBooking, insertEvent, insertsBooking, interceptBatches, type TestEnv } from "../test/db";
import { createBooking, type BookingInput, type CreateResult } from "./bookings";
import { loadEventBySlug } from "./events";

// createBooking's choice of place and identity number, and how it classifies and retries a lost race. The real
// concurrency tests (whole Worker, requests in parallel) are in src/test/concurrency.test.ts; here the "other request"
// is slipped in deterministically just before the booking's own insert.

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

const NOW = new Date("2026-06-01T00:00:00Z");
const S1 = "2026-06-13T08:00:00Z";
const S2 = "2026-06-13T08:15:00Z";
const IDEM = "abcdefghijklmnopqrstuv";

const seed = async (over: Parameters<typeof insertEvent>[1] = {}) => {
  const e = await insertEvent(t.env.DB, over);
  return { ...e, event: async () => (await loadEventBySlug(t.env.DB, e.slug))! };
};
const input = (laneId: number, dog = "Rex", handler = "Sam", slot = S1, key = IDEM): BookingInput => ({ slot, laneId, values: [dog, handler], idempotencyKey: key });
const make = async (e: Awaited<ReturnType<typeof seed>>, i: BookingInput, db: D1Database = t.env.DB): Promise<CreateResult> =>
  createBooking(db, await e.event(), { start: i.slot, end: i.slot }, i, NOW);
const stored = async (eventId: number) =>
  (await t.env.DB.prepare("SELECT lane_id, slot_start_utc, place, value_1, identity_key, identity_seq FROM bookings WHERE event_id = ? ORDER BY id").bind(eventId).all<{
    lane_id: number; slot_start_utc: string; place: number; value_1: string; identity_key: string; identity_seq: number;
  }>()).results;
/** The database, except that `before` runs just before each booking insert (up to `times`), as another request's write would. */
const racing = (before: () => Promise<void>, times = 1) => {
  let inserts = 0;
  return {
    db: interceptBatches(t.env.DB, async (sqls, run) => {
      if (insertsBooking(sqls) && ++inserts <= times) await before();
      return run();
    }),
    inserts: () => inserts,
  };
};

describe("createBooking: place and identity number", () => {
  it("takes the lowest free place of the chosen lane, and the identity number 1", async () => {
    const e = await seed({ capacity: 3 });
    await insertBooking(t.env.DB, e.id, S1, "A", "A", { place: 1 });
    await insertBooking(t.env.DB, e.id, S1, "B", "B", { place: 3 });
    const r = await make(e, input(e.laneId, "Rex", "Sam", S1, "k".repeat(22)));
    expect(r.kind).toBe("created");
    expect((await stored(e.id)).find((b) => b.value_1 === "Rex")).toMatchObject({ place: 2, identity_seq: 1, identity_key: identityKeyOf(["Rex", "Sam"]) });
  });

  it("books in the lane that was asked for, with places counted per lane", async () => {
    const e = await seed({ capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    await insertBooking(t.env.DB, e.id, S1, "A", "A", { laneId: e.laneIds[0] });
    const r = await make(e, input(e.laneIds[1]));
    expect(r).toMatchObject({ kind: "created", booking: { lane: { id: e.laneIds[1], name: "Ring 2" } } });
    expect((await stored(e.id)).find((b) => b.value_1 === "Rex")).toMatchObject({ lane_id: e.laneIds[1], place: 1 });
  });

  it("numbers an identity's bookings up to the event's limit, then says duplicate_booking", async () => {
    const e = await seed({ identityLimit: 2 });
    expect((await make(e, input(e.laneId, "Rex", "Sam", S1, "a".repeat(22)))).kind).toBe("created");
    expect((await make(e, input(e.laneId, "REX", "sam", S2, "b".repeat(22)))).kind).toBe("created");
    expect((await make(e, input(e.laneId, "rex", "SAM", "2026-06-13T08:30:00Z", "c".repeat(22)))).kind).toBe("duplicate_booking");
    expect((await stored(e.id)).map((b) => b.identity_seq)).toEqual([1, 2]);
  });

  it("reuses the lowest free identity number when an earlier booking was cleared", async () => {
    const e = await seed({ identityLimit: 3 });
    await insertBooking(t.env.DB, e.id, S1, "Rex", "Sam"); // number 1
    await insertBooking(t.env.DB, e.id, S2, "Rex", "Sam"); // number 2
    await t.env.DB.prepare("DELETE FROM bookings WHERE event_id = ? AND identity_seq = 1").bind(e.id).run();
    await make(e, input(e.laneId, "Rex", "Sam", "2026-06-13T08:30:00Z", "d".repeat(22)));
    expect((await stored(e.id)).map((b) => b.identity_seq).sort()).toEqual([1, 2]);
  });
});

describe("createBooking: an identity limit the admin lowered", () => {
  /** An identity holding numbers 2 and 3 of a limit of 3 (number 1 was cleared), then the limit lowered to 2. */
  const lowered = async () => {
    const e = await seed({ identityLimit: 3, capacity: 2 });
    for (const slot of [S1, S2, "2026-06-13T08:30:00Z"]) await insertBooking(t.env.DB, e.id, slot, "Rex", "Sam");
    await t.env.DB.prepare("DELETE FROM bookings WHERE event_id = ? AND identity_seq = 1").bind(e.id).run();
    await t.env.DB.prepare("UPDATE event_layout SET identity_limit = 2, config_rev = config_rev + 1 WHERE event_id = ?").bind(e.id).run();
    return e;
  };

  it("refuses with duplicate_booking when the identity already holds as many bookings as the new limit, though number 1 is free", async () => {
    const e = await lowered();
    expect((await make(e, input(e.laneId, "Rex", "Sam", "2026-06-13T08:45:00Z", "l".repeat(22)))).kind).toBe("duplicate_booking");
    expect((await stored(e.id)).map((b) => b.identity_seq)).toEqual([2, 3]);
  });

  it("still admits an identity below the new limit, on the lowest free number, and then refuses the next", async () => {
    const e = await lowered();
    await t.env.DB.prepare("DELETE FROM bookings WHERE event_id = ? AND identity_seq = 2").bind(e.id).run(); // holds only number 3 now
    expect((await make(e, input(e.laneId, "Rex", "Sam", "2026-06-13T08:45:00Z", "m".repeat(22)))).kind).toBe("created");
    expect((await stored(e.id)).map((b) => b.identity_seq)).toEqual([3, 1]);
    expect((await make(e, input(e.laneId, "Rex", "Sam", "2026-06-13T09:00:00Z", "n".repeat(22)))).kind).toBe("duplicate_booking");
    expect(await stored(e.id)).toHaveLength(2);
  });
});

describe("createBooking: what a refusal says", () => {
  it("is slot_taken when the lane has no place left, with the live free slots and their places", async () => {
    const e = await seed({ capacity: 2 });
    await insertBooking(t.env.DB, e.id, S1, "A", "A");
    await insertBooking(t.env.DB, e.id, S1, "B", "B");
    const r = await make(e, input(e.laneId, "C", "C"));
    expect(r.kind).toBe("slot_taken");
    const free = (r as { freeSlots: { start: string; places: unknown }[] }).freeSlots;
    expect(free.map((s) => s.start)).not.toContain(S1);
    expect(free[0].places).toEqual([{ laneId: e.laneId, free: 2 }]);
  });

  it("says slot_taken, not duplicate_booking, when the lane is full and the requester's identity holds a booking ELSEWHERE (no oracle)", async () => {
    const e = await seed({ capacity: 2 });
    await insertBooking(t.env.DB, e.id, S1, "A", "A");
    await insertBooking(t.env.DB, e.id, S1, "B", "B");
    await insertBooking(t.env.DB, e.id, S2, "Rex", "Sam");
    expect((await make(e, input(e.laneId, "Rex", "Sam", S1))).kind).toBe("slot_taken");
  });

  it("says duplicate_booking when the lane is full and the requester's own identity holds one of its places (as v1.0 did for its slot)", async () => {
    const e = await seed({ capacity: 2 });
    await insertBooking(t.env.DB, e.id, S1, "Rex", "Sam");
    await insertBooking(t.env.DB, e.id, S1, "B", "B");
    expect((await make(e, input(e.laneId, "Rex", "Sam", S1))).kind).toBe("duplicate_booking");
  });

  it("says duplicate_booking for an identity at its limit when the lane has a place", async () => {
    const e = await seed({ capacity: 2 });
    await insertBooking(t.env.DB, e.id, S2, "Rex", "Sam");
    expect((await make(e, input(e.laneId, "Rex", "Sam", S1))).kind).toBe("duplicate_booking");
  });

  it("is schedule_changed, writing nothing, when the lane no longer belongs to the event", async () => {
    const e = await seed({ capacity: 2 });
    const other = await seed();
    expect((await make(e, input(other.laneId))).kind).toBe("schedule_changed");
    expect(await stored(e.id)).toEqual([]);
  });
});

describe("createBooking: a lost race is retried", () => {
  it("takes the next place when another request took the one this request had read as free", async () => {
    const e = await seed({ capacity: 3 });
    const r = racing(async () => { await insertBooking(t.env.DB, e.id, S1, "Other", "Person", { place: 1 }); });
    expect((await make(e, input(e.laneId), r.db)).kind).toBe("created");
    expect(r.inserts()).toBe(2); // the first insert lost, the second took place 2
    expect((await stored(e.id)).map((b) => [b.value_1, b.place])).toEqual([["Other", 1], ["Rex", 2]]);
  });

  it("gives up the retry with slot_taken when the race filled the lane", async () => {
    const e = await seed({ capacity: 1 });
    const r = racing(async () => { await insertBooking(t.env.DB, e.id, S1, "Other", "Person"); });
    expect((await make(e, input(e.laneId), r.db)).kind).toBe("slot_taken");
    expect(await stored(e.id)).toHaveLength(1);
  });

  it("takes the next identity number when another request took the one this request had read as free", async () => {
    const e = await seed({ identityLimit: 2, capacity: 2 });
    const r = racing(async () => { await insertBooking(t.env.DB, e.id, S2, "Rex", "Sam"); });
    expect((await make(e, input(e.laneId, "Rex", "Sam", S1), r.db)).kind).toBe("created");
    expect((await stored(e.id)).map((b) => b.identity_seq).sort()).toEqual([1, 2]);
  });

  it("says duplicate_booking when the race used up the identity's last number", async () => {
    const e = await seed({ identityLimit: 1, capacity: 2 });
    const r = racing(async () => { await insertBooking(t.env.DB, e.id, S2, "Rex", "Sam"); });
    expect((await make(e, input(e.laneId, "Rex", "Sam", S1), r.db)).kind).toBe("duplicate_booking");
    expect(await stored(e.id)).toHaveLength(1);
  });

  it("answers the idempotency replay when the race was this same request arriving twice", async () => {
    const e = await seed({ capacity: 2 });
    const same = input(e.laneId, "Rex", "Sam", S1, "r".repeat(22));
    const r = racing(async () => { await make(e, same); });
    const answer = await make(e, same, r.db);
    expect(answer.kind).toBe("replayed");
    expect(await stored(e.id)).toHaveLength(1);
  });

  it("stops after a bounded number of attempts when every insert fails and nothing changes", async () => {
    const e = await seed({ capacity: 2, identityLimit: 1 });
    let inserts = 0;
    const db = interceptBatches(t.env.DB, async (sqls, run) => {
      if (!insertsBooking(sqls)) return run();
      inserts++;
      throw new Error("D1_ERROR: UNIQUE constraint failed: bookings.token");
    });
    expect((await make(e, input(e.laneId), db)).kind).toBe("slot_taken");
    expect(inserts).toBe(2 + 1 + 2); // capacity + identity limit + 2
  });

  it("rethrows a failure that is not a UNIQUE or guard failure", async () => {
    const e = await seed();
    const db = interceptBatches(t.env.DB, async (sqls, run) => {
      if (insertsBooking(sqls)) throw new Error("D1_ERROR: SECRET detail");
      return run();
    });
    await expect(make(e, input(e.laneId), db)).rejects.toThrow("SECRET detail");
  });
});

describe("createBooking: the layout guard", () => {
  it("writes nothing and says schedule_changed when the layout's revision moved after the event was read", async () => {
    const e = await seed({ capacity: 2 });
    const read = await e.event();
    await t.env.DB.prepare("UPDATE event_layout SET capacity = 1, config_rev = config_rev + 1 WHERE event_id = ?").bind(e.id).run();
    expect((await createBooking(t.env.DB, read, { start: S1, end: S1 }, input(e.laneId), NOW)).kind).toBe("schedule_changed");
    expect(await stored(e.id)).toEqual([]);
  });

  it("books once the event is read again", async () => {
    const e = await seed({ capacity: 2 });
    await t.env.DB.prepare("UPDATE event_layout SET capacity = 1, config_rev = config_rev + 1 WHERE event_id = ?").bind(e.id).run();
    expect((await make(e, input(e.laneId))).kind).toBe("created");
  });
});

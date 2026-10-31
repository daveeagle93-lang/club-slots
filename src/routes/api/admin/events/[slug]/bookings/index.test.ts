import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSlug } from "../../../../../../core/slug";
import { createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../../../../../../test/db";
import { onRequestPost as publicBook } from "../../../../events/[slug]/bookings";
import { onRequestGet as icsGet } from "../../../../events/[slug]/bookings/[token]/ics";
import { onRequestDelete } from "./[id]/index";
import { onRequestPost as movePost } from "./[id]/move";
import { onRequestPost } from "./index";
import { onRequestPost as swapPost } from "./swap";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(() => { vi.setSystemTime(new Date("2026-10-01T12:00:00Z")); });
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

/** A booking of the Dog and Handler form as the admin API shows it: its labelled values. */
const dh = (dog: string, handler: string) => ({ fields: [{ label: "Dog", value: dog }, { label: "Handler", value: handler }] });

interface Opts { contentType?: string | null; raw?: string; data?: unknown[] }
type Handler = (ctx: never) => Response | Promise<Response>;

function call(handler: Handler, method: string, params: Record<string, string>, body: unknown, o: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  const init: RequestInit = { method, headers };
  if (o.raw !== undefined || body !== undefined) init.body = o.raw ?? JSON.stringify(body);
  return Promise.resolve(
    handler({ request: new Request("http://localhost/api/admin/x", init), env: t.env, params, data: o.data ? o.data[0] : ADMIN } as never),
  );
}
const add = (slug: string, body: unknown, o?: Opts) => call(onRequestPost as Handler, "POST", { slug }, body, o);
const clear = (slug: string, id: string | number, body: unknown, o?: Opts) => call(onRequestDelete as Handler, "DELETE", { slug, id: String(id) }, body, o);
const move = (slug: string, id: string | number, body: unknown, o?: Opts) => call(movePost as Handler, "POST", { slug, id: String(id) }, body, o);
const swap = (slug: string, body: unknown, o?: Opts) => call(swapPost as Handler, "POST", { slug }, body, o);

// 2026-10-24 (BST) 09:00-12:00, quarter hours, lunch 10:00-10:30. Slot starts (Z): 08:00 08:15 08:30 08:45 | 09:30 ...
const S = ["2026-10-24T08:00:00Z", "2026-10-24T08:15:00Z", "2026-10-24T08:30:00Z", "2026-10-24T08:45:00Z", "2026-10-24T09:30:00Z", "2026-10-24T09:45:00Z"];
async function seed(over: Parameters<typeof insertEvent>[1] = {}) {
  const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, ...over });
  await insertBreak(t.env.DB, e.id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z", "Lunch");
  return e;
}
const stored = async (eventId: number) =>
  (await t.env.DB.prepare("SELECT id, slot_start_utc, value_1 AS dog_name FROM bookings WHERE event_id = ? ORDER BY id").bind(eventId).all()).results;
const body = async (res: Response) => (await res.json()) as Record<string, any>;

const unauthenticated = (name: string, send: (data: unknown[]) => Promise<Response>) =>
  it(`${name}: refuses with 401 unless the guard set an admin identity`, async () => {
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await send([data]);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

describe("POST /api/admin/events/[slug]/bookings", () => {
  it("adds the booking: 201, no-store, the booking's id, slot and names", async () => {
    const e = await seed();
    const res = await add(e.slug, { slot: S[2], field1: "Rex", field2: "Sam Smith" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await body(res)).toEqual({ booking: { id: expect.any(Number), slotStart: S[2], ...dh("Rex", "Sam Smith"), lane: { id: expect.any(Number), name: "" } } });
    expect(await stored(e.id)).toHaveLength(1);
  });

  it("makes a booking whose public .ics link works (a token is generated)", async () => {
    const e = await seed();
    await add(e.slug, { slot: S[2], field1: "Rex", field2: "Sam Smith" });
    const { token } = (await t.env.DB.prepare("SELECT token FROM bookings WHERE event_id = ?").bind(e.id).first<{ token: string }>())!;
    const res = await icsGet({
      request: new Request(`http://localhost/api/events/${e.slug}/bookings/${token}/ics`), env: t.env, params: { slug: e.slug, token },
    } as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("BEGIN:VEVENT");
  });

  it("answers 409 slot_taken with the holder, and 409 duplicate_booking with the existing booking", async () => {
    const e = await seed();
    const rex = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam Smith");
    const taken = await add(e.slug, { slot: S[0], field1: "Bella", field2: "Alex" });
    expect(taken.status).toBe(409);
    expect(await body(taken)).toMatchObject({ error: { code: "slot_taken" }, bookings: [{ id: rex, ...dh("Rex", "Sam Smith") }] });
    const dup = await add(e.slug, { slot: S[1], field1: "REX", field2: "sam smith" });
    expect(dup.status).toBe(409);
    expect(await body(dup)).toMatchObject({ error: { code: "duplicate_booking" }, booking: { id: rex, slotStart: S[0], ...dh("Rex", "Sam Smith") } });
    expect(await stored(e.id)).toHaveLength(1);
  });

  it("answers 400 invalid_slot for a time that is not a slot, and 400 invalid_input with per-field messages", async () => {
    const e = await seed();
    const bad = await add(e.slug, { slot: "2026-10-24T09:00:00Z", field1: "Rex", field2: "Sam" });
    expect(bad.status).toBe(400);
    expect((await body(bad)).error.code).toBe("invalid_slot");
    const fields = await add(e.slug, { slot: S[0], field1: "", field2: "x".repeat(81) });
    expect(fields.status).toBe(400);
    expect(await body(fields)).toMatchObject({
      error: { code: "invalid_input" },
      fields: {
        field1: "Dog is required.", field2: "Handler must be at most 80 characters.",
      },
    });
    expect(await stored(e.id)).toHaveLength(0);
  });

  it("refuses a name that could fake lines in the pasted lineup (U+2028, U+2029, U+0085), storing nothing", async () => {
    const e = await seed();
    for (const ch of ["\u2028", "\u2029", "\u0085"]) {
      const res = await add(e.slug, { slot: S[0], field1: `Rex${ch}08:15 \u2014 free`, field2: `Sam${ch}` });
      expect(res.status, JSON.stringify(ch)).toBe(400);
      expect(Object.keys((await body(res)).fields).sort()).toEqual(["field1", "field2"]);
    }
    expect(await stored(e.id)).toHaveLength(0);
  });

  it("books past slots, after the cut-off and on an archived event, which the public handler refuses", async () => {
    const e = await seed({ startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T09:00:00Z", archived: true });
    const slot = "2026-06-13T08:00:00Z";
    const pub = await publicBook({
      request: new Request(`http://localhost/api/events/${e.slug}/bookings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot, field1: "Pub", field2: "Lic", idempotencyKey: "abcdefghijklmnopqrstuv" }),
      }),
      env: { ...t.env, BOOKING_CUTOFF_OFFSET_MINUTES: undefined }, params: { slug: e.slug },
    } as never);
    expect(pub.status).toBe(410);
    const res = await add(e.slug, { slot, field1: "Late", field2: "Lee" });
    expect(res.status).toBe(201);
    expect((await stored(e.id)).map((r) => r.dog_name)).toEqual(["Late"]);
  });

  it("answers 404 for an unknown or malformed slug, and rejects a non-JSON body", async () => {
    for (const slug of [generateSlug(), "nope", "x".repeat(100)]) {
      const res = await add(slug, { slot: S[0], field1: "Rex", field2: "Sam" });
      expect(res.status).toBe(404);
      expect((await body(res)).error.code).toBe("not_found");
    }
    const e = await seed();
    expect((await add(e.slug, undefined, { raw: "not json" })).status).toBe(400);
    expect((await add(e.slug, { slot: S[0] }, { contentType: "text/plain" })).status).toBe(415);
    expect((await add(e.slug, undefined, { raw: "[]" })).status).toBe(400);
  });

  unauthenticated("add", async (data) => add((await seed()).slug, { slot: S[0], field1: "Rex", field2: "Sam" }, { data }));
});

describe("DELETE /api/admin/events/[slug]/bookings/[id]", () => {
  it("clears the booking when the body is {confirm: true}, returning it, and only that one", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, S[1], "Bella", "Alex");
    const res = await clear(e.slug, a, { confirm: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await body(res)).toEqual({ removed: { id: a, slotStart: S[0], ...dh("Rex", "Sam"), lane: { id: expect.any(Number), name: "" } } });
    expect((await stored(e.id)).map((r) => r.id)).toEqual([b]);
  });

  it("refuses without an explicit confirm: true (400 confirmation_required) and removes nothing", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam");
    const attempts: [unknown, Opts?][] = [
      [undefined, { contentType: null }], [undefined], [{}], [{ confirm: false }], [{ confirm: "true" }], [{ confirm: 1 }], [{ confirm: null }],
      [{ Confirm: true }], [undefined, { raw: "not json" }], [undefined, { raw: "[true]" }], [{ confirm: true }, { contentType: "text/plain" }],
    ];
    for (const [b, o] of attempts) {
      const res = await clear(e.slug, a, b, o);
      expect(res.status, JSON.stringify([b, o])).toBe(400);
      expect((await body(res)).error.code).toBe("confirmation_required");
    }
    expect(await stored(e.id)).toHaveLength(1);
  });

  it("answers 404 for another event's booking id and leaves that booking alone", async () => {
    const e = await seed();
    const other = await seed();
    const theirs = await insertBooking(t.env.DB, other.id, S[0], "Rex", "Sam");
    const res = await clear(e.slug, theirs, { confirm: true });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await stored(other.id)).toHaveLength(1);
  });

  it("answers 404 the second time (no error state) and for ids that are not booking ids", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam");
    expect((await clear(e.slug, a, { confirm: true })).status).toBe(200);
    expect((await clear(e.slug, a, { confirm: true })).status).toBe(404);
    for (const id of ["abc", "0", "-1", "1e3", "1.5", "", "99999999999999999999"]) {
      expect((await clear(e.slug, id, { confirm: true })).status, id).toBe(404);
    }
  });

  it("answers 404 for an unknown slug", async () => {
    expect((await clear(generateSlug(), 1, { confirm: true })).status).toBe(404);
  });

  unauthenticated("clear", async (data) => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam");
    const res = await clear(e.slug, a, { confirm: true }, { data });
    expect(await stored(e.id)).toHaveLength(1);
    return res;
  });
});

describe("POST /api/admin/events/[slug]/bookings/[id]/move", () => {
  it("moves the booking: 200 with the booking at its new slot", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam");
    const res = await move(e.slug, a, { fromSlot: S[0], toSlot: S[5] });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await body(res)).toEqual({ booking: { id: a, slotStart: S[5], ...dh("Rex", "Sam"), lane: { id: expect.any(Number), name: "" } } });
  });

  it("answers 409 slot_taken with the holder, 409 changed for a stale fromSlot, 400 for same_slot and invalid_slot, 404 otherwise", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, S[1], "Bella", "Alex");
    const taken = await move(e.slug, a, { fromSlot: S[0], toSlot: S[1] });
    expect(taken.status).toBe(409);
    expect(await body(taken)).toMatchObject({ error: { code: "slot_taken" }, bookings: [{ id: b, ...dh("Bella", "Alex") }] });
    expect((await body(await move(e.slug, a, { fromSlot: S[3], toSlot: S[5] }))).error.code).toBe("changed");
    expect((await body(await move(e.slug, a, { fromSlot: S[0], toSlot: S[0] }))).error.code).toBe("same_slot");
    expect((await body(await move(e.slug, a, { fromSlot: S[0], toSlot: "2026-10-24T09:00:00Z" }))).error.code).toBe("invalid_slot");
    expect((await move(e.slug, 999999, { fromSlot: S[0], toSlot: S[5] })).status).toBe(404);
    expect((await move(e.slug, "abc", { fromSlot: S[0], toSlot: S[5] })).status).toBe(404);
    expect((await move(generateSlug(), a, { fromSlot: S[0], toSlot: S[5] })).status).toBe(404);
    expect((await stored(e.id)).map((r) => r.slot_start_utc)).toEqual([S[0], S[1]]);
  });

  unauthenticated("move", async (data) => move((await seed()).slug, 1, { fromSlot: S[0], toSlot: S[5] }, { data }));
});

describe("POST /api/admin/events/[slug]/bookings/swap", () => {
  it("swaps the two bookings' slots: 200 with their new slots", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, S[4], "Bella", "Alex");
    const res = await swap(e.slug, { a: { id: a, slot: S[0] }, b: { id: b, slot: S[4] } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await body(res)).toEqual({ a: { id: a, slotStart: S[4], lane: { id: e.laneId, name: "" } }, b: { id: b, slotStart: S[0], lane: { id: e.laneId, name: "" } } });
  });

  it("answers 409 changed for stale slots, 400 for the same booking twice, 404 for a foreign id, writing nothing", async () => {
    const e = await seed();
    const other = await seed();
    const a = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, S[4], "Bella", "Alex");
    const theirs = await insertBooking(t.env.DB, other.id, S[1], "Foreign", "Fred");
    expect((await body(await swap(e.slug, { a: { id: a, slot: S[1] }, b: { id: b, slot: S[4] } }))).error.code).toBe("changed");
    expect((await swap(e.slug, { a: { id: a, slot: S[0] }, b: { id: a, slot: S[0] } })).status).toBe(400);
    expect((await swap(e.slug, { a: { id: a, slot: S[0] }, b: { id: theirs, slot: S[1] } })).status).toBe(404);
    expect((await swap(e.slug, {}, {})).status).toBe(400);
    expect((await stored(e.id)).map((r) => r.slot_start_utc)).toEqual([S[0], S[4]]);
    expect((await stored(other.id)).map((r) => r.slot_start_utc)).toEqual([S[1]]);
  });

  it("answers 404 for an unknown slug", async () => {
    expect((await swap(generateSlug(), { a: { id: 1, slot: S[0] }, b: { id: 2, slot: S[1] } })).status).toBe(404);
  });

  unauthenticated("swap", async (data) => swap((await seed()).slug, { a: { id: 1, slot: S[0] }, b: { id: 2, slot: S[1] } }, { data }));
});

// The router picks the literal route /bookings/swap over /bookings/:id; there is no [id]/index POST, so a stray POST is not a clear.
describe("route shapes", () => {
  it("has no POST on the [id] route and no DELETE on the collection routes", async () => {
    const mod = await import("./[id]/index");
    expect("onRequestPost" in mod).toBe(false);
    expect("onRequestDelete" in (await import("./index"))).toBe(false);
    expect("onRequestDelete" in (await import("./swap"))).toBe(false);
  });
});


describe("the booking tools with lanes and places, over HTTP", () => {
  it("add: the lane is a field (laneId), needed with two lanes; the booking comes back with its lane; a full lane is 409 slot_taken with the holders", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"], capacity: 1 });
    const [l1, l2] = e.laneIds;
    const missing = await add(e.slug, { slot: S[0], field1: "Rex", field2: "Sam" });
    expect(missing.status).toBe(400);
    expect(await body(missing)).toMatchObject({ error: { code: "invalid_input" }, fields: { laneId: "Choose a lane." } });
    const made = await add(e.slug, { slot: S[0], laneId: l2, field1: "Rex", field2: "Sam" });
    expect(made.status).toBe(201);
    const booking = (await body(made)).booking;
    expect(booking).toEqual({ id: expect.any(Number), slotStart: S[0], ...dh("Rex", "Sam"), lane: { id: l2, name: "Ring 2" } });
    const full = await add(e.slug, { slot: S[0], laneId: l2, field1: "Bella", field2: "Alex" });
    expect(full.status).toBe(409);
    const taken = await body(full);
    expect(taken.error.code).toBe("slot_taken");
    expect(taken.bookings).toEqual([booking]);
    expect((await add(e.slug, { slot: S[0], laneId: l1, field1: "Bella", field2: "Alex" })).status).toBe(201);
  });

  it("move: toLane changes the lane (also at the same time), the answer names it, and fromLane guards against a stale view", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam", { laneId: l1 });
    expect((await body(await move(e.slug, a, { fromSlot: S[0], fromLane: l2, toSlot: S[0], toLane: l1 }))).error.code).toBe("changed");
    expect((await body(await move(e.slug, a, { fromSlot: S[0], toSlot: S[0] }))).error.code).toBe("same_slot");
    const res = await move(e.slug, a, { fromSlot: S[0], fromLane: l1, toSlot: S[0], toLane: l2 });
    expect(res.status).toBe(200);
    expect((await body(res)).booking).toMatchObject({ id: a, slotStart: S[0], lane: { id: l2, name: "Ring 2" } });
    expect((await body(await move(e.slug, a, { fromSlot: S[0], toSlot: S[1], toLane: 999999 }))).fields.toLane).toBe("Choose a lane.");
  });

  it("swap: bookings in different lanes exchange lane, time and place, and the answer says where each is now", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const a = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam", { laneId: l1 });
    const b = await insertBooking(t.env.DB, e.id, S[0], "Bella", "Alex", { laneId: l2 });
    const res = await swap(e.slug, { a: { id: a, slot: S[0] }, b: { id: b, slot: S[0] } });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ a: { id: a, slotStart: S[0], lane: { id: l2, name: "Ring 2" } }, b: { id: b, slotStart: S[0], lane: { id: l1, name: "Ring 1" } } });
  });

  it("clear: the removed booking names its lane, and the place it held is free again", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"] });
    const a = await insertBooking(t.env.DB, e.id, S[0], "Rex", "Sam", { laneId: e.laneIds[1] });
    expect((await body(await clear(e.slug, a, { confirm: true }))).removed.lane).toEqual({ id: e.laneIds[1], name: "Ring 2" });
    expect((await add(e.slug, { slot: S[0], laneId: e.laneIds[1], field1: "Next", field2: "H" })).status).toBe(201);
  });
});

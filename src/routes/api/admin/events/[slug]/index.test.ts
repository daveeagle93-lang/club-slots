import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLineup } from "../../../../../core/lineup";
import { generateSlug } from "../../../../../core/slug";
import type { AppEnv } from "../../../../../server/env";
import { saveSettings } from "../../../../../server/settings";
import { countRows, createTestEnv, insertBooking, insertBookingOf, insertBreak, insertEvent, insertTemplate, interceptBatches, type TestEnv } from "../../../../../test/db";
import { onRequestPost as book } from "../../../events/[slug]/bookings";
import { onRequestGet as publicGet } from "../../../events/[slug]/index";
import { onRequestDelete as clearBooking } from "./bookings/[id]/index";
import { onRequestDelete, onRequestGet, onRequestPut } from "./index";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };
const NOW = "2026-10-01T12:00:00Z";

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(() => { vi.setSystemTime(new Date(NOW)); });
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

/** Pass a second argument (even undefined) to replace the admin data. */
const get = (slug: string, ...data: unknown[]): Promise<Response> =>
  Promise.resolve(
    onRequestGet({
      request: new Request(`http://localhost/api/admin/events/${slug}`), env: t.env, params: { slug }, data: data.length > 0 ? data[0] : ADMIN,
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );

/** A booking of the Dog and Handler form as the admin API shows it: its labelled values. */
const dh = (dog: string, handler: string) => ({ fields: [{ label: "Dog", value: dog }, { label: "Handler", value: handler }] });

interface Detail {
  event: Record<string, unknown>;
  slots: {
    start: string; end: string;
    places: { laneId: number; laneName: string; free: number; bookings: { id: number; fields: { label: string; value: string }[] }[] }[];
  }[];
  orphans: { id: number; slotStart: string; fields: { label: string; value: string }[]; lane: { id: number; name: string } }[];
  lineup: string;
  defaultShareMessage: string;
}
const detail = async (slug: string): Promise<Detail> => {
  const res = await get(slug);
  expect(res.status).toBe(200);
  return (await res.json()) as Detail;
};

describe("GET /api/admin/events/[slug]", () => {
  it("returns the event as the form uses it, London-local on a BST date, with UTC alongside, no-store", async () => {
    const { id, slug } = await insertEvent(t.env.DB, {
      name: "Saturday trial day", startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z",
      sessionMinutes: 15, gapMinutes: 5, costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water",
    });
    await insertBreak(t.env.DB, id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z", "Lunch");
    const res = await get(slug);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Detail;
    expect(body.event).toEqual({
      slug, name: "Saturday trial day", archived: false, listed: true, date: "2026-10-24", start: "09:00", end: "12:00",
      sessionMinutes: 15, gapMinutes: 5, costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water", shareMessage: "",
      startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z",
      breaks: [{ start: "10:00", end: "10:30", label: "Lunch", startUtc: "2026-10-24T09:00:00Z", endUtc: "2026-10-24T09:30:00Z" }],
      lanes: [{ id: expect.any(Number), name: "" }], capacity: 1,
      fields: [{ label: "Dog", required: true, maxLength: 80, identity: true }, { label: "Handler", required: true, maxLength: 80, identity: true }], identityLimit: 1,
      hasBookings: false, configRev: 0,
    });
    expect(body.orphans).toEqual([]);
  });

  it("says whether the event has any booking at all: no, then yes with one in a slot, and yes with only an orphan", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 20 });
    expect((await detail(slug)).event.hasBookings).toBe(false);
    await insertBooking(t.env.DB, id, "2026-10-24T08:20:00Z", "Rex", "Sam Smith");
    expect((await detail(slug)).event.hasBookings).toBe(true);
    const other = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 20 });
    await insertBooking(t.env.DB, other.id, "2026-10-24T07:00:00Z", "Early", "Eve");
    expect((await detail(other.slug)).event.hasBookings).toBe(true);
    expect((await detail(slug)).event.hasBookings).toBe(true); // another event's bookings don't count, and this one's still does
    const empty = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 20 });
    expect((await detail(empty.slug)).event.hasBookings).toBe(false);
  });

  it("says whether the event is listed", async () => {
    const shown = await insertEvent(t.env.DB);
    const hidden = await insertEvent(t.env.DB, { listed: false });
    expect([(await detail(shown.slug)).event.listed, (await detail(hidden.slug)).event.listed]).toEqual([true, false]);
  });

  it("returns a GMT date as it is (2026-10-31: 09:00 is 09:00Z)", async () => {
    const { slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-31T09:00:00Z", endUtc: "2026-10-31T12:00:00Z" });
    expect((await detail(slug)).event).toMatchObject({ date: "2026-10-31", start: "09:00", end: "12:00" });
  });

  it("reads London times right across the clocks going forward (2026-03-29)", async () => {
    // 00:30 is GMT (00:30Z), 10:00 is BST (09:00Z); the break at 03:30-04:00 BST is 02:30Z-03:00Z.
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-03-29T00:30:00Z", endUtc: "2026-03-29T09:00:00Z", sessionMinutes: 30 });
    await insertBreak(t.env.DB, id, "2026-03-29T02:30:00Z", "2026-03-29T03:00:00Z");
    const { event } = await detail(slug);
    expect(event).toMatchObject({ date: "2026-03-29", start: "00:30", end: "10:00" });
    expect(event.breaks).toEqual([{ start: "03:30", end: "04:00", label: "", startUtc: "2026-03-29T02:30:00Z", endUtc: "2026-03-29T03:00:00Z" }]);
  });

  it("reads London times right across the clocks going back (2026-10-25)", async () => {
    // 00:30 is still BST, so it is 23:30Z the evening before; 10:00 is GMT (10:00Z); the break at 09:00 GMT is 09:00Z.
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-24T23:30:00Z", endUtc: "2026-10-25T10:00:00Z", sessionMinutes: 30 });
    await insertBreak(t.env.DB, id, "2026-10-25T09:00:00Z", "2026-10-25T09:30:00Z", "Tea");
    const { event } = await detail(slug);
    expect(event).toMatchObject({ date: "2026-10-25", start: "00:30", end: "10:00" });
    expect(event.breaks).toEqual([{ start: "09:00", end: "09:30", label: "Tea", startUtc: "2026-10-25T09:00:00Z", endUtc: "2026-10-25T09:30:00Z" }]);
  });

  it("lists breaks in time order with their labels, including a Unicode one", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z" });
    await insertBreak(t.env.DB, id, "2026-10-24T10:00:00Z", "2026-10-24T10:10:00Z", "Café ☕ 😀");
    await insertBreak(t.env.DB, id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z");
    expect((await detail(slug)).event.breaks).toMatchObject([{ start: "10:00", label: "" }, { start: "11:00", label: "Café ☕ 😀" }]);
  });

  it("lists every slot of the schedule with its lane and the booking in it, if any", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 20 });
    const bookingId = await insertBooking(t.env.DB, id, "2026-10-24T08:20:00Z", "Rex", "Sam Smith");
    const { slots, orphans } = await detail(slug);
    const laneId = (await t.env.DB.prepare("SELECT id FROM event_lanes WHERE event_id = ?").bind(id).first<{ id: number }>())!.id;
    const free = [{ laneId, laneName: "", free: 1, bookings: [] }];
    expect(slots).toEqual([
      { start: "2026-10-24T08:00:00Z", end: "2026-10-24T08:20:00Z", places: free },
      {
        start: "2026-10-24T08:20:00Z", end: "2026-10-24T08:40:00Z",
        places: [{ laneId, laneName: "", free: 0, bookings: [{ id: bookingId, ...dh("Rex", "Sam Smith") }] }],
      },
      { start: "2026-10-24T08:40:00Z", end: "2026-10-24T09:00:00Z", places: free },
    ]);
    expect(orphans).toEqual([]);
  });

  it("lists, per slot, every lane with its bookings in place order and its free places", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T08:40:00Z", sessionMinutes: 20, capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const second = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Second", "H", { laneId: l1, place: 2 });
    const first = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "First", "H", { laneId: l1, place: 1 });
    const other = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Other", "H", { laneId: l2 });
    const { slots, orphans, event } = await detail(e.slug);
    expect(event).toMatchObject({ lanes: [{ id: l1, name: "Ring 1" }, { id: l2, name: "Ring 2" }], capacity: 2 });
    expect(slots[0].places).toEqual([
      { laneId: l1, laneName: "Ring 1", free: 0, bookings: [{ id: first, ...dh("First", "H") }, { id: second, ...dh("Second", "H") }] },
      { laneId: l2, laneName: "Ring 2", free: 1, bookings: [{ id: other, ...dh("Other", "H") }] },
    ]);
    expect(slots[1].places).toEqual([{ laneId: l1, laneName: "Ring 1", free: 2, bookings: [] }, { laneId: l2, laneName: "Ring 2", free: 2, bookings: [] }]);
    expect(orphans).toEqual([]);
  });

  it("has no v1.0 `booking` key on a slot, whether the one lane is named or not and whatever the capacity: the bookings are in `places`", async () => {
    const named = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T08:20:00Z", sessionMinutes: 20, lanes: ["Main"] });
    const b = await insertBooking(t.env.DB, named.id, "2026-10-24T08:00:00Z", "Rex", "Sam");
    const [slot] = (await detail(named.slug)).slots;
    expect(slot).not.toHaveProperty("booking");
    expect(slot.places[0].bookings).toEqual([{ id: b, ...dh("Rex", "Sam") }]);
    const wide = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T08:20:00Z", sessionMinutes: 20, capacity: 2 });
    await insertBooking(t.env.DB, wide.id, "2026-10-24T08:00:00Z", "Rex", "Sam");
    expect((await detail(wide.slug)).slots[0]).not.toHaveProperty("booking");
  });

  it("lists as orphans a booking at a time that is no slot, one at a place beyond the capacity, and keeps them out of `places`", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T08:20:00Z", sessionMinutes: 20, capacity: 2 });
    const ok = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Fine", "H", { place: 1 });
    const beyond = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Beyond", "H", { place: 3 });
    const stray = await insertBooking(t.env.DB, e.id, "2026-10-24T07:00:00Z", "Stray", "H");
    const { slots, orphans } = await detail(e.slug);
    expect(orphans.map((o) => o.id).sort()).toEqual([beyond, stray].sort());
    expect(slots[0].places[0]).toMatchObject({ free: 1, bookings: [{ id: ok }] });
  });

  it("surfaces bookings whose slot is not in the schedule as orphans instead of hiding them", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 20 });
    await insertBooking(t.env.DB, id, "2026-10-24T08:05:00Z", "Zed", "Zoe");
    const orphanId = await insertBooking(t.env.DB, id, "2026-10-24T07:00:00Z", "Early", "Eve");
    const { slots, orphans } = await detail(slug);
    expect(slots.every((s) => s.places.every((p) => p.bookings.length === 0))).toBe(true);
    expect(orphans.map((o) => o.fields[0].value)).toEqual(["Early", "Zed"]);
    expect(orphans[0]).toEqual({ id: orphanId, slotStart: "2026-10-24T07:00:00Z", ...dh("Early", "Eve"), lane: { id: expect.any(Number), name: "" } });
  });

  it("lists a configured form's values by label (a blank optional one left out), and the lineup joins only the identity fields' values, in the form's order", async () => {
    const fields = [{ label: "Rider", identity: true }, { label: "Pony", identity: true }, { label: "Phone", required: false }];
    const { id, slug } = await insertEvent(t.env.DB, { name: "Pony day", startUtc: "2026-03-14T09:00:00Z", endUtc: "2026-03-14T09:40:00Z", sessionMinutes: 20, venuePostcode: "AB1 2CD", fields });
    await insertBookingOf(t.env.DB, id, fields, "2026-03-14T09:00:00Z", ["Ann Lee", "Biscuit", "07700 900123"]);
    await insertBookingOf(t.env.DB, id, fields, "2026-03-14T09:20:00Z", ["Bea", "Nutmeg"]);
    const body = await detail(slug);
    expect(body.slots[0].places[0].bookings[0]).toMatchObject({ fields: [{ label: "Rider", value: "Ann Lee" }, { label: "Pony", value: "Biscuit" }, { label: "Phone", value: "07700 900123" }] });
    expect(body.slots[1].places[0].bookings[0]).toMatchObject({ fields: [{ label: "Rider", value: "Bea" }, { label: "Pony", value: "Nutmeg" }] });
    // The phone number is in the admin page's booking above, not in the lineup that is pasted into a chat.
    expect(body.lineup).toBe("Pony day\nSaturday 14 March 2026 · AB1 2CD\n\n09:00 — Ann Lee — Biscuit\n09:20 — Bea — Nutmeg");
  });

  it("includes the lineup text, equal to buildLineup on the same data, without orphans", async () => {
    const { id, slug } = await insertEvent(t.env.DB, {
      name: "Spring Trial", startUtc: "2026-03-14T09:00:00Z", endUtc: "2026-03-14T10:00:00Z", sessionMinutes: 20, venuePostcode: "AB1 2CD",
    });
    await insertBreak(t.env.DB, id, "2026-03-14T09:20:00Z", "2026-03-14T09:40:00Z", "Lunch");
    await insertBooking(t.env.DB, id, "2026-03-14T09:00:00Z", "Rex", "Sam Smith");
    await insertBooking(t.env.DB, id, "2026-03-14T09:05:00Z", "Orphan", "Olly");
    const body = await detail(slug);
    expect(body.lineup).toBe("Spring Trial\nSaturday 14 March 2026 · AB1 2CD\n\n09:00 — Rex — Sam Smith\n09:20–09:40 — Lunch\n09:40 — free");
    expect(body.lineup).toBe(buildLineup({
      name: "Spring Trial", venuePostcode: "AB1 2CD", startUtc: "2026-03-14T09:00:00Z", slots: body.slots,
      breaks: [{ start: "2026-03-14T09:20:00Z", end: "2026-03-14T09:40:00Z", label: "Lunch" }],
    }));
    expect(body.lineup).not.toContain("Orphan");
  });

  it("puts the club name on the first line of the lineup when one is set", async () => {
    const { slug } = await insertEvent(t.env.DB, {
      name: "Spring Trial", startUtc: "2026-03-14T09:00:00Z", endUtc: "2026-03-14T09:20:00Z", sessionMinutes: 20, venuePostcode: "AB1 2CD",
    });
    const plain = (await detail(slug)).lineup;
    const setClub = (clubName: string) => saveSettings(t.env.DB, { clubName, privacyContact: { name: "", email: "" }, website: "" });
    try {
      await setClub("Hillside Dog Club");
      expect((await detail(slug)).lineup).toBe(`Hillside Dog Club\n${plain}`);
      await setClub("");
      expect((await detail(slug)).lineup).toBe(plain);
    } finally {
      await setClub("");
    }
    expect(plain).toBe("Spring Trial\nSaturday 14 March 2026 · AB1 2CD\n\n09:00 — free");
  });

  it("shows an archived event, flagged", async () => {
    const { slug } = await insertEvent(t.env.DB, { archived: true });
    expect((await detail(slug)).event.archived).toBe(true);
  });

  it("returns 404 for an unknown or malformed slug, no-store", async () => {
    for (const slug of [generateSlug(), "nope", "x".repeat(100), "preview"]) {
      const res = await get(slug);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }
  });

  it("does not show another event's bookings", async () => {
    const a = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 20 });
    const b = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 20 });
    await insertBooking(t.env.DB, b.id, "2026-10-24T08:00:00Z", "Rex", "Sam");
    expect((await detail(a.slug)).slots.map((s) => s.places.flatMap((p) => p.bookings))).toEqual([[], [], []]);
  });

  it("refuses with 401 unless the guard set an admin identity", async () => {
    const { slug } = await insertEvent(t.env.DB);
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await get(slug, data);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

// ---- PUT ----

interface PutOptions { contentType?: string | null; raw?: string; data?: unknown[]; env?: unknown; noRev?: boolean }

const LAYOUT_KEYS = ["lanes", "capacity", "fields", "identityLimit"];

/**
 * A body that changes the lanes, capacity, fields or identity limit must carry the `configRev` of the page it was made on. These tests
 * stand for a page loaded just now, so unless the body names a `configRev` itself (or `noRev` is set) the event's current one is added.
 */
async function withPageRev(slug: string, body: unknown, noRev?: boolean): Promise<unknown> {
  const b = body as Record<string, unknown> | null;
  if (noRev || typeof b !== "object" || b === null || "configRev" in b || !LAYOUT_KEYS.some((k) => k in b)) return body;
  const row = await t.env.DB.prepare("SELECT config_rev FROM event_layout WHERE event_id = (SELECT id FROM events WHERE slug = ?)").bind(slug).first<{ config_rev: number }>();
  return { ...b, configRev: row?.config_rev ?? 0 };
}

const put = async (slug: string, body: unknown, o: PutOptions = {}): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  const sent = o.raw ?? JSON.stringify(await withPageRev(slug, body, o.noRev));
  return Promise.resolve(
    onRequestPut({
      request: new Request(`http://localhost/api/admin/events/${slug}`, { method: "PUT", headers, body: sent }),
      env: (o.env ?? t.env) as AppEnv, params: { slug }, data: o.data ? o.data[0] : ADMIN,
    } as unknown as Parameters<typeof onRequestPut>[0]),
  );
};

// 2026-10-24 (BST): 09:00-12:00 is 08:00Z-11:00Z, quarter-hour sessions, break 10:00-10:30 (09:00Z-09:30Z).
// Slot starts (Z): 08:00 08:15 08:30 08:45 | 09:30 09:45 10:00 10:15 10:30 10:45
const draft = (over: Record<string, unknown> = {}) => ({
  name: "Saturday trial day", date: "2026-10-24", start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 0,
  costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water", breaks: [{ start: "10:00", end: "10:30", label: "Lunch" }], ...over,
});

async function seed(over: Parameters<typeof insertEvent>[1] = {}) {
  const e = await insertEvent(t.env.DB, {
    name: "Saturday trial day", startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15,
    gapMinutes: 0, costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water", ...over,
  });
  await insertBreak(t.env.DB, e.id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z", "Lunch");
  await t.env.DB.prepare("UPDATE events SET idempotency_key = ? WHERE id = ?").bind(`key-${e.slug}`, e.id).run();
  return e;
}

/** Everything stored for the event, ids included, to prove a refused save changed nothing. */
async function snapshot(eventId: number): Promise<string> {
  const q = async (sql: string) => (await t.env.DB.prepare(sql).bind(eventId).all()).results;
  return JSON.stringify([
    await q("SELECT * FROM events WHERE id = ?"), await q("SELECT * FROM breaks WHERE event_id = ? ORDER BY id"),
    await q("SELECT * FROM bookings WHERE event_id = ? ORDER BY id"),
  ]);
}

interface Saved {
  event: Record<string, unknown>; slotCount: number;
  removed: { id: number; slotStart: string; fields: { label: string; value: string }[]; lane: { id: number; name: string } }[];
}
interface Conflict {
  error: { code: string; message: string };
  affected: { id: number; slotStart: string; fields: { label: string; value: string }[]; lane: { id: number; name: string } }[];
}
const storedBreaks = async (eventId: number) =>
  (await t.env.DB.prepare("SELECT start_utc, end_utc, label FROM breaks WHERE event_id = ? ORDER BY start_utc").bind(eventId).all()).results;
const bookingIds = async (eventId: number) =>
  (await t.env.DB.prepare("SELECT id FROM bookings WHERE event_id = ? ORDER BY id").bind(eventId).all<{ id: number }>()).results.map((r) => r.id);

describe("PUT /api/admin/events/[slug]: saving without bookings in the way", () => {
  it("changes every editable field, and not the slug, archived flag or idempotency key", async () => {
    const { id, slug } = await seed();
    const res = await put(slug, draft({
      name: "  Renamed day ", date: "2026-10-31", start: "10:00", end: "13:00", sessionMinutes: 20, gapMinutes: 5,
      costPence: 2000, venuePostcode: " cd3  4ef", details: "New details", breaks: [{ start: "11:00", end: "11:15", label: "Tea" }],
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Saved;
    expect(body.event).toEqual({
      slug, name: "Renamed day", archived: false, listed: true, date: "2026-10-31", start: "10:00", end: "13:00",
      sessionMinutes: 20, gapMinutes: 5, costPence: 2000, venuePostcode: "CD3 4EF", details: "New details", shareMessage: "",
      startUtc: "2026-10-31T10:00:00Z", endUtc: "2026-10-31T13:00:00Z",
      breaks: [{ start: "11:00", end: "11:15", label: "Tea", startUtc: "2026-10-31T11:00:00Z", endUtc: "2026-10-31T11:15:00Z" }],
      lanes: [{ id: expect.any(Number), name: "" }], capacity: 1,
      fields: [{ label: "Dog", required: true, maxLength: 80, identity: true }, { label: "Handler", required: true, maxLength: 80, identity: true }], identityLimit: 1,
      hasBookings: false, configRev: 0,
    });
    expect(body.removed).toEqual([]);
    expect(body.slotCount).toBe(6); // 10:00 10:25 | 11:15 11:40 12:05 12:30 (10:50 would overrun the break, 12:55 the end)
    const row = await t.env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      slug, name: "Renamed day", start_utc: "2026-10-31T10:00:00Z", end_utc: "2026-10-31T13:00:00Z", session_minutes: 20,
      gap_minutes: 5, cost_pence: 2000, venue_postcode: "CD3 4EF", details: "New details", archived: 0, idempotency_key: `key-${slug}`,
    });
    expect(await storedBreaks(id)).toEqual([{ start_utc: "2026-10-31T11:00:00Z", end_utc: "2026-10-31T11:15:00Z", label: "Tea" }]);
  });

  it("saves `listed` both ways, leaves it alone when the request has none, and changes nothing else", async () => {
    const { id, slug } = await seed();
    const other = async () => JSON.stringify(Object.entries((await t.env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<Record<string, unknown>>())!).filter(([k]) => k !== "listed"));
    const before = await other();
    const listed = async () => (await t.env.DB.prepare("SELECT listed FROM events WHERE id = ?").bind(id).first<{ listed: number }>())!.listed;
    const off = await put(slug, draft({ listed: false }));
    expect(off.status).toBe(200);
    expect(((await off.json()) as Saved).event.listed).toBe(false);
    expect(await listed()).toBe(0);
    expect((await put(slug, draft())).status).toBe(200);
    expect(await listed()).toBe(0);
    expect(((await (await put(slug, draft({ listed: true }))).json()) as Saved).event.listed).toBe(true);
    expect(await listed()).toBe(1);
    expect(await other()).toBe(before);
  });

  it("refuses a `listed` that is not true or false with 400, changing nothing", async () => {
    const { id, slug } = await seed();
    const before = await snapshot(id);
    const res = await put(slug, draft({ listed: "yes" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({ listed: "Listed must be true or false." });
    expect(await snapshot(id)).toBe(before);
  });

  it("answers the same event a following GET shows", async () => {
    const { slug } = await seed();
    const saved = (await (await put(slug, draft({ name: "Again", breaks: [] }))).json()) as Saved;
    expect(saved.event).toEqual((await detail(slug)).event);
  });

  it("round-trips an unchanged event: what GET returns, PUT saves without changing anything", async () => {
    const { id, slug } = await seed();
    const before = await snapshot(id);
    const { event } = await detail(slug);
    const { slug: _s, archived: _a, startUtc: _su, endUtc: _eu, ...fields } = event as Record<string, unknown>;
    const breaks = (event.breaks as { start: string; end: string; label: string }[]).map(({ start, end, label }) => ({ start, end, label }));
    const res = await put(slug, { ...fields, breaks });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Saved).removed).toEqual([]);
    // Break ids are new (they are replaced); everything else is as it was.
    const strip = (snap: string) => snap.replace(/"id":\d+,"event_id"/g, '"event_id"');
    expect(strip(await snapshot(id))).toBe(strip(before));
  });

  it("round-trips an event on the day the clocks go forward (2026-03-29)", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-03-29T00:30:00Z", endUtc: "2026-03-29T09:00:00Z", sessionMinutes: 30 });
    await insertBreak(t.env.DB, id, "2026-03-29T02:30:00Z", "2026-03-29T03:00:00Z", "Tea");
    const { event } = await detail(slug);
    const res = await put(slug, { ...event, breaks: event.breaks });
    expect(res.status).toBe(200);
    expect((await detail(slug)).event).toEqual(event);
  });

  it("round-trips an event on the day the clocks go back (2026-10-25)", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-24T23:30:00Z", endUtc: "2026-10-25T10:00:00Z", sessionMinutes: 30 });
    await insertBreak(t.env.DB, id, "2026-10-25T09:00:00Z", "2026-10-25T09:30:00Z", "Tea");
    const { event } = await detail(slug);
    const res = await put(slug, { ...event, breaks: event.breaks });
    expect(res.status).toBe(200);
    expect((await detail(slug)).event).toEqual(event);
  });

  it("edits an archived event", async () => {
    const { id, slug } = await seed({ archived: true });
    expect((await put(slug, draft({ name: "Archived but fixed" }))).status).toBe(200);
    expect(await t.env.DB.prepare("SELECT name, archived FROM events WHERE id = ?").bind(id).first()).toEqual({ name: "Archived but fixed", archived: 1 });
  });

  it("changes the schedule the public page offers", async () => {
    const { slug } = await seed();
    await put(slug, draft({ end: "10:30", breaks: [] }));
    const res = await publicGet({ request: new Request(`http://localhost/api/events/${slug}`), env: { DB: t.env.DB }, params: { slug } } as never);
    const { slots, event } = (await res.json()) as { slots: { start: string }[]; event: { name: string } };
    expect(slots.map((s) => s.start)).toEqual(["2026-10-24T08:00:00Z", "2026-10-24T08:15:00Z", "2026-10-24T08:30:00Z", "2026-10-24T08:45:00Z", "2026-10-24T09:00:00Z", "2026-10-24T09:15:00Z"]);
    expect(event.name).toBe("Saturday trial day");
  });

  describe("breaks", () => {
    it("adds a break", async () => {
      const { id, slug } = await seed();
      const breaks = [{ start: "10:00", end: "10:30", label: "Lunch" }, { start: "11:00", end: "11:10", label: "😀 Water" }];
      expect((await put(slug, draft({ breaks }))).status).toBe(200);
      expect(await storedBreaks(id)).toEqual([
        { start_utc: "2026-10-24T09:00:00Z", end_utc: "2026-10-24T09:30:00Z", label: "Lunch" },
        { start_utc: "2026-10-24T10:00:00Z", end_utc: "2026-10-24T10:10:00Z", label: "😀 Water" },
      ]);
    });

    it("removes the breaks", async () => {
      const { id, slug } = await seed();
      const saved = (await (await put(slug, draft({ breaks: [] }))).json()) as Saved;
      expect(await storedBreaks(id)).toEqual([]);
      expect(saved.slotCount).toBe(12);
    });

    it("relabels a break", async () => {
      const { id, slug } = await seed();
      await put(slug, draft({ breaks: [{ start: "10:00", end: "10:30", label: "  Coffee " }] }));
      expect(await storedBreaks(id)).toEqual([{ start_utc: "2026-10-24T09:00:00Z", end_utc: "2026-10-24T09:30:00Z", label: "Coffee" }]);
    });

    it("retimes a break, and an unnamed one stays unnamed", async () => {
      const { id, slug } = await seed();
      await put(slug, draft({ breaks: [{ start: "10:30", end: "11:00" }] }));
      expect(await storedBreaks(id)).toEqual([{ start_utc: "2026-10-24T09:30:00Z", end_utc: "2026-10-24T10:00:00Z", label: "" }]);
    });
  });
});

describe("PUT /api/admin/events/[slug]: bookings that would lose their slot", () => {
  // Extra bookings: A on a slot that stays, B and C on the two slots 11:30 as the end drops.
  async function withBookings() {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Alpha", "Ann");
    const b = await insertBooking(t.env.DB, e.id, "2026-10-24T10:30:00Z", "Bravo", "Bob");
    const c = await insertBooking(t.env.DB, e.id, "2026-10-24T10:45:00Z", "Charlie", "Cat");
    return { ...e, a, b, c };
  }
  const shorter = (over: Record<string, unknown> = {}) => draft({ end: "11:30", ...over });
  const listOf = (e: { b: number; c: number }) => [
    { id: e.b, slotStart: "2026-10-24T10:30:00Z", ...dh("Bravo", "Bob"), lane: { id: expect.any(Number), name: "" } },
    { id: e.c, slotStart: "2026-10-24T10:45:00Z", ...dh("Charlie", "Cat"), lane: { id: expect.any(Number), name: "" } },
  ];

  it("saves a change to `listed` alone with bookings present: no 409, nothing removed, bookings kept", async () => {
    const e = await withBookings();
    const res = await put(e.slug, draft({ listed: false }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Saved).removed).toEqual([]);
    expect(await bookingIds(e.id)).toEqual([e.a, e.b, e.c]);
  });

  it("saves an extended end time with the bookings left alone", async () => {
    const e = await withBookings();
    const res = await put(e.slug, draft({ end: "13:00" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Saved).removed).toEqual([]);
    expect(await bookingIds(e.id)).toEqual([e.a, e.b, e.c]);
    expect((await t.env.DB.prepare("SELECT end_utc FROM events WHERE id = ?").bind(e.id).first())).toEqual({ end_utc: "2026-10-24T12:00:00Z" });
  });

  it("refuses with 409 and the exact list when slots vanish, changing nothing", async () => {
    const e = await withBookings();
    const before = await snapshot(e.id);
    for (const removeBookingIds of [undefined, [], [e.a]]) {
      const res = await put(e.slug, shorter({ name: "Should not save", breaks: [], removeBookingIds }));
      expect(res.status).toBe(409);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as Conflict;
      expect(body.error.code).toBe("bookings_affected");
      expect(body.affected).toEqual(listOf(e));
      expect(await snapshot(e.id)).toBe(before);
    }
  });

  it("saves and removes exactly the confirmed bookings, leaving the others", async () => {
    const e = await withBookings();
    const res = await put(e.slug, shorter({ name: "Shortened", removeBookingIds: [e.c, e.b] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Saved;
    expect(body.removed).toEqual(listOf(e));
    expect(body.event).toMatchObject({ name: "Shortened", end: "11:30", endUtc: "2026-10-24T10:30:00Z" });
    expect(await bookingIds(e.id)).toEqual([e.a]);
    expect(await t.env.DB.prepare("SELECT name, end_utc FROM events WHERE id = ?").bind(e.id).first()).toEqual({ name: "Shortened", end_utc: "2026-10-24T10:30:00Z" });
    expect(await t.env.DB.prepare("SELECT value_1 AS dog_name FROM bookings WHERE id = ?").bind(e.a).first()).toEqual({ dog_name: "Alpha" });
  });

  it("answers hasBookings from what is left after the save: true while a booking stays, false once the last one is removed", async () => {
    const e = await withBookings();
    const kept = (await (await put(e.slug, shorter({ removeBookingIds: [e.c, e.b] }))).json()) as Saved;
    expect(kept.event.hasBookings).toBe(true);
    const f = await withBookings();
    const emptied = (await (await put(f.slug, draft({ start: "13:00", end: "14:00", breaks: [], removeBookingIds: [f.a, f.b, f.c] }))).json()) as Saved;
    expect(emptied.removed).toHaveLength(3);
    expect(emptied.event.hasBookings).toBe(false);
  });

  it("refuses a partial confirmation with 409 listing all of them, changing nothing", async () => {
    const e = await withBookings();
    const before = await snapshot(e.id);
    const res = await put(e.slug, shorter({ removeBookingIds: [e.b] }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as Conflict).affected).toEqual(listOf(e));
    expect(await snapshot(e.id)).toBe(before);
  });

  it("never deletes a confirmed booking whose slot stays, nor one from another event", async () => {
    const e = await withBookings();
    const other = await seed();
    const foreign = await insertBooking(t.env.DB, other.id, "2026-10-24T10:30:00Z", "Foreign", "Fay");
    const res = await put(e.slug, shorter({ removeBookingIds: [e.a, e.b, e.c, foreign, 999_999] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Saved).removed.map((r) => r.id)).toEqual([e.b, e.c]);
    expect(await bookingIds(e.id)).toEqual([e.a]);
    expect(await bookingIds(other.id)).toEqual([foreign]);
  });

  it("counts every booking as affected when a new session length shifts all the slots", async () => {
    const e = await seed();
    const x = await insertBooking(t.env.DB, e.id, "2026-10-24T08:15:00Z", "Xena", "Xan");
    const y = await insertBooking(t.env.DB, e.id, "2026-10-24T08:30:00Z", "Yuki", "Yan");
    const res = await put(e.slug, draft({ sessionMinutes: 16 }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as Conflict).affected.map((a) => a.id)).toEqual([x, y]);
    const ok = await put(e.slug, draft({ sessionMinutes: 16, removeBookingIds: [y, x] }));
    expect(((await ok.json()) as Saved).removed.map((r) => r.id)).toEqual([x, y]);
    expect(await bookingIds(e.id)).toEqual([]);
  });

  it("answers a retry of a confirmed save with 200 and nothing left to remove", async () => {
    const e = await withBookings();
    const body = shorter({ removeBookingIds: [e.b, e.c] });
    expect(((await (await put(e.slug, body)).json()) as Saved).removed).toHaveLength(2);
    const again = await put(e.slug, body);
    expect(again.status).toBe(200);
    expect(((await again.json()) as Saved).removed).toEqual([]);
    expect(await bookingIds(e.id)).toEqual([e.a]);
  });

  /** The public booking request for one slot, repeatable byte for byte (same idempotency key and payload). */
  const publicRequest = (slug: string, slot: string, key: string) => () => book({
    request: new Request(`http://localhost/api/events/${slug}/bookings`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot, field1: "Rex", field2: "Sam Smith", idempotencyKey: key }),
    }),
    env: t.env, params: { slug },
  } as unknown as Parameters<typeof book>[0]);

  it("answers a replayed public request invalid_slot, revealing nothing, once an edit has removed the booking's slot", async () => {
    const e = await seed();
    const request = publicRequest(e.slug, "2026-10-24T10:45:00Z", generateSlug());
    expect((await request()).status).toBe(201);
    const [{ id }] = (await t.env.DB.prepare("SELECT id FROM bookings WHERE event_id = ?").bind(e.id).all<{ id: number }>()).results;
    expect((await put(e.slug, shorter({ removeBookingIds: [id] }))).status).toBe(200);
    expect(await bookingIds(e.id)).toEqual([]);
    const replay = await request();
    expect(replay.status).toBe(400);
    const replayBody = (await replay.json()) as { error: { code: string }; booking?: unknown };
    expect(replayBody.error.code).toBe("invalid_slot");
    expect(replayBody.booking).toBeUndefined();
    expect(await bookingIds(e.id)).toEqual([]);
  });

  it("documents the accepted behaviour after an admin Clear of a surviving slot: the same replayed request books it afresh (201), because the key went with the booking", async () => {
    const e = await seed();
    const request = publicRequest(e.slug, "2026-10-24T08:15:00Z", generateSlug());
    expect((await request()).status).toBe(201);
    const [{ id }] = (await t.env.DB.prepare("SELECT id FROM bookings WHERE event_id = ?").bind(e.id).all<{ id: number }>()).results;
    const cleared = await clearBooking({
      request: new Request("http://localhost/api/admin/x", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) }),
      env: t.env, params: { slug: e.slug, id: String(id) }, data: ADMIN,
    } as unknown as Parameters<typeof clearBooking>[0]);
    expect(cleared.status).toBe(200);
    expect(await bookingIds(e.id)).toEqual([]);
    const replay = await request();
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBeNull(); // a new booking, not a replay of the old one
    expect(await bookingIds(e.id)).toHaveLength(1);
    expect(await bookingIds(e.id)).not.toEqual([id]);
  });
});

describe("PUT /api/admin/events/[slug]: when the start may change", () => {
  const PAST = { startUtc: "2026-09-01T08:00:00Z", endUtc: "2026-09-01T11:00:00Z" }; // before NOW (2026-10-01)
  const pastDraft = (over: Record<string, unknown> = {}) => draft({ date: "2026-09-01", breaks: [], ...over });

  it("lets a past event be renamed or have its end corrected, as its start is unchanged", async () => {
    const { id, slug } = await insertEvent(t.env.DB, PAST);
    expect((await put(slug, pastDraft({ name: "Fixed typo" }))).status).toBe(200);
    expect((await put(slug, pastDraft({ name: "Fixed typo", end: "13:00" }))).status).toBe(200);
    expect(await t.env.DB.prepare("SELECT name, end_utc FROM events WHERE id = ?").bind(id).first()).toEqual({ name: "Fixed typo", end_utc: "2026-09-01T12:00:00Z" });
  });

  it("lets a running event be edited too", async () => {
    vi.setSystemTime(new Date("2026-10-24T09:30:00Z"));
    const { slug } = await seed();
    expect((await put(slug, draft({ details: "Moved the car park" }))).status).toBe(200);
  });

  it("refuses moving the start of a past event into the past, as create does", async () => {
    const { id, slug } = await insertEvent(t.env.DB, PAST);
    const before = await snapshot(id);
    const res = await put(slug, pastDraft({ date: "2026-09-02" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_input", message: "Check the highlighted fields." }, fields: { date: "The event must start in the future." },
    });
    expect(await snapshot(id)).toBe(before);
  });

  it("refuses moving a future event into the past, and more than two years ahead", async () => {
    const { id, slug } = await seed();
    const before = await snapshot(id);
    const past = await put(slug, draft({ date: "2026-09-30" }));
    expect(past.status).toBe(400);
    expect(((await past.json()) as { fields: unknown }).fields).toEqual({ date: "The event must start in the future." });
    const far = await put(slug, draft({ date: "2029-01-10" }));
    expect(far.status).toBe(400);
    expect(((await far.json()) as { fields: unknown }).fields).toEqual({ date: "That date is more than two years away. Check it." });
    expect(await snapshot(id)).toBe(before);
  });

  it("allows moving an event to another future date", async () => {
    const { id, slug } = await seed();
    expect((await put(slug, draft({ date: "2026-11-07" }))).status).toBe(200);
    expect(await t.env.DB.prepare("SELECT start_utc FROM events WHERE id = ?").bind(id).first()).toEqual({ start_utc: "2026-11-07T09:00:00Z" });
  });
});

describe("PUT /api/admin/events/[slug]: invalid requests", () => {
  it("returns the same per-field messages as create, changing nothing", async () => {
    const { id, slug } = await seed();
    const before = await snapshot(id);
    const res = await put(slug, draft({ name: "", breaks: [{ start: "9", end: "10:00" }, { start: "10:00", end: "10:30", label: "x".repeat(41) }] }));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: { code: "invalid_input", message: "Check the highlighted fields." },
      fields: { name: "Enter the event name.", "breaks.0.start": "Enter a time as HH:MM.", "breaks.1.label": "The break name must be at most 40 characters." },
    });
    expect(await snapshot(id)).toBe(before);
  });

  it("reports every field for junk", async () => {
    const { slug } = await seed();
    const res = await put(slug, { name: 1, date: 2, start: [], end: {}, sessionMinutes: "x", gapMinutes: null, costPence: true, venuePostcode: 0, details: 0, breaks: "no" });
    expect(Object.keys(((await res.json()) as { fields: object }).fields).sort()).toEqual([
      "breaks", "costPence", "date", "details", "end", "gapMinutes", "name", "sessionMinutes", "start", "venuePostcode",
    ]);
  });

  it("refuses a draft that makes no slots or too many", async () => {
    const { slug } = await seed();
    expect(((await (await put(slug, draft({ end: "09:10", breaks: [] }))).json()) as { fields: unknown }).fields).toEqual({ end: "No sessions fit between the start and end." });
    expect(((await (await put(slug, draft({ sessionMinutes: 1, start: "00:00", end: "23:00", breaks: [] }))).json()) as { fields: unknown }).fields)
      .toEqual({ sessionMinutes: "That would make more than 500 slots." });
  });

  it("validates removeBookingIds: a list of at most 500 positive integers", async () => {
    const { id, slug } = await seed();
    const before = await snapshot(id);
    const bad: unknown[] = ["1", 5, {}, [0], [-1], [1.5], ["1"], [null], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: 501 }, (_, i) => i + 1)];
    for (const removeBookingIds of bad) {
      const res = await put(slug, draft({ removeBookingIds }));
      expect(res.status).toBe(400);
      expect(Object.keys(((await res.json()) as { fields: object }).fields)).toEqual(["removeBookingIds"]);
    }
    expect(await snapshot(id)).toBe(before);
    expect((await put(slug, draft({ removeBookingIds: Array.from({ length: 500 }, (_, i) => i + 1) }))).status).toBe(200);
    expect((await put(slug, draft({ removeBookingIds: null }))).status).toBe(400);
  });

  it("reports a bad removeBookingIds alongside the draft's own errors", async () => {
    const { slug } = await seed();
    const res = await put(slug, draft({ name: "", removeBookingIds: [0] }));
    expect(Object.keys(((await res.json()) as { fields: object }).fields).sort()).toEqual(["name", "removeBookingIds"]);
  });

  it("returns 415, 400 and 413 as create does", async () => {
    const { id, slug } = await seed();
    const before = await snapshot(id);
    expect((await put(slug, draft(), { contentType: "text/plain" })).status).toBe(415);
    expect((await put(slug, draft(), { contentType: null })).status).toBe(415);
    expect((await put(slug, undefined, { raw: "{nope" })).status).toBe(400);
    expect((await put(slug, undefined, { raw: "[1]" })).status).toBe(400);
    const big = await put(slug, { ...draft(), padding: "x".repeat(33_000) });
    expect(big.status).toBe(413);
    expect(big.headers.get("cache-control")).toBe("no-store");
    expect(await snapshot(id)).toBe(before);
  });

  it("returns 404 for an unknown or malformed slug, writing nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    for (const slug of [generateSlug(), "nope"]) {
      const res = await put(slug, draft());
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("refuses with 401 unless the guard set an admin identity", async () => {
    const { id, slug } = await seed();
    const before = await snapshot(id);
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await put(slug, draft({ name: "Hijacked" }), { data: [data] });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await snapshot(id)).toBe(before);
  });
});

describe("PUT /api/admin/events/[slug]: text already stored with an invisible character", () => {
  const FLAG_DETAILS = "Bring water \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} 👩\u200D🐕";
  const MESSAGE = (what: string) =>
    `The ${what} can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.`;
  const seedZwj = async () => {
    const e = await seed({ name: "Dogs\u200D day", details: FLAG_DETAILS });
    await t.env.DB.prepare("UPDATE breaks SET label = ? WHERE event_id = ?").bind("Lunch\u200C", e.id).run();
    return e;
  };
  const same = { name: "Dogs\u200D day", details: FLAG_DETAILS, breaks: [{ start: "10:00", end: "10:30", label: "Lunch\u200C" }] };

  it("saves a changed cost with the name, details and break name left as they are", async () => {
    const { id, slug } = await seedZwj();
    const res = await put(slug, draft({ ...same, costPence: 2500 }));
    expect(res.status).toBe(200);
    const row = await t.env.DB.prepare("SELECT name, details, cost_pence FROM events WHERE id = ?").bind(id).first();
    expect(row).toEqual({ name: "Dogs\u200D day", details: FLAG_DETAILS, cost_pence: 2500 });
    expect(await storedBreaks(id)).toMatchObject([{ label: "Lunch\u200C" }]);
  });

  it("still refuses details changed to a different value with one, naming the field in plain words", async () => {
    const { id, slug } = await seedZwj();
    const before = await snapshot(id);
    const res = await put(slug, draft({ ...same, details: `${FLAG_DETAILS} too` }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({ details: MESSAGE("details") });
    expect(await snapshot(id)).toBe(before);
  });

  it("still refuses an event name changed to a different value with one", async () => {
    const { id, slug } = await seedZwj();
    const before = await snapshot(id);
    const res = await put(slug, draft({ ...same, name: "Other\u200D day" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({ name: MESSAGE("event name") });
    expect(await snapshot(id)).toBe(before);
  });

  it("accepts a break name equal to one of the event's existing break names, and refuses a changed one", async () => {
    const { id, slug } = await seedZwj();
    const res = await put(slug, draft({ ...same, breaks: [{ start: "10:00", end: "10:30", label: "Lunch\u200C" }, { start: "11:00", end: "11:15", label: "Lunch\u200C" }] }));
    expect(res.status).toBe(200);
    const before = await snapshot(id);
    const bad = await put(slug, draft({ ...same, breaks: [{ start: "10:00", end: "10:30", label: "Tea\u200C" }] }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { fields: unknown }).fields).toEqual({ "breaks.0.label": MESSAGE("break name") });
    expect(await snapshot(id)).toBe(before);
  });

  it("still applies the other checks to an unchanged value (a line separator is refused)", async () => {
    const { slug } = await seed({ name: "Dogs\u200D day", details: "Pay\u2028now\u200D" });
    const res = await put(slug, draft({ name: "Dogs\u200D day", details: "Pay\u2028now\u200D", breaks: [] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: Record<string, string> }).fields.details).toMatch(/line or paragraph separators/);
  });
});

describe("share message: GET and PUT /api/admin/events/[slug]", () => {
  const storedShare = async (id: number) =>
    (await t.env.DB.prepare("SELECT share_message AS m FROM events WHERE id = ?").bind(id).first<{ m: string }>())!.m;
  const FIELD_MESSAGE = "The share message can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.";

  it("returns the event's share message in the detail and in the saved event", async () => {
    const { slug } = await seed({ shareMessage: "Come to {event}" });
    expect((await detail(slug)).event.shareMessage).toBe("Come to {event}");
    const saved = (await (await put(slug, draft({ shareMessage: "Come to {event}" }))).json()) as Saved;
    expect(saved.event.shareMessage).toBe("Come to {event}");
  });

  it("changes the message when the request has one, including to the empty one", async () => {
    const { id, slug } = await seed({ shareMessage: "Old message" });
    const changed = await put(slug, draft({ shareMessage: "New {event}\r\nline two" }));
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as Saved).event.shareMessage).toBe("New {event}\nline two");
    expect(await storedShare(id)).toBe("New {event}\nline two");
    expect((await detail(slug)).event.shareMessage).toBe("New {event}\nline two");
    expect((await put(slug, draft({ shareMessage: "" }))).status).toBe(200);
    expect(await storedShare(id)).toBe("");
  });

  it("leaves the message as it is when the request has none, whatever else it changes", async () => {
    const { id, slug } = await seed({ shareMessage: "Keep me" });
    const res = await put(slug, draft({ costPence: 2500, name: "Renamed" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Saved;
    expect(body.event).toMatchObject({ costPence: 2500, name: "Renamed", shareMessage: "Keep me" });
    expect(await storedShare(id)).toBe("Keep me");
  });

  it("leaves the message as it is in the database now, not as it was when the event was loaded", async () => {
    const { id, slug } = await seed({ shareMessage: "Before" });
    const hooked = {
      prepare: (q: string) => t.env.DB.prepare(q),
      batch: async (statements: D1PreparedStatement[]) => {
        await t.env.DB.prepare("UPDATE events SET share_message = 'Changed meanwhile' WHERE id = ?").bind(id).run();
        return t.env.DB.batch(statements);
      },
    };
    expect((await put(slug, draft({ costPence: 1600 }), { env: { DB: hooked } })).status).toBe(200);
    expect(await storedShare(id)).toBe("Changed meanwhile");
  });

  it.each([
    ["a number", 5, "The share message must be text (it can be empty)."],
    ["null", null, "The share message must be text (it can be empty)."],
    ["too long", "x".repeat(1001), "The share message must be at most 1000 characters."],
    ["with a line separator", "a\u2028b", "The share message can't contain line or paragraph separators."],
    ["with a control character", "a\u0007b", "The share message can't contain control characters."],
    ["with an invisible character", "a\u202Eb", FIELD_MESSAGE],
  ])("refuses a message that is %s, changing nothing", async (_n, shareMessage, message) => {
    const { id, slug } = await seed({ shareMessage: "Keep me" });
    const before = await snapshot(id);
    const res = await put(slug, draft({ shareMessage, costPence: 1 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({ shareMessage: message });
    expect(await snapshot(id)).toBe(before);
  });

  describe("a message already stored with an invisible character", () => {
    const LEGACY = "Join us \u200D now";
    it("saves a changed cost with the message sent back unchanged, and keeps it", async () => {
      const { id, slug } = await seed({ shareMessage: LEGACY });
      const res = await put(slug, draft({ shareMessage: LEGACY, costPence: 2500 }));
      expect(res.status).toBe(200);
      expect(await t.env.DB.prepare("SELECT share_message AS m, cost_pence AS c FROM events WHERE id = ?").bind(id).first()).toEqual({ m: LEGACY, c: 2500 });
    });

    it("saves a changed cost when the request leaves the message out", async () => {
      const { id, slug } = await seed({ shareMessage: LEGACY });
      expect((await put(slug, draft({ costPence: 2600 }))).status).toBe(200);
      expect(await storedShare(id)).toBe(LEGACY);
    });

    it("still refuses a changed message that has one, and a stored line separator", async () => {
      const { id, slug } = await seed({ shareMessage: LEGACY });
      const before = await snapshot(id);
      const res = await put(slug, draft({ shareMessage: `${LEGACY} too` }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { fields: unknown }).fields).toEqual({ shareMessage: FIELD_MESSAGE });
      expect(await snapshot(id)).toBe(before);
      const bad = await seed({ shareMessage: "a\u2028b\u200D" });
      const refused = await put(bad.slug, draft({ shareMessage: "a\u2028b\u200D" }));
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { fields: Record<string, string> }).fields.shareMessage).toMatch(/line or paragraph separators/);
    });
  });
});

describe("GET /api/admin/events/[slug]: defaultShareMessage", () => {
  beforeEach(async () => { await t.env.DB.prepare("DELETE FROM event_templates").run(); });

  it("is the default template's share message, whatever the event's own message is", async () => {
    const { slug } = await seed({ shareMessage: "Mine" });
    expect((await detail(slug)).defaultShareMessage).toBe("");
    await insertTemplate(t.env.DB, { name: "Other", shareMessage: "Not this one" });
    await insertTemplate(t.env.DB, { name: "Default", isDefault: true, shareMessage: "Default {event}" });
    const body = await detail(slug);
    expect(body.defaultShareMessage).toBe("Default {event}");
    expect(body.event.shareMessage).toBe("Mine");
  });

  it("is empty when the default template's message is empty, and when no template is the default", async () => {
    const { slug } = await seed();
    const def = await insertTemplate(t.env.DB, { name: "Default", isDefault: true });
    await insertTemplate(t.env.DB, { name: "Other", shareMessage: "Not this one" });
    expect((await detail(slug)).defaultShareMessage).toBe("");
    await t.env.DB.prepare("UPDATE event_templates SET is_default = 0 WHERE id = ?").bind(def.id).run();
    expect((await detail(slug)).defaultShareMessage).toBe("");
  });
});

// ---- DELETE ----

const del = (slug: string, body: unknown, o: PutOptions = {}): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  return Promise.resolve(
    onRequestDelete({
      request: new Request(`http://localhost/api/admin/events/${slug}`, { method: "DELETE", headers, body: o.raw ?? JSON.stringify(body) }),
      env: (o.env ?? t.env) as AppEnv, params: { slug }, data: o.data ? o.data[0] : ADMIN,
    } as unknown as Parameters<typeof onRequestDelete>[0]),
  );
};

/** [events, breaks, bookings] rows stored for one event: proves what a refused or successful delete did. */
async function rowsOf(eventId: number): Promise<number[]> {
  const n = async (sql: string) => (await t.env.DB.prepare(sql).bind(eventId).first<{ n: number }>())!.n;
  return [
    await n("SELECT COUNT(*) AS n FROM events WHERE id = ?"), await n("SELECT COUNT(*) AS n FROM breaks WHERE event_id = ?"),
    await n("SELECT COUNT(*) AS n FROM bookings WHERE event_id = ?"),
  ];
}
const orphans = async (): Promise<number> => (await t.env.DB.prepare(
  `SELECT (SELECT COUNT(*) FROM bookings WHERE event_id NOT IN (SELECT id FROM events))
        + (SELECT COUNT(*) FROM breaks WHERE event_id NOT IN (SELECT id FROM events)) AS n`,
).first<{ n: number }>())!.n;

describe("DELETE /api/admin/events/[slug]", () => {
  const NAME = "Saturday trial day";
  async function withData(name = NAME) {
    const e = await seed({ name });
    await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Alpha", "Ann");
    await insertBooking(t.env.DB, e.id, "2026-10-24T08:15:00Z", "Bravo", "Bob");
    return e;
  }

  it("refuses a missing, empty, mis-cased, padded or non-string name with 400 confirmation_mismatch, deleting nothing", async () => {
    const e = await withData();
    for (const body of [{}, { confirmName: "" }, { confirmName: "saturday trial day" }, { confirmName: `${NAME} ` }, { confirmName: ` ${NAME}` },
      { confirmName: "Saturday  trial day" }, { confirmName: null }, { confirmName: 5 }, { confirmName: [NAME] }, { confirmName: { name: NAME } },
      { confirmName: true }, { name: NAME }]) {
      const res = await del(e.slug, body);
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: { code: "confirmation_mismatch", message: "Type the event's name exactly to delete it." } });
      expect(await rowsOf(e.id)).toEqual([1, 1, 2]);
    }
  });

  it("compares the raw strings: another Unicode form of the name does not match", async () => {
    const e = await withData("Caf\u00e9 trial"); // precomposed e-acute
    const res = await del(e.slug, { confirmName: "Cafe\u0301 trial" }); // e + combining acute
    expect(res.status).toBe(400);
    expect(await rowsOf(e.id)).toEqual([1, 1, 2]);
    expect((await del(e.slug, { confirmName: "Caf\u00e9 trial" })).status).toBe(200);
  });

  it("deletes the event, its breaks and its bookings, and answers what went, leaving another event untouched", async () => {
    const e = await withData();
    const other = await withData("Other day");
    const res = await del(e.slug, { confirmName: NAME });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ deleted: { slug: e.slug, name: NAME, bookings: 2 } });
    expect(await rowsOf(e.id)).toEqual([0, 0, 0]);
    expect(await rowsOf(other.id)).toEqual([1, 1, 2]);
    expect(await orphans()).toBe(0);
    expect((await get(e.slug)).status).toBe(404);
  });

  it("reports zero bookings for an event with none, and deletes an archived or past event too", async () => {
    const empty = await insertEvent(t.env.DB, { name: "Quiet", archived: true, startUtc: "2026-01-01T08:00:00Z", endUtc: "2026-01-01T09:00:00Z" });
    const res = await del(empty.slug, { confirmName: "Quiet" });
    expect(await res.json()).toEqual({ deleted: { slug: empty.slug, name: "Quiet", bookings: 0 } });
    expect(await rowsOf(empty.id)).toEqual([0, 0, 0]);
  });

  it("returns 404 for an unknown or malformed slug, and for a second delete, deleting nothing else", async () => {
    const keep = await withData("Keeper");
    for (const slug of [generateSlug(), "nope"]) {
      const res = await del(slug, { confirmName: "anything" });
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }
    const e = await withData();
    expect((await del(e.slug, { confirmName: NAME })).status).toBe(200);
    const again = await del(e.slug, { confirmName: NAME });
    expect(again.status).toBe(404);
    expect(await rowsOf(keep.id)).toEqual([1, 1, 2]);
  });

  it("answers a save racing the delete with a clean 200 or 404, never an error, and leaves no orphan rows", async () => {
    for (let i = 0; i < 5; i++) {
      const e = await withData();
      const [saved, deleted] = await Promise.all([put(e.slug, draft({ name: "Renamed in flight" })), del(e.slug, { confirmName: NAME })]);
      expect([200, 404]).toContain(saved.status);
      expect([200, 400]).toContain(deleted.status); // 400: the save renamed it first, so the typed name no longer matches
      expect(await orphans()).toBe(0);
    }
  });

  it("refuses with 401 unless the guard set an admin identity, deleting nothing", async () => {
    const e = await withData();
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      expect((await del(e.slug, { confirmName: NAME }, { data: [data] })).status).toBe(401);
    }
    expect(await rowsOf(e.id)).toEqual([1, 1, 2]);
  });

  it("returns 415, 400 and 413 for bad bodies, deleting nothing", async () => {
    const e = await withData();
    expect((await del(e.slug, { confirmName: NAME }, { contentType: "text/plain" })).status).toBe(415);
    expect((await del(e.slug, undefined, { raw: "" })).status).toBe(400);
    expect((await del(e.slug, undefined, { raw: "[1]" })).status).toBe(400);
    expect((await del(e.slug, { confirmName: NAME, padding: "x".repeat(40_000) })).status).toBe(413);
    expect(await rowsOf(e.id)).toEqual([1, 1, 2]);
  });
});

describe("PUT /api/admin/events/[slug]: lanes and capacity", () => {
  const lanesOf = async (id: number) => (await t.env.DB.prepare("SELECT id, name FROM event_lanes WHERE event_id = ? ORDER BY position").bind(id).all<{ id: number; name: string }>()).results;
  const capacityOf = async (id: number) => (await t.env.DB.prepare("SELECT capacity, config_rev FROM event_layout WHERE event_id = ?").bind(id).first())!;

  it("saves new lanes and a capacity, returns them with their ids, and the detail shows the same", async () => {
    const e = await seed({ lanes: ["Ring 1"] });
    const res = await put(e.slug, draft({ lanes: [{ id: e.laneIds[0], name: "Main" }, { name: "Side" }], capacity: 2 }));
    expect(res.status).toBe(200);
    const saved = (await res.json()) as Saved;
    const stored = await lanesOf(e.id);
    expect(stored.map((l) => l.name)).toEqual(["Main", "Side"]);
    expect(saved.event).toMatchObject({ lanes: stored, capacity: 2 });
    expect((await detail(e.slug)).event).toMatchObject({ lanes: stored, capacity: 2 });
    expect(await capacityOf(e.id)).toEqual({ capacity: 2, config_rev: 1 });
  });

  it("answers 400 with field errors keyed lanes, lanes.N.name, lanes.N.id and capacity, changing nothing", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"] });
    const before = await snapshot(e.id);
    const other = await insertEvent(t.env.DB, { lanes: ["Elsewhere"] });
    const res = await put(e.slug, draft({ lanes: [{ id: other.laneIds[0], name: "Stolen" }, { name: "stolen" }, { name: "" }], capacity: 51 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string }; fields: Record<string, string> };
    expect(body.error.code).toBe("invalid_input");
    expect(body.fields).toEqual({
      capacity: "Enter a whole number of places from 1 to 50.", "lanes.0.id": "That isn't one of this event's lanes.",
      "lanes.1.name": "Two lanes can't have the same name.", "lanes.2.name": "Enter the lane name.",
    });
    expect(await snapshot(e.id)).toBe(before);
    expect(await lanesOf(other.id)).toEqual([{ id: other.laneIds[0], name: "Elsewhere" }]);
  });

  it("refuses more than 2000 places, keyed capacity", async () => {
    const e = await seed({ lanes: ["Ring 1"] });
    const res = await put(e.slug, draft({ start: "09:00", end: "18:00", sessionMinutes: 5, breaks: [], capacity: 19 }));
    expect(res.status).toBe(400);
    expect(Object.keys(((await res.json()) as { fields: Record<string, string> }).fields)).toEqual(["capacity"]);
  });

  it("lists the bookings a lowered capacity or a removed lane would strand (409 bookings_affected) and removes exactly the confirmed ones", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"], capacity: 2 });
    const a = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "A", "H", { laneId: e.laneIds[0] });
    const b = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "B", "H", { laneId: e.laneIds[0] });
    const c = await insertBooking(t.env.DB, e.id, "2026-10-24T08:15:00Z", "C", "H", { laneId: e.laneIds[1] });
    const body = draft({ lanes: [{ id: e.laneIds[0], name: "Ring 1" }], capacity: 1 });
    const refused = await put(e.slug, body);
    expect(refused.status).toBe(409);
    const conflict = (await refused.json()) as Conflict;
    expect(conflict.error.code).toBe("bookings_affected");
    expect(conflict.affected.map((x) => [x.id, x.lane.name])).toEqual([[b, "Ring 1"], [c, "Ring 2"]]);
    expect((await lanesOf(e.id))).toHaveLength(2);
    const saved = await put(e.slug, { ...body, removeBookingIds: [b, c] });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Saved).removed.map((x) => x.id)).toEqual([b, c]);
    expect(await bookingIds(e.id)).toEqual([a]);
    expect(await lanesOf(e.id)).toEqual([{ id: e.laneIds[0], name: "Ring 1" }]);
  });

  it("answers 409 event_changed when the lanes were edited after the event was read and the body sends lanes", async () => {
    const e = await seed({ lanes: ["Ring 1"] });
    const res = await put(e.slug, draft({ lanes: [{ id: e.laneIds[0], name: "Mine" }] }), {
      env: {
        DB: interceptBatches(t.env.DB, async (sqls, run) => {
          if (sqls.some((q) => q.startsWith("UPDATE events SET name"))) await t.env.DB.prepare("UPDATE event_layout SET config_rev = config_rev + 1 WHERE event_id = ?").bind(e.id).run();
          return run();
        }),
      },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("event_changed");
    expect(await lanesOf(e.id)).toEqual([{ id: e.laneIds[0], name: "Ring 1" }]);
  });

  it("lets a save keep a lane name and a field label the event already has that today's rules would refuse, and refuses a new one like it", async () => {
    const e = await seed({ lanes: ["Ring 1\uFE0F", "!!!"], fields: [{ label: "Dog\uFE0F", identity: true }] });
    const keepLanes = [{ id: e.laneIds[0], name: "Ring 1\uFE0F" }, { id: e.laneIds[1], name: "!!!" }];
    const keepFields = [{ label: "Dog\uFE0F", required: true, maxLength: 80, identity: true }];
    expect((await put(e.slug, draft({ name: "Saved anyway", lanes: keepLanes, fields: keepFields }))).status).toBe(200);
    expect((await lanesOf(e.id)).map((l) => l.name)).toEqual(["Ring 1\uFE0F", "!!!"]);
    const refused = await put(e.slug, draft({ lanes: [...keepLanes, { name: "Ring 3\uFE0F" }], fields: [{ ...keepFields[0], label: "Hors\uFE0F" }] }));
    expect(refused.status).toBe(400);
    expect(Object.keys(((await refused.json()) as { fields: Record<string, string> }).fields).sort()).toEqual(["fields.0.label", "lanes.2.name"]);
  });

  it("keeps the lanes and capacity when the body doesn't send them", async () => {
    const e = await seed({ lanes: ["Ring 1", "Ring 2"], capacity: 4 });
    expect((await put(e.slug, draft({ name: "Only the name" }))).status).toBe(200);
    expect(await lanesOf(e.id)).toEqual([{ id: e.laneIds[0], name: "Ring 1" }, { id: e.laneIds[1], name: "Ring 2" }]);
    expect(await capacityOf(e.id)).toEqual({ capacity: 4, config_rev: 0 });
  });
});

describe("PUT /api/admin/events/[slug]: the revision of the page the edit was made on (configRev)", () => {
  const F = (label: string, over: Record<string, unknown> = {}) => ({ label, required: true, maxLength: 80, identity: false, ...over });
  const KINDS: [string, (e: Awaited<ReturnType<typeof seed>>) => Record<string, unknown>][] = [
    ["lanes", (e) => ({ lanes: [{ id: e.laneIds[0], name: "Mine" }, { name: "Extra" }] })],
    ["capacity", () => ({ capacity: 4 })],
    ["fields", () => ({ fields: [F("Horse", { identity: true }), F("Rider", { identity: true })] })],
    ["identityLimit", () => ({ identityLimit: 3 })],
  ];
  /** Everything an edit of the layout could write, ids included. */
  const layoutSnapshot = async (id: number) => JSON.stringify([
    await snapshot(id),
    (await t.env.DB.prepare("SELECT * FROM event_lanes WHERE event_id = ? ORDER BY id").bind(id).all()).results,
    (await t.env.DB.prepare("SELECT * FROM event_layout WHERE event_id = ?").bind(id).all()).results,
    (await t.env.DB.prepare("SELECT * FROM event_fields WHERE event_id = ? ORDER BY position").bind(id).all()).results,
  ]);
  const rev = async (id: number) => (await t.env.DB.prepare("SELECT config_rev FROM event_layout WHERE event_id = ?").bind(id).first<{ config_rev: number }>())!.config_rev;
  const bodyOf = async (res: Response) => (await res.json()) as { error: { code: string; message: string }; fields?: Record<string, string>; event: { configRev: number } };

  it("is in the detail (GET) as an integer, and in the saved event (PUT), where an edit of the layout raises it by one", async () => {
    const e = await seed();
    expect((await detail(e.slug)).event.configRev).toBe(0);
    const saved = await bodyOf(await put(e.slug, draft({ capacity: 2 })));
    expect(saved.event.configRev).toBe(1);
    expect((await detail(e.slug)).event.configRev).toBe(1);
    expect(await rev(e.id)).toBe(1);
    // A save that sends the layout unchanged (and so changes nothing of it) leaves the revision where it is.
    expect((await bodyOf(await put(e.slug, draft({ capacity: 2, name: "Renamed" })))).event.configRev).toBe(1);
  });

  it.each(LAYOUT_KEYS)("is required when the body sends %s: 400 fields.configRev, nothing written", async (key) => {
    const e = await seed();
    const kind = KINDS.find(([k]) => k === key)![1];
    const before = await layoutSnapshot(e.id);
    const res = await put(e.slug, draft({ name: "Not saved", ...kind(e) }), { noRev: true });
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toMatchObject({ error: { code: "invalid_input" }, fields: { configRev: "Reload the page and try again." } });
    expect(await layoutSnapshot(e.id)).toBe(before);
  });

  it.each([1.5, "0", -1, null, true, [0], 2 ** 60])("is refused as a field error when it is %j", async (bad) => {
    const e = await seed();
    const before = await layoutSnapshot(e.id);
    const res = await put(e.slug, draft({ capacity: 2, configRev: bad }));
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).fields).toEqual({ configRev: "Reload the page and try again." });
    expect(await layoutSnapshot(e.id)).toBe(before);
  });

  it("is not needed, and ignored, when the body sends none of lanes, capacity, fields and identityLimit: those saves stay last-write-wins", async () => {
    const e = await seed({ capacity: 3 });
    await t.env.DB.prepare("UPDATE event_layout SET config_rev = 5 WHERE event_id = ?").bind(e.id).run();
    expect((await put(e.slug, draft({ name: "No revision" }))).status).toBe(200);
    expect((await put(e.slug, draft({ name: "Stale revision", configRev: 0 }))).status).toBe(200);
    expect((await put(e.slug, draft({ name: "Nonsense revision", configRev: "x" }))).status).toBe(200);
    expect(await t.env.DB.prepare("SELECT name FROM events WHERE id = ?").bind(e.id).first()).toEqual({ name: "Nonsense revision" });
    expect(await t.env.DB.prepare("SELECT capacity, config_rev FROM event_layout WHERE event_id = ?").bind(e.id).first()).toEqual({ capacity: 3, config_rev: 5 });
  });

  it.each(LAYOUT_KEYS)("refuses a stale revision with 409 event_changed when the body sends %s, and writes nothing", async (key) => {
    const e = await seed({ lanes: ["Ring 1"] });
    const kind = KINDS.find(([k]) => k === key)![1];
    // Another admin saved the layout after this page was loaded (at revision 0).
    expect((await put(e.slug, draft({ identityLimit: 2 }))).status).toBe(200);
    expect(await rev(e.id)).toBe(1);
    const before = await layoutSnapshot(e.id);
    const res = await put(e.slug, draft({ name: "Not saved", ...kind(e), configRev: 0 }));
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await bodyOf(res)).error).toEqual({
      code: "event_changed",
      message: "The lanes, places or booking form of this event were changed by someone else. Reload the page to see them, then make your change again.",
    });
    expect(await layoutSnapshot(e.id)).toBe(before);
  });

  it("refuses a revision from the future, too, and writes nothing", async () => {
    const e = await seed();
    const before = await layoutSnapshot(e.id);
    expect((await put(e.slug, draft({ capacity: 2, configRev: 7 }))).status).toBe(409);
    expect(await layoutSnapshot(e.id)).toBe(before);
  });

  it("takes the matching revision, applies the edit and raises the revision; the same page cannot save the layout twice", async () => {
    const e = await seed({ lanes: ["Ring 1"] });
    const first = await put(e.slug, draft({ capacity: 2, configRev: 0 }));
    expect(first.status).toBe(200);
    const { event } = await bodyOf(first);
    expect(event.configRev).toBe(1);
    expect((await put(e.slug, draft({ capacity: 3, configRev: event.configRev }))).status).toBe(200);
    expect(await rev(e.id)).toBe(2);
    expect((await put(e.slug, draft({ capacity: 4, configRev: event.configRev }))).status).toBe(409);
    expect(await t.env.DB.prepare("SELECT capacity FROM event_layout WHERE event_id = ?").bind(e.id).first()).toEqual({ capacity: 3 });
  });

  it("two admins on the same page: the second to save the layout is told to reload, reloads, and then saves", async () => {
    const e = await seed({ lanes: ["Ring 1"] });
    const pageA = (await detail(e.slug)).event.configRev as number;
    const pageB = (await detail(e.slug)).event.configRev as number;
    expect((await put(e.slug, draft({ capacity: 2, configRev: pageA }))).status).toBe(200);
    expect((await put(e.slug, draft({ lanes: [{ id: e.laneIds[0], name: "B's lane" }], configRev: pageB }))).status).toBe(409);
    const reloaded = (await detail(e.slug)).event.configRev as number;
    expect((await put(e.slug, draft({ lanes: [{ id: e.laneIds[0], name: "B's lane" }], capacity: 2, configRev: reloaded }))).status).toBe(200);
    expect(await t.env.DB.prepare("SELECT name FROM event_lanes WHERE event_id = ?").bind(e.id).first()).toEqual({ name: "B's lane" });
  });
});

describe("PUT /api/admin/events/[slug]: the booking form's fields and the identity limit", () => {
  const F = (label: string, over: Record<string, unknown> = {}) => ({ label, required: true, maxLength: 80, identity: false, ...over });
  const form = async (id: number) => (await t.env.DB.prepare("SELECT label, required, max_length, in_identity FROM event_fields WHERE event_id = ? ORDER BY position").bind(id).all()).results;
  const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

  it("saves the fields and the limit, returns them with the event, and the detail shows the same", async () => {
    const e = await seed();
    const fields = [F("Rider", { identity: true }), F("Pony", { identity: true, maxLength: 30 }), F("Phone", { required: false, maxLength: 12 })];
    const res = await put(e.slug, draft({ fields, identityLimit: 3 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Saved).event).toMatchObject({ fields, identityLimit: 3 });
    expect((await detail(e.slug)).event).toMatchObject({ fields, identityLimit: 3 });
    expect(await form(e.id)).toEqual([
      { label: "Rider", required: 1, max_length: 80, in_identity: 1 }, { label: "Pony", required: 1, max_length: 30, in_identity: 1 }, { label: "Phone", required: 0, max_length: 12, in_identity: 0 },
    ]);
  });

  it("keeps the fields and the limit when the body doesn't send them", async () => {
    const e = await seed({ identityLimit: 4 });
    expect((await put(e.slug, draft({ name: "Only the name" }))).status).toBe(200);
    expect((await form(e.id)).map((f) => f.label)).toEqual(["Dog", "Handler"]);
    expect((await detail(e.slug)).event).toMatchObject({ identityLimit: 4 });
  });

  it("answers 400 with the field errors, keyed fields.N.label and so on, changing nothing", async () => {
    const e = await seed();
    const before = await snapshot(e.id);
    const res = await put(e.slug, draft({ fields: [F("Dog", { identity: true, maxLength: 0 }), F("dog", { required: "x" })], identityLimit: 21 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: Record<string, string> }).fields).toEqual({
      "fields.0.maxLength": "Enter a whole number of characters from 1 to 80.", "fields.1.label": "Two fields can't have the same label.",
      "fields.1.required": "Required must be true or false.", identityLimit: "Enter a whole number of bookings from 1 to 20.",
    });
    expect(await snapshot(e.id)).toBe(before);
  });

  describe("an event with bookings", () => {
    it("answers 409 fields_locked for a changed number of fields or identity set, naming nothing else, and changes nothing", async () => {
      const e = await seed();
      await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Rex", "Sam");
      const before = await snapshot(e.id);
      for (const fields of [[F("Dog", { identity: true })], [F("Dog", { identity: true }), F("Handler", { identity: true }), F("Notes", { required: false })], [F("Dog", { identity: true }), F("Handler")]]) {
        const res = await put(e.slug, draft({ name: "Not saved", fields }));
        expect(res.status, JSON.stringify(fields)).toBe(409);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect((await errorOf(res)).code).toBe("fields_locked");
      }
      expect(await snapshot(e.id)).toBe(before);
      expect((await form(e.id)).map((f) => f.label)).toEqual(["Dog", "Handler"]);
    });

    it("saves a change of labels, required flags, longest values and identity limit", async () => {
      const e = await seed();
      await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Rex", "Sam");
      const res = await put(e.slug, draft({ fields: [F("Horse", { identity: true, maxLength: 40 }), F("Rider", { identity: true })], identityLimit: 2 }));
      expect(res.status).toBe(200);
      expect((await form(e.id)).map((f) => [f.label, f.max_length])).toEqual([["Horse", 40], ["Rider", 80]]);
      expect((await t.env.DB.prepare("SELECT identity_limit, config_rev FROM event_layout WHERE event_id = ?").bind(e.id).first())).toEqual({ identity_limit: 2, config_rev: 1 });
    });

    it("answers fields_locked, not bookings_affected, when the same save would also strand a booking", async () => {
      const e = await seed();
      await insertBooking(t.env.DB, e.id, "2026-10-24T10:45:00Z", "Rex", "Sam");
      const res = await put(e.slug, draft({ end: "11:30", fields: [F("Dog", { identity: true })] }));
      expect((await errorOf(res)).code).toBe("fields_locked");
    });
  });

  it("answers 409 fields_locked when a booking lands between the read and the save", async () => {
    const e = await seed();
    const res = await put(e.slug, draft({ fields: [F("Car reg", { identity: true })] }), {
      env: {
        DB: interceptBatches(t.env.DB, async (sqls, run) => {
          if (sqls.some((q) => q.startsWith("UPDATE events SET name"))) await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Rex", "Sam");
          return run();
        }),
      },
    });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("fields_locked");
    expect((await form(e.id)).map((f) => f.label)).toEqual(["Dog", "Handler"]);
  });

  it("answers 409 event_changed when the form was edited after the event was read and the body sends fields", async () => {
    const e = await seed();
    const res = await put(e.slug, draft({ fields: [F("Mine", { identity: true })] }), {
      env: {
        DB: interceptBatches(t.env.DB, async (sqls, run) => {
          if (sqls.some((q) => q.startsWith("UPDATE events SET name"))) await t.env.DB.prepare("UPDATE event_layout SET config_rev = config_rev + 1 WHERE event_id = ?").bind(e.id).run();
          return run();
        }),
      },
    });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("event_changed");
    expect((await form(e.id)).map((f) => f.label)).toEqual(["Dog", "Handler"]);
  });

  it("refuses an empty list of fields", async () => {
    const e = await seed();
    const res = await put(e.slug, draft({ fields: [] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: Record<string, string> }).fields).toEqual({ fields: "A booking form needs at least one field." });
  });
});

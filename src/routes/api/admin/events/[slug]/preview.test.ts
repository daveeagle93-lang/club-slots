import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSlug } from "../../../../../core/slug";
import { countRows, createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../../../../../test/db";
import { onRequestPost } from "./preview";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

interface PostOptions { contentType?: string | null; raw?: string; data?: unknown[] }

const post = (slug: string, body: unknown, o: PostOptions = {}): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  return Promise.resolve(
    onRequestPost({
      request: new Request(`http://localhost/api/admin/events/${slug}/preview`, { method: "POST", headers, body: o.raw ?? JSON.stringify(body) }),
      env: t.env, params: { slug }, data: o.data ? o.data[0] : ADMIN,
    } as unknown as Parameters<typeof onRequestPost>[0]),
  );
};

// 2026-10-24 (BST): 09:00-12:00 is 08:00Z-11:00Z, quarter-hour sessions, no breaks: 12 slots.
const draft = (over: Record<string, unknown> = {}) => ({
  name: "Trial day", date: "2026-10-24", start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 0,
  costPence: 1500, venuePostcode: "AB1 2CD", details: "", breaks: [], ...over,
});
const seed = () => insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15 });

/** A booking of the Dog and Handler form as the admin API shows it: its labelled values. */
const dh = (dog: string, handler: string) => ({ fields: [{ label: "Dog", value: dog }, { label: "Handler", value: handler }] });

interface Body {
  slots: { start: string; end: string }[];
  suggestions: { breakIndex: number; breakLabel: string; suggestedLocal: { start: string; end: string } }[];
  affected: { id: number; slotStart: string; fields: { label: string; value: string }[]; lane: { id: number; name: string } }[];
  placeCount: number;
}

describe("POST /api/admin/events/[slug]/preview", () => {
  it("lists the bookings the draft would leave without a slot, sorted by slot time, no-store", async () => {
    const { id, slug } = await seed();
    // Inserted out of order on purpose.
    const late = await insertBooking(t.env.DB, id, "2026-10-24T10:45:00Z", "Late", "Lena");
    const early = await insertBooking(t.env.DB, id, "2026-10-24T10:30:00Z", "Early", "Eve");
    const kept = await insertBooking(t.env.DB, id, "2026-10-24T08:00:00Z", "Kept", "Kim");
    const res = await post(slug, draft({ end: "11:30" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Body;
    expect(body.affected).toEqual([
      { id: early, slotStart: "2026-10-24T10:30:00Z", ...dh("Early", "Eve"), lane: { id: expect.any(Number), name: "" } },
      { id: late, slotStart: "2026-10-24T10:45:00Z", ...dh("Late", "Lena"), lane: { id: expect.any(Number), name: "" } },
    ]);
    expect(body.affected.map((a) => a.id)).not.toContain(kept);
    expect(body.slots).toHaveLength(10);
    expect(body.slots.at(-1)).toEqual({ start: "2026-10-24T10:15:00Z", end: "2026-10-24T10:30:00Z" });
  });

  it("does not treat `listed` as a schedule change: nothing affected whatever it says", async () => {
    const { id, slug } = await seed();
    await insertBooking(t.env.DB, id, "2026-10-24T10:45:00Z", "Rex", "Sam");
    for (const listed of [true, false]) {
      const body = (await (await post(slug, draft({ listed }))).json()) as Body;
      expect(body.affected).toEqual([]);
      expect(body.slots).toHaveLength(12);
    }
  });

  it("has nothing affected when slots are only added", async () => {
    const { id, slug } = await seed();
    await insertBooking(t.env.DB, id, "2026-10-24T10:45:00Z", "Rex", "Sam");
    const body = (await (await post(slug, draft({ end: "13:00" }))).json()) as Body;
    expect(body.affected).toEqual([]);
    expect(body.slots).toHaveLength(16);
  });

  it("counts every booking as affected when all slots shift", async () => {
    const { id, slug } = await seed();
    await insertBooking(t.env.DB, id, "2026-10-24T08:15:00Z", "A", "Al");
    await insertBooking(t.env.DB, id, "2026-10-24T08:30:00Z", "B", "Bo");
    const body = (await (await post(slug, draft({ sessionMinutes: 16 }))).json()) as Body;
    expect(body.affected.map((a) => a.fields[0].value)).toEqual(["A", "B"]);
  });

  it("looks only at this event's bookings", async () => {
    const mine = await seed();
    const other = await seed();
    await insertBooking(t.env.DB, other.id, "2026-10-24T10:45:00Z", "Other", "Olly");
    expect(((await (await post(mine.slug, draft({ end: "11:30" }))).json()) as Body).affected).toEqual([]);
  });

  it("returns near-miss suggestions in edit, worded from the break's name", async () => {
    const { id, slug } = await seed();
    await insertBreak(t.env.DB, id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z");
    const res = await post(slug, draft({ breaks: [{ start: "12:05", end: "13:00", label: " Lunch " }], end: "17:00" }));
    const body = (await res.json()) as Body;
    expect(body.suggestions).toEqual([expect.objectContaining({
      breakIndex: 0, breakLabel: "Lunch", suggestedLocal: { start: "12:15", end: "13:10" },
    })]);
  });

  it("is read-only: the event, its breaks and bookings are left as they were", async () => {
    const { id, slug } = await seed();
    await insertBreak(t.env.DB, id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z", "Lunch");
    await insertBooking(t.env.DB, id, "2026-10-24T10:45:00Z", "Rex", "Sam");
    const snapshot = async () => JSON.stringify([
      (await t.env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(id).all()).results,
      (await t.env.DB.prepare("SELECT * FROM breaks WHERE event_id = ?").bind(id).all()).results,
      (await t.env.DB.prepare("SELECT * FROM bookings WHERE event_id = ?").bind(id).all()).results,
    ]);
    const before = await snapshot();
    const bookings = await countRows(t.env.DB, "bookings");
    expect((await post(slug, draft({ name: "Renamed", end: "11:00", breaks: [] }))).status).toBe(200);
    expect(await snapshot()).toBe(before);
    expect(await countRows(t.env.DB, "bookings")).toBe(bookings);
  });

  it("previews a date in the past (an event that is already over can still be edited)", async () => {
    const { slug } = await seed();
    expect((await post(slug, draft({ date: "2020-01-04" }))).status).toBe(200);
  });

  it("returns the same 400 invalid_input fields as the stateless preview", async () => {
    const { slug } = await seed();
    const res = await post(slug, draft({ name: "", breaks: [{ start: "9", end: "10:00" }] }));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: { code: "invalid_input", message: "Check the highlighted fields." },
      fields: { name: "Enter the event name.", "breaks.0.start": "Enter a time as HH:MM." },
    });
  });

  it("returns 404 for an unknown or malformed slug", async () => {
    for (const slug of [generateSlug(), "nope"]) {
      const res = await post(slug, draft());
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("returns 415 for a non-JSON content type and 400 for bad JSON or a non-object", async () => {
    const { slug } = await seed();
    expect((await post(slug, draft(), { contentType: "text/plain" })).status).toBe(415);
    expect((await post(slug, undefined, { raw: "{nope" })).status).toBe(400);
    expect((await post(slug, undefined, { raw: "[1]" })).status).toBe(400);
  });

  it("returns 413 above 32 KB", async () => {
    const { slug } = await seed();
    const res = await post(slug, { ...draft(), padding: "x".repeat(33_000) });
    expect(res.status).toBe(413);
  });

  it("refuses with 401 unless the guard set an admin identity", async () => {
    const { slug } = await seed();
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await post(slug, draft(), { data: [data] });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("gives placeCount for the lanes and capacity of the draft, or the event's own where the draft leaves them out", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, lanes: ["A", "B"], capacity: 3 });
    const count = async (over: Record<string, unknown>) => ((await (await post(e.slug, draft(over))).json()) as Body).placeCount;
    expect(await count({})).toBe(12 * 2 * 3);
    expect(await count({ capacity: 1 })).toBe(12 * 2);
    expect(await count({ lanes: [{ id: e.laneIds[0], name: "A" }] })).toBe(12 * 3);
    expect(await count({ lanes: [{ name: "X" }, { name: "Y" }, { name: "Z" }], capacity: 2 })).toBe(12 * 3 * 2);
  });

  it("lists as affected what a removed lane or a lowered capacity would strand, as the save would (latest made first)", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, lanes: ["A", "B"], capacity: 2 });
    const first = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "First", "H", { laneId: e.laneIds[0] });
    const second = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Second", "H", { laneId: e.laneIds[0] });
    const inB = await insertBooking(t.env.DB, e.id, "2026-10-24T08:15:00Z", "InB", "H", { laneId: e.laneIds[1] });
    await t.env.DB.prepare("UPDATE bookings SET created_at = '2026-09-01T10:00:00Z' WHERE id = ?").bind(first).run();
    await t.env.DB.prepare("UPDATE bookings SET created_at = '2026-09-01T10:05:00Z' WHERE id = ?").bind(second).run();
    const affected = async (over: Record<string, unknown>) => ((await (await post(e.slug, draft(over))).json()) as Body).affected.map((a) => a.id);
    expect(await affected({})).toEqual([]);
    expect(await affected({ capacity: 1 })).toEqual([second]);
    expect(await affected({ lanes: [{ id: e.laneIds[0], name: "A" }] })).toEqual([inB]);
    expect(await affected({ lanes: [{ id: e.laneIds[0], name: "A" }], capacity: 1 })).toEqual([second, inB]);
    expect(await affected({ capacity: 5 })).toEqual([]);
  });

  it("refuses a lane id that is not the event's, with field errors", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", lanes: ["A"] });
    const res = await post(e.slug, draft({ lanes: [{ id: e.laneIds[0] + 9999, name: "A" }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: Record<string, string> }).fields).toEqual({ "lanes.0.id": "That isn't one of this event's lanes." });
  });
});

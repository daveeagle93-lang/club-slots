import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { utcToLondon } from "../../../../core/london";
import { generateBookingToken } from "../../../../core/slug";
import type { AppEnv } from "../../../../server/env";
import { countRows, createTestEnv, insertBooking, insertBreak, insertEvent, insertTemplate, type TestEnv } from "../../../../test/db";
import { onRequestPost as book } from "../../events/[slug]/bookings";
import { onRequestGet as publicGet } from "../../events/[slug]/index";
import { onRequestGet, onRequestPost } from "./index";
import { onRequestPost as preview } from "./preview";

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

interface PostOptions { contentType?: string | null; raw?: string; data?: unknown; env?: unknown }

const post = (body: unknown, o: PostOptions = {}): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  return Promise.resolve(
    onRequestPost({
      request: new Request("http://localhost/api/admin/events", { method: "POST", headers, body: o.raw ?? JSON.stringify(body) }),
      env: o.env ?? t.env,
      data: "data" in o ? o.data : ADMIN,
    } as unknown as Parameters<typeof onRequestPost>[0]),
  );
};

/** Pass a second argument (even undefined) to replace the admin data. */
const list = (vars: Partial<AppEnv> = {}, ...data: unknown[]): Promise<Response> =>
  Promise.resolve(
    onRequestGet({
      request: new Request("http://localhost/api/admin/events"),
      env: { DB: t.env.DB, ...vars },
      data: data.length > 0 ? data[0] : ADMIN,
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );

let keyCounter = 0;
/** A fresh valid idempotency key per call. */
const newKey = () => `admin-key-${String(++keyCounter).padStart(10, "0")}`;

const draft = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: newKey(),
  name: "Saturday trial day", date: "2026-10-24", start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 0,
  costPence: 1500, venuePostcode: "ab1  2cd", details: "Bring water", breaks: [{ start: "10:00", end: "10:30" }], ...over,
});

interface Created {
  event: Record<string, unknown> & { slug: string };
  path: string; slotCount: number;
}
const create = async (over: Record<string, unknown> = {}): Promise<Created> => {
  const res = await post(draft(over));
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
};

const publicEvent = async (slug: string) =>
  (await (await publicGet({
    request: new Request(`http://localhost/api/events/${slug}`), env: { DB: t.env.DB }, params: { slug },
  } as unknown as Parameters<typeof publicGet>[0])).json()) as { slots: { start: string; end: string; status: string; places: { laneId: number; free: number }[] }[] };

describe("POST /api/admin/events", () => {
  it("creates the event and its breaks: 201, no internal ids, a path and the slot count", async () => {
    const res = await post(draft({ breaks: [{ start: "10:00", end: "10:30" }, { start: "11:00", end: "11:10" }] }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Created;
    expect(body).toEqual({
      event: {
        slug: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), name: "Saturday trial day",
        startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, gapMinutes: 0,
        costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water", shareMessage: "",
        lanes: [{ id: expect.any(Number), name: "" }], capacity: 1,
        fields: [{ label: "Name", required: true, maxLength: 80, identity: true }], identityLimit: 1, configRev: 0,
      },
      path: `/e/${body.event.slug}`,
      slotCount: 9, // 09:00 09:15 09:30 09:45, then 10:30 10:45, then 11:10 11:25 11:40
    });
    const stored = await t.env.DB.prepare("SELECT * FROM events WHERE slug = ?").bind(body.event.slug).first<{ id: number }>();
    const { results } = await t.env.DB.prepare("SELECT start_utc, end_utc FROM breaks WHERE event_id = ? ORDER BY start_utc").bind(stored!.id).all();
    expect(results).toEqual([
      { start_utc: "2026-10-24T09:00:00Z", end_utc: "2026-10-24T09:30:00Z" },
      { start_utc: "2026-10-24T10:00:00Z", end_utc: "2026-10-24T10:10:00Z" },
    ]);
  });

  it("lists the event on the landing page by default, and unlisted when asked, either way still bookable by its link", async () => {
    const shown = (await create()).event.slug;
    const hidden = (await create({ listed: false })).event.slug;
    const { results } = await t.env.DB.prepare("SELECT slug, listed FROM events WHERE slug IN (?, ?) ORDER BY listed").bind(shown, hidden).all();
    expect(results).toEqual([{ slug: hidden, listed: 0 }, { slug: shown, listed: 1 }]);
    const slots = (await publicEvent(hidden)).slots;
    expect(slots.length).toBeGreaterThan(0);
    // The two events have lanes of their own, so compare what each slot offers rather than the lane ids.
    const offers = (list: typeof slots) => list.map((s) => ({ ...s, places: s.places.map((p) => p.free) }));
    expect(offers(slots)).toEqual(offers((await publicEvent(shown)).slots));
  });

  it("creates the event with its layout (capacity 1, identity limit 1, revision 0) and one unnamed lane, in the same batch", async () => {
    const { event } = await create();
    const id = (await t.env.DB.prepare("SELECT id FROM events WHERE slug = ?").bind(event.slug).first<{ id: number }>())!.id;
    expect(await t.env.DB.prepare("SELECT capacity, identity_limit, config_rev FROM event_layout WHERE event_id = ?").bind(id).all().then((r) => r.results))
      .toEqual([{ capacity: 1, identity_limit: 1, config_rev: 0 }]);
    expect((await t.env.DB.prepare("SELECT position, name FROM event_lanes WHERE event_id = ?").bind(id).all()).results).toEqual([{ position: 1, name: "" }]);
  });

  it("gives an event whose body leaves out `fields` one required field, Name, that identifies a booking", async () => {
    const { event } = await create();
    const id = (await t.env.DB.prepare("SELECT id FROM events WHERE slug = ?").bind(event.slug).first<{ id: number }>())!.id;
    expect((await t.env.DB.prepare("SELECT position, label, required, max_length, in_identity FROM event_fields WHERE event_id = ?").bind(id).all()).results)
      .toEqual([{ position: 1, label: "Name", required: 1, max_length: 80, in_identity: 1 }]);
  });

  it("stores an explicit listed: true as listed", async () => {
    const { event } = await create({ listed: true });
    expect(await t.env.DB.prepare("SELECT listed FROM events WHERE slug = ?").bind(event.slug).first()).toEqual({ listed: 1 });
  });

  it.each([["a string", "no"], ["a number", 0], ["null", null]])("refuses `listed` as %s with 400 and fields.listed, writing nothing", async (_n, listed) => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ listed }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({ listed: "Listed must be true or false." });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("stores each break's label, and an unnamed break as an empty one", async () => {
    const { event } = await create({ breaks: [{ start: "10:00", end: "10:30", label: "Lunch" }, { start: "11:00", end: "11:10" }] });
    const { results } = await t.env.DB.prepare(
      "SELECT label FROM breaks WHERE event_id = (SELECT id FROM events WHERE slug = ?) ORDER BY start_utc",
    ).bind(event.slug).all();
    expect(results).toEqual([{ label: "Lunch" }, { label: "" }]);
  });

  it("rejects an over-long break label under its own key, writing nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ breaks: [{ start: "10:00", end: "10:30", label: "x".repeat(41) }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({ "breaks.0.label": "The break name must be at most 40 characters." });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("makes a fresh slug each time", async () => {
    expect((await create()).event.slug).not.toBe((await create()).event.slug);
  });

  it("stores what the preview showed, and the public page offers exactly those slots", async () => {
    const body = draft({ breaks: [{ start: "10:05", end: "10:30" }] });
    const previewRes = await preview({
      request: new Request("http://localhost/p", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      env: {}, data: ADMIN,
    } as unknown as Parameters<typeof preview>[0]);
    const previewed = (await previewRes.json()) as { slots: { start: string; end: string }[]; suggestions: unknown[] };
    expect(previewed.suggestions).toHaveLength(1);
    const res = await post(body);
    const created = (await res.json()) as Created;
    const { slots } = await publicEvent(created.event.slug);
    expect(slots.map(({ start, end }) => ({ start, end }))).toEqual(previewed.slots);
    expect(slots.every((s) => s.status === "free")).toBe(true);
    expect(created.slotCount).toBe(previewed.slots.length);
  });

  it("can then be booked through the public API", async () => {
    const { event } = await create();
    const { slots } = await publicEvent(event.slug);
    const slot = slots[3];
    const res = await book({
      request: new Request(`http://localhost/api/events/${event.slug}/bookings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot: slot.start, field1: "Sam Jones", idempotencyKey: generateBookingToken() }),
      }),
      env: t.env, params: { slug: event.slug },
    } as unknown as Parameters<typeof book>[0]);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { booking: { slot: unknown } }).booking.slot).toEqual({ start: slot.start, end: slot.end });
    expect((await publicEvent(event.slug)).slots[3].status).toBe("taken");
  });

  it("stores the right instants across the clock change: 2026-10-24 is BST, 2026-10-31 is GMT", async () => {
    const bst = await create({ date: "2026-10-24", start: "09:00", end: "10:00", breaks: [] });
    const gmt = await create({ date: "2026-10-31", start: "09:00", end: "10:00", breaks: [] });
    expect(bst.event).toMatchObject({ startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z" });
    expect(gmt.event).toMatchObject({ startUtc: "2026-10-31T09:00:00Z", endUtc: "2026-10-31T10:00:00Z" });
    for (const { event } of [bst, gmt]) {
      const { slots } = await publicEvent(event.slug);
      expect(slots.map((s) => utcToLondon(s.start).time)).toEqual(["09:00", "09:15", "09:30", "09:45"]);
    }
  });

  it("rejects a time in the autumn overlap with the right field key, and writes nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    const breaks = await countRows(t.env.DB, "breaks");
    const res = await post(draft({ date: "2026-10-25", start: "00:00", end: "06:00", breaks: [{ start: "01:30", end: "03:00" }] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_input", message: "Check the highlighted fields." },
      fields: { "breaks.0.start": "That time happens twice in London on that date (the clocks go back)." },
    });
    expect(await countRows(t.env.DB, "events")).toBe(events);
    expect(await countRows(t.env.DB, "breaks")).toBe(breaks);
  });

  it("rejects direction-changing characters in the details, writing nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ details: "Pay now\u202E" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({
      details: "The details can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.",
    });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it.each([["U+2028", "\u2028"], ["U+2029", "\u2029"]])("rejects %s in the name, a break name and the details, writing nothing", async (_n, ch) => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ name: `Show${ch}09:00 free`, details: `a${ch}b`, breaks: [{ start: "10:00", end: "10:30", label: `Lunch${ch}` }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({
      name: "The event name can't contain line or paragraph separators.",
      details: "The details can't contain line or paragraph separators.",
      "breaks.0.label": "The break name can't contain line or paragraph separators.",
    });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("requires the event to be in the future (the preview does not), writing nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ date: "2026-09-30" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({ date: "The event must start in the future." });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("returns a generic 500, without leaking the cause, when the batch fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The first batch is the idempotency lookup (a miss); the second is the insert, which fails.
      let batches = 0;
      const db = {
        batch: () => (batches++ === 0 ? Promise.resolve([{ results: [] }, { results: [] }]) : Promise.reject(new Error("D1_ERROR: secret detail"))),
        prepare: () => ({ bind: () => ({}) }),
      };
      const res = await post(draft(), { env: { DB: db } });
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("internal_error");
      expect(text).not.toContain("secret");
      expect(error).toHaveBeenCalled();
      expect(batches).toBe(2);
    } finally {
      error.mockRestore();
    }
  });

  it("refuses with 401 unless the guard set an admin identity, writing nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await post(draft(), { data });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("returns 415, 400 and 413 for bad bodies, writing nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    expect((await post(draft(), { contentType: "text/plain" })).status).toBe(415);
    expect((await post(undefined, { raw: "{nope" })).status).toBe(400);
    expect((await post(undefined, { raw: "[]" })).status).toBe(400);
    const res = await post({ ...draft(), padding: "x".repeat(32768) });
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });
});

describe("POST /api/admin/events: idempotency key", () => {
  const eventRows = async (key: string) =>
    (await t.env.DB.prepare("SELECT id, slug FROM events WHERE idempotency_key = ?").bind(key).all<{ id: number; slug: string }>()).results;
  const breakRows = async (id: number) =>
    (await t.env.DB.prepare("SELECT start_utc, end_utc, label FROM breaks WHERE event_id = ? ORDER BY start_utc").bind(id).all()).results;
  const LUNCH = { start: "10:00", end: "10:30", label: "Lunch" };

  it("is stored with the event", async () => {
    const body = draft();
    const { event } = (await (await post(body)).json()) as Created;
    expect(await eventRows(body.idempotencyKey)).toEqual([{ id: expect.any(Number), slug: event.slug }]);
  });

  it.each([["missing", undefined], ["too short", "short"], ["too long", "k".repeat(65)], ["badly formed", "has spaces in it 123456"], ["a number", 1234567890123456]])(
    "refuses a %s key with 400 and fields.idempotencyKey, writing nothing", async (_n, idempotencyKey) => {
      const events = await countRows(t.env.DB, "events");
      const res = await post(draft({ idempotencyKey }));
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        error: { code: "invalid_input", message: "Check the highlighted fields." },
        fields: { idempotencyKey: "Reload the page and try again." },
      });
      expect(await countRows(t.env.DB, "events")).toBe(events);
    });

  it("reports a bad key together with the other field errors", async () => {
    const res = await post(draft({ idempotencyKey: undefined, name: "" }));
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({
      name: "Enter the event name.", idempotencyKey: "Reload the page and try again.",
    });
  });

  it("is not needed by the preview, which stores nothing", async () => {
    const { idempotencyKey: _omitted, ...withoutKey } = draft();
    const res = await preview({
      request: new Request("http://localhost/p", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(withoutKey) }),
      env: {}, data: ADMIN,
    } as unknown as Parameters<typeof preview>[0]);
    expect(res.status).toBe(200);
  });

  it("answers the same key and the same payload with the original event: 201, replayed, one event, one set of breaks", async () => {
    const body = draft({ breaks: [LUNCH, { start: "11:00", end: "11:10" }] });
    const first = await post(body);
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const created = await first.text();
    // The same request again, spelled differently where validation normalises (postcode, padding, break order).
    const again = await post({
      ...body, name: "  Saturday trial day ", venuePostcode: "AB1 2CD",
      breaks: [{ start: "11:00", end: "11:10" }, { ...LUNCH, label: " Lunch " }],
    });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(await again.text()).toBe(created);
    const rows = await eventRows(body.idempotencyKey);
    expect(rows).toHaveLength(1);
    expect(await breakRows(rows[0].id)).toHaveLength(2);
  });

  it("treats the same key with a different `listed` as a changed request: 422, the original untouched", async () => {
    const body = draft({ listed: false });
    expect((await post(body)).status).toBe(201);
    const same = await post(body);
    expect(same.status).toBe(201);
    expect(same.headers.get("idempotent-replayed")).toBe("true");
    const changed = await post({ ...body, listed: true });
    expect(changed.status).toBe(422);
    expect(await t.env.DB.prepare("SELECT listed FROM events WHERE idempotency_key = ?").bind(body.idempotencyKey).first()).toEqual({ listed: 0 });
  });

  it("gives different keys different events", async () => {
    const a = await create();
    const b = await create();
    expect(a.event.slug).not.toBe(b.event.slug);
  });

  it.each([
    ["the name", { name: "Sunday trial day" }],
    ["a break time", { breaks: [{ ...LUNCH, end: "10:35" }] }],
    ["a break label", { breaks: [{ ...LUNCH, label: "Tea" }] }],
    ["a break label (removed)", { breaks: [{ start: "10:00", end: "10:30" }] }],
    ["the number of breaks", { breaks: [LUNCH, { start: "11:00", end: "11:10" }] }],
    ["the cost", { costPence: 1600 }],
    ["the session length", { sessionMinutes: 20 }],
    ["the details", { details: "Bring tea" }],
    ["the date", { date: "2026-10-25", start: "09:00", end: "12:00" }],
  ])("refuses the same key when %s changes: 422 with the original event, still one event", async (_n, changed) => {
    const body = draft({ breaks: [LUNCH] });
    const first = await post(body);
    const created = await first.text();
    const events = await countRows(t.env.DB, "events");
    const res = await post({ ...body, ...changed });
    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("idempotent-replayed")).toBeNull();
    expect(await res.json()).toEqual({
      error: {
        code: "idempotency_key_reuse",
        message: "An earlier attempt with this key already saved an event, so this change wasn't applied.",
      },
      ...JSON.parse(created),
    });
    expect(await countRows(t.env.DB, "events")).toBe(events);
    const [row] = await eventRows(body.idempotencyKey);
    expect(await breakRows(row.id)).toEqual([{ start_utc: "2026-10-24T09:00:00Z", end_utc: "2026-10-24T09:30:00Z", label: "Lunch" }]);
  });

  it("creates one event from two simultaneous requests with the same key, and both name the same slug", async () => {
    const body = draft({ breaks: [LUNCH] });
    const events = await countRows(t.env.DB, "events");
    const [a, b] = await Promise.all([post(body), post(body)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a, b].filter((r) => r.headers.get("idempotent-replayed") === "true")).toHaveLength(1);
    const [ba, bb] = (await Promise.all([a.json(), b.json()])) as Created[];
    expect(ba).toEqual(bb);
    expect(await countRows(t.env.DB, "events")).toBe(events + 1);
    const rows = await eventRows(body.idempotencyKey);
    expect(rows.map((r) => r.slug)).toEqual([ba.event.slug]);
    expect(await breakRows(rows[0].id)).toHaveLength(1);
  });

  it("two simultaneous requests with the same key but different payloads: one wins, the other gets 422 with the winner", async () => {
    const key = newKey();
    const events = await countRows(t.env.DB, "events");
    const [a, b] = await Promise.all([post(draft({ idempotencyKey: key, name: "One" })), post(draft({ idempotencyKey: key, name: "Two" }))]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const [ba, bb] = (await Promise.all([a.json(), b.json()])) as Created[];
    expect(ba.event.slug).toBe(bb.event.slug);
    expect(await countRows(t.env.DB, "events")).toBe(events + 1);
  });

  it("recovers when the lookup missed but the insert hits the unique key (a simultaneous request won in between)", async () => {
    // The first batch is the lookup: pretend it ran just before the other request committed.
    const racing = () => {
      let batches = 0;
      const calls = () => batches;
      const db = {
        prepare: (q: string) => t.env.DB.prepare(q),
        batch: (statements: D1PreparedStatement[]) =>
          batches++ === 0 ? Promise.resolve([{ results: [] }, { results: [] }]) : t.env.DB.batch(statements),
      };
      return { db, calls };
    };
    const body = draft({ breaks: [LUNCH] });
    const created = await (await post(body)).text();
    const events = await countRows(t.env.DB, "events");

    const same = racing();
    const res = await post(body, { env: { DB: same.db } });
    expect(same.calls()).toBe(3); // lookup (stubbed), failed insert, lookup again
    expect(res.status).toBe(201);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(await res.text()).toBe(created);

    const different = racing();
    const changed = await post({ ...body, name: "Other" }, { env: { DB: different.db } });
    expect(changed.status).toBe(422);
    expect(((await changed.json()) as Created).event.name).toBe("Saturday trial day");
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  describe("after the event's start has passed", () => {
    it("still answers a replay of the same request with the original event", async () => {
      const body = draft({ date: "2026-10-24" });
      const created = await (await post(body)).text();
      vi.setSystemTime(new Date("2026-10-24T08:00:00Z"));
      const res = await post(body);
      expect(res.status).toBe(201);
      expect(res.headers.get("idempotent-replayed")).toBe("true");
      expect(await res.text()).toBe(created);
    });

    it("answers a changed request with 422 and the original", async () => {
      const body = draft({ date: "2026-10-24" });
      await post(body);
      vi.setSystemTime(new Date("2026-10-24T08:00:00Z"));
      expect((await post({ ...body, name: "Changed" })).status).toBe(422);
    });

    it("still refuses a new key for a past date, with the date error", async () => {
      vi.setSystemTime(new Date("2026-10-24T08:00:00Z"));
      const events = await countRows(t.env.DB, "events");
      const res = await post(draft({ date: "2026-10-24" }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { fields: unknown }).fields).toEqual({ date: "The event must start in the future." });
      expect(await countRows(t.env.DB, "events")).toBe(events);
    });

    it("reports every error for a past date with other mistakes, whatever the key", async () => {
      const body = draft({ date: "2026-10-24", name: "" });
      await post(draft({ date: "2026-10-24", idempotencyKey: body.idempotencyKey }));
      vi.setSystemTime(new Date("2026-10-24T08:00:00Z"));
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { fields: unknown }).fields).toEqual({ name: "Enter the event name.", date: "The event must start in the future." });
    });
  });
});

describe("GET /api/admin/events", () => {
  beforeEach(async () => { await t.env.DB.prepare("DELETE FROM events").run(); });

  const slugsOf = async (res: Response) => ((await res.json()) as { events: { slug: string }[] }).events.map((e) => e.slug);

  it("lists upcoming events soonest first; hides archived and finished ones", async () => {
    const day = (d: string, from: string, to: string) => ({ startUtc: `${d}T${from}:00Z`, endUtc: `${d}T${to}:00Z` });
    const later = await insertEvent(t.env.DB, day("2026-10-24", "08:00", "11:00"));
    const sooner = await insertEvent(t.env.DB, day("2026-10-10", "08:00", "11:00"));
    const running = await insertEvent(t.env.DB, day("2026-10-01", "11:00", "13:00"));
    await insertEvent(t.env.DB, { ...day("2026-10-20", "08:00", "11:00"), archived: true });
    await insertEvent(t.env.DB, day("2026-09-30", "08:00", "11:00"));
    await insertEvent(t.env.DB, day("2026-10-01", "11:00", "12:00")); // ends exactly now
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await slugsOf(res)).toEqual([running.slug, sooner.slug, later.slug]);
  });

  it("returns each event's summary, slot count, booked count, booking window and path", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { name: "Show", costPence: 900, venuePostcode: "ZZ9 9ZZ", details: "private notes" });
    await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
    await insertEvent(t.env.DB, { startUtc: "2026-11-13T08:00:00Z", endUtc: "2026-11-13T09:00:00Z" });
    for (const [slot, dog] of [["2026-06-13T08:00:00Z", "Rex"], ["2026-06-13T08:15:00Z", "Moss"]]) {
      await insertBooking(t.env.DB, id, slot, dog, "Sam");
    }
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const events = ((await (await list({ BOOKING_CUTOFF_OFFSET_MINUTES: "-60" })).json()) as { events: Record<string, unknown>[] }).events;
    expect(events[0]).toEqual({
      slug, name: "Show", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T11:00:00Z", costPence: 900,
      venuePostcode: "ZZ9 9ZZ", details: "private notes", shareMessage: "", slotCount: 10, bookedCount: 2, archived: false, listed: true, full: false,
      laneCount: 1, lanes: [{ name: "" }], capacity: 1, placeCount: 10, bookings: { open: true, closesAt: "2026-06-13T07:00:00Z" }, path: `/e/${slug}`,
      fields: [{ label: "Dog", required: true, maxLength: 80, identity: true }, { label: "Handler", required: true, maxLength: 80, identity: true }], identityLimit: 1,
    });
    expect(events[1]).toMatchObject({ slotCount: 4, bookedCount: 0 });
    vi.setSystemTime(new Date("2026-06-13T07:00:00Z"));
    const closed = ((await (await list({ BOOKING_CUTOFF_OFFSET_MINUTES: "-60" })).json()) as { events: { bookings: unknown }[] }).events;
    expect(closed[0].bookings).toEqual({ open: false, closesAt: "2026-06-13T07:00:00Z" });
  });

  it("says whether each event is listed", async () => {
    await insertEvent(t.env.DB, { startUtc: "2026-10-10T08:00:00Z", endUtc: "2026-10-10T09:00:00Z" });
    await insertEvent(t.env.DB, { startUtc: "2026-10-11T08:00:00Z", endUtc: "2026-10-11T09:00:00Z", listed: false });
    const events = ((await (await list()).json()) as { events: { listed: boolean }[] }).events;
    expect(events.map((e) => e.listed)).toEqual([true, false]);
  });

  it("keeps each event's breaks and booking counts to itself", async () => {
    const a = await insertEvent(t.env.DB, { startUtc: "2026-10-10T08:00:00Z", endUtc: "2026-10-10T09:00:00Z" });
    const b = await insertEvent(t.env.DB, { startUtc: "2026-10-11T08:00:00Z", endUtc: "2026-10-11T09:00:00Z" });
    await insertBreak(t.env.DB, b.id, "2026-10-11T08:00:00Z", "2026-10-11T08:30:00Z");
    const events = ((await (await list()).json()) as { events: { slug: string; slotCount: number }[] }).events;
    expect(events.map((e) => [e.slug, e.slotCount])).toEqual([[a.slug, 4], [b.slug, 2]]);
  });

  it("returns at most 100, the soonest", async () => {
    const statement = t.env.DB.prepare(
      "INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode) VALUES (?, 'E', ?, ?, 15, 'AB1 2CD')",
    );
    const slugs = Array.from({ length: 101 }, (_, i) => `limit-test-slug-${String(i).padStart(3, "0")}`);
    await t.env.DB.batch(slugs.map((slug, i) => {
      const iso = (hour: number) => new Date(Date.UTC(2027, 0, 1 + i, hour)).toISOString().replace(".000Z", "Z");
      return statement.bind(slug, iso(8), iso(9));
    }));
    const got = await slugsOf(await list());
    expect(got).toHaveLength(100);
    expect(got).toEqual(slugs.slice(0, 100)); // slug i is the i-th soonest, so the latest one is dropped
  });

  it("marks an event full only when it has slots and every one is booked", async () => {
    const a = await insertEvent(t.env.DB, { startUtc: "2026-10-10T08:00:00Z", endUtc: "2026-10-10T08:30:00Z" }); // 2 slots
    const b = await insertEvent(t.env.DB, { startUtc: "2026-10-11T08:00:00Z", endUtc: "2026-10-11T08:30:00Z" });
    const c = await insertEvent(t.env.DB, { startUtc: "2026-10-12T08:00:00Z", endUtc: "2026-10-12T08:30:00Z" });
    await insertBooking(t.env.DB, a.id, "2026-10-10T08:00:00Z", "Rex", "Sam");
    await insertBooking(t.env.DB, a.id, "2026-10-10T08:15:00Z", "Moss", "Sam");
    await insertBooking(t.env.DB, b.id, "2026-10-11T08:00:00Z", "Rex", "Sam");
    // The whole event is one break, so there are no slots at all (not "full"). Inserted directly: the API refuses such a draft.
    const zero = await insertEvent(t.env.DB, { startUtc: "2026-10-13T08:00:00Z", endUtc: "2026-10-13T08:30:00Z" });
    await insertBreak(t.env.DB, zero.id, "2026-10-13T08:00:00Z", "2026-10-13T08:30:00Z");
    const events = ((await (await list()).json()) as { events: { slug: string; slotCount: number; bookedCount: number; full: boolean }[] }).events;
    expect(events.map((e) => [e.slug, e.slotCount, e.bookedCount, e.full])).toEqual([
      [a.slug, 2, 2, true], [b.slug, 2, 1, false], [c.slug, 2, 0, false], [zero.slug, 0, 0, false],
    ]);
  });

  it("counts an event full only when slots x lanes x capacity bookings exist", async () => {
    const day = (d: number) => ({ startUtc: `2026-10-${d}T08:00:00Z`, endUtc: `2026-10-${d}T08:30:00Z` }); // 2 slots
    const a = await insertEvent(t.env.DB, { ...day(10), capacity: 2, lanes: ["Ring 1", "Ring 2"] }); // 8 places
    const b = await insertEvent(t.env.DB, { ...day(11), capacity: 2 }); // 4 places
    for (const slot of [`2026-10-10T08:00:00Z`, `2026-10-10T08:15:00Z`]) for (const laneId of a.laneIds) for (const i of [0, 1]) {
      if (slot.endsWith("08:15:00Z") && laneId === a.laneIds[1] && i === 1) continue; // one place left
      await insertBooking(t.env.DB, a.id, slot, `A${slot}${laneId}${i}`, "H", { laneId });
    }
    for (const slot of [`2026-10-11T08:00:00Z`, `2026-10-11T08:15:00Z`]) for (const i of [0, 1]) await insertBooking(t.env.DB, b.id, slot, `B${slot}${i}`, "H");
    const events = ((await (await list()).json()) as { events: { slug: string; bookedCount: number; full: boolean }[] }).events;
    expect(events.map((e) => [e.slug, e.bookedCount, e.full])).toEqual([[a.slug, 7, false], [b.slug, 4, true]]);
    await insertBooking(t.env.DB, a.id, "2026-10-10T08:15:00Z", "Last", "H", { laneId: a.laneIds[1] });
    expect(((await (await list()).json()) as { events: { full: boolean }[] }).events[0].full).toBe(true);
  });

  it("refuses with 401 unless the guard set an admin identity", async () => {
    for (const data of [undefined, {}, { admin: {} }]) {
      const res = await list({}, data);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("GET /api/admin/events: Past and Archived", () => {
  beforeEach(async () => { await t.env.DB.prepare("DELETE FROM events").run(); });

  interface Listing {
    events: { slug: string }[]; past: Record<string, unknown>[]; archived: Record<string, unknown>[];
    pastHasMore: boolean; archivedHasMore: boolean;
  }
  const listing = async (): Promise<Listing> => (await (await list()).json()) as Listing;
  const slugs = (xs: { slug?: unknown }[]) => xs.map((x) => x.slug);
  const at = (start: string, end: string, extra: Record<string, unknown> = {}) => ({ startUtc: start, endUtc: end, ...extra });

  it("puts every event in exactly one group, at the end_utc == now boundary (one second either side)", async () => {
    const before = await insertEvent(t.env.DB, at("2026-10-01T10:00:00Z", "2026-10-01T11:59:59Z"));
    const exactly = await insertEvent(t.env.DB, at("2026-10-01T10:00:00Z", "2026-10-01T12:00:00Z"));
    const after = await insertEvent(t.env.DB, at("2026-10-01T10:00:00Z", "2026-10-01T12:00:01Z"));
    const body = await listing();
    expect(slugs(body.events)).toEqual([after.slug]);
    expect(new Set(slugs(body.past))).toEqual(new Set([before.slug, exactly.slug]));
    expect(body.archived).toEqual([]);
    expect(body.pastHasMore).toBe(false);
    expect(body.archivedHasMore).toBe(false);
  });

  it("shows an archived event under Archived only, whether it is past or upcoming", async () => {
    const archivedPast = await insertEvent(t.env.DB, at("2026-09-01T08:00:00Z", "2026-09-01T11:00:00Z", { archived: true }));
    const archivedUpcoming = await insertEvent(t.env.DB, at("2026-11-01T08:00:00Z", "2026-11-01T11:00:00Z", { archived: true }));
    const body = await listing();
    expect(body.events).toEqual([]);
    expect(body.past).toEqual([]);
    expect(slugs(body.archived)).toEqual([archivedUpcoming.slug, archivedPast.slug]);
  });

  it("orders Past most recently started first and Archived most recently started first", async () => {
    const p1 = await insertEvent(t.env.DB, at("2026-08-01T08:00:00Z", "2026-08-01T09:00:00Z"));
    const p3 = await insertEvent(t.env.DB, at("2026-09-20T08:00:00Z", "2026-09-20T09:00:00Z"));
    const p2 = await insertEvent(t.env.DB, at("2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z"));
    const a1 = await insertEvent(t.env.DB, at("2026-01-01T08:00:00Z", "2026-01-01T09:00:00Z", { archived: true }));
    const a3 = await insertEvent(t.env.DB, at("2027-01-01T08:00:00Z", "2027-01-01T09:00:00Z", { archived: true }));
    const a2 = await insertEvent(t.env.DB, at("2026-06-01T08:00:00Z", "2026-06-01T09:00:00Z", { archived: true }));
    const body = await listing();
    expect(slugs(body.past)).toEqual([p3.slug, p2.slug, p1.slug]);
    expect(slugs(body.archived)).toEqual([a3.slug, a2.slug, a1.slug]);
  });

  it("gives each Past and Archived item exactly its summary fields, with the booked count and no schedule data", async () => {
    const past = await insertEvent(t.env.DB, { ...at("2026-09-01T08:00:00Z", "2026-09-01T11:00:00Z"), name: "Old show", venuePostcode: "ZZ9 9ZZ", details: "private" });
    const old = await insertEvent(t.env.DB, { ...at("2026-02-01T08:00:00Z", "2026-02-01T11:00:00Z"), name: "Filed", archived: true });
    await insertBooking(t.env.DB, past.id, "2026-09-01T08:00:00Z", "Rex", "Sam");
    await insertBooking(t.env.DB, past.id, "2026-09-01T08:15:00Z", "Moss", "Sam");
    await insertBooking(t.env.DB, old.id, "2026-02-01T08:00:00Z", "Rex", "Sam");
    const body = await listing();
    expect(body.past).toEqual([{
      slug: past.slug, name: "Old show", startUtc: "2026-09-01T08:00:00Z", endUtc: "2026-09-01T11:00:00Z",
      venuePostcode: "ZZ9 9ZZ", bookedCount: 2, archived: false, listed: true,
    }]);
    expect(body.archived).toEqual([{
      slug: old.slug, name: "Filed", startUtc: "2026-02-01T08:00:00Z", endUtc: "2026-02-01T11:00:00Z",
      venuePostcode: "AB1 2CD", bookedCount: 1, archived: true, listed: true,
    }]);
  });

  it("says whether each Past and Archived item is listed", async () => {
    await insertEvent(t.env.DB, at("2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z", { listed: false }));
    await insertEvent(t.env.DB, at("2026-02-01T08:00:00Z", "2026-02-01T09:00:00Z", { archived: true, listed: false }));
    const body = await listing();
    expect([body.past[0].listed, body.archived[0].listed]).toEqual([false, false]);
  });

  it("counts bookings per event, zero where there are none, and keeps them to their own event", async () => {
    const a = await insertEvent(t.env.DB, at("2026-09-02T08:00:00Z", "2026-09-02T09:00:00Z"));
    const b = await insertEvent(t.env.DB, at("2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z"));
    await insertBooking(t.env.DB, a.id, "2026-09-02T08:00:00Z", "Rex", "Sam");
    expect((await listing()).past.map((e) => [e.slug, e.bookedCount])).toEqual([[a.slug, 1], [b.slug, 0]]);
  });

  it("returns 100 and sets the HasMore flag when 101 exist, for Past and for Archived, keeping the most recent", async () => {
    const statement = t.env.DB.prepare(
      "INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode, archived) VALUES (?, 'E', ?, ?, 15, 'AB1 2CD', ?)",
    );
    const iso = (i: number, hour: number) => new Date(Date.UTC(2025, 0, 1 + i, hour)).toISOString().replace(".000Z", "Z");
    const rows = (prefix: string, archived: number) => Array.from({ length: 101 }, (_, i) =>
      statement.bind(`${prefix}-${String(i).padStart(3, "0")}-padding-xx`, iso(i, 8), iso(i, 9), archived));
    await t.env.DB.batch([...rows("past", 0), ...rows("arch", 1)]);
    const body = await listing();
    expect(body.past).toHaveLength(100);
    expect(body.archived).toHaveLength(100);
    expect(body.pastHasMore).toBe(true);
    expect(body.archivedHasMore).toBe(true);
    expect(body.past[0].slug).toBe("past-100-padding-xx"); // most recent first; the oldest (000) is the one left out
    expect(slugs(body.past)).not.toContain("past-000-padding-xx");
    expect(body.archived[99].slug).toBe("arch-001-padding-xx");
  });

  it("does not flag HasMore at exactly 100", async () => {
    const statement = t.env.DB.prepare(
      "INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode) VALUES (?, 'E', ?, ?, 15, 'AB1 2CD')",
    );
    const iso = (i: number, hour: number) => new Date(Date.UTC(2025, 0, 1 + i, hour)).toISOString().replace(".000Z", "Z");
    await t.env.DB.batch(Array.from({ length: 100 }, (_, i) => statement.bind(`exact-${String(i).padStart(3, "0")}-padding-xx`, iso(i, 8), iso(i, 9))));
    const body = await listing();
    expect(body.past).toHaveLength(100);
    expect(body.pastHasMore).toBe(false);
  });
});

describe("POST /api/admin/events: share message", () => {
  const storedShare = async (slug: string) =>
    (await t.env.DB.prepare("SELECT share_message AS m FROM events WHERE slug = ?").bind(slug).first<{ m: string }>())!.m;
  const refusedWith = async (shareMessage: unknown, message: string) => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ shareMessage }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({ shareMessage: message });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  };

  it("stores the message with the event and returns it in the created event", async () => {
    const { event } = await create({ shareMessage: "Book {event} on {date}!\nSee you there" });
    expect(event.shareMessage).toBe("Book {event} on {date}!\nSee you there");
    expect(await storedShare(event.slug)).toBe("Book {event} on {date}!\nSee you there");
  });

  it("stores no message (\"\") when the request has none, and an explicit empty one the same", async () => {
    const missing = await create();
    const empty = await create({ shareMessage: "" });
    expect([missing.event.shareMessage, empty.event.shareMessage]).toEqual(["", ""]);
    expect([await storedShare(missing.event.slug), await storedShare(empty.event.slug)]).toEqual(["", ""]);
  });

  it("stores placeholders as plain text without parsing or refusing any, and turns \\r\\n into \\n", async () => {
    const text = "{event} {nonsense} {{x}} {} <b>hi</b>\r\nsecond line";
    const { event } = await create({ shareMessage: text });
    expect(await storedShare(event.slug)).toBe("{event} {nonsense} {{x}} {} <b>hi</b>\nsecond line");
  });

  it("accepts 1000 characters, counting emoji as one each, and refuses 1001", async () => {
    expect((await create({ shareMessage: "x".repeat(1000) })).event.shareMessage).toBe("x".repeat(1000));
    expect((await create({ shareMessage: "\u{1F415}".repeat(1000) })).event.shareMessage).toBe("\u{1F415}".repeat(1000));
    await refusedWith("x".repeat(1001), "The share message must be at most 1000 characters.");
    await refusedWith("\u{1F415}".repeat(1001), "The share message must be at most 1000 characters.");
  });

  it("refuses a message that is not text, with the field's own message", async () => {
    for (const bad of [5, null, true, ["a"], { a: 1 }]) await refusedWith(bad, "The share message must be text (it can be empty).");
  });

  it("refuses invisible characters, line separators, control characters and unpaired surrogates, writing nothing", async () => {
    await refusedWith("Pay now\u202E", "The share message can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.");
    await refusedWith("a\u200Db", "The share message can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.");
    await refusedWith("a\u2028b", "The share message can't contain line or paragraph separators.");
    await refusedWith("a\u2029b", "The share message can't contain line or paragraph separators.");
    await refusedWith("a\u0007b", "The share message can't contain control characters.");
    await refusedWith("a\tb", "The share message can't contain control characters.");
    await refusedWith("a\rb", "The share message can't contain control characters.");
    await refusedWith("a\uD800b", "The share message can't contain unpaired surrogate characters.");
  });

  it("answers a retry (same key, same message) with the original, and a retry that changes or drops the message with 422 and the original", async () => {
    const body = draft({ shareMessage: "Hello {event}" });
    const first = await post(body);
    expect(first.status).toBe(201);
    const created = await first.text();
    const again = await post(body);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.text()).toBe(created);
    const events = await countRows(t.env.DB, "events");
    for (const changed of [{ shareMessage: "Different" }, { shareMessage: undefined }, { shareMessage: "" }]) {
      const res = await post({ ...body, ...changed });
      expect(res.status, JSON.stringify(changed)).toBe(422);
      const reuse = (await res.json()) as { error: { code: string }; event: { shareMessage: string } };
      expect(reuse.error.code).toBe("idempotency_key_reuse");
      expect(reuse.event.shareMessage).toBe("Hello {event}");
    }
    expect(await countRows(t.env.DB, "events")).toBe(events);
    expect(await t.env.DB.prepare("SELECT share_message AS m FROM events WHERE idempotency_key = ?").bind(body.idempotencyKey).first()).toEqual({ m: "Hello {event}" });
  });

  it("treats a missing message and an empty one as the same request on a retry", async () => {
    const body = draft();
    expect((await post(body)).status).toBe(201);
    const again = await post({ ...body, shareMessage: "" });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
  });

  it("does not use the default template: an event without a message stores none", async () => {
    await t.env.DB.prepare("DELETE FROM event_templates").run();
    await insertTemplate(t.env.DB, { name: "Default", isDefault: true, shareMessage: "From the template" });
    const { event } = await create();
    expect(await storedShare(event.slug)).toBe("");
    await t.env.DB.prepare("DELETE FROM event_templates").run();
  });
});

describe("GET /api/admin/events: details, cost, share message and the default share message", () => {
  beforeEach(async () => {
    await t.env.DB.prepare("DELETE FROM events").run();
    await t.env.DB.prepare("DELETE FROM event_templates").run();
  });
  type Listing = { events: Record<string, unknown>[]; defaultShareMessage: string };
  const listing = async (): Promise<Listing> => (await (await list()).json()) as Listing;
  const upcoming = { startUtc: "2026-10-10T08:00:00Z", endUtc: "2026-10-10T09:00:00Z" };

  it("gives each upcoming event its details, cost and share message", async () => {
    await insertEvent(t.env.DB, { ...upcoming, costPence: 1750, details: "Bring water\nand a lead", shareMessage: "Come along to {event}" });
    await insertEvent(t.env.DB, { startUtc: "2026-10-11T08:00:00Z", endUtc: "2026-10-11T09:00:00Z", costPence: 0, details: "", shareMessage: "" });
    const { events } = await listing();
    expect(events.map((e) => [e.costPence, e.details, e.shareMessage])).toEqual([
      [1750, "Bring water\nand a lead", "Come along to {event}"], [0, "", ""],
    ]);
  });

  it("has an empty defaultShareMessage with no templates", async () => {
    expect((await listing()).defaultShareMessage).toBe("");
  });

  it("returns the default template's share message, and not another template's", async () => {
    await insertTemplate(t.env.DB, { name: "Other", shareMessage: "Not this one" });
    await insertTemplate(t.env.DB, { name: "Default", isDefault: true, shareMessage: "Join us: {event}" });
    expect((await listing()).defaultShareMessage).toBe("Join us: {event}");
  });

  it("has an empty defaultShareMessage when the default template's message is empty, or no template is the default", async () => {
    const def = await insertTemplate(t.env.DB, { name: "Default", isDefault: true, shareMessage: "" });
    await insertTemplate(t.env.DB, { name: "Other", shareMessage: "Not this one" });
    expect((await listing()).defaultShareMessage).toBe("");
    await t.env.DB.prepare("UPDATE event_templates SET is_default = 0 WHERE id = ?").bind(def.id).run();
    expect((await listing()).defaultShareMessage).toBe("");
  });

  it("answers in one batch (no extra round trip for the repairs or the default message)", async () => {
    let batches = 0;
    let statements = 0;
    const db = {
      prepare: (q: string) => t.env.DB.prepare(q),
      batch: (list: D1PreparedStatement[]) => { batches++; statements = list.length; return t.env.DB.batch(list); },
    };
    const res = await onRequestGet({
      request: new Request("http://localhost/api/admin/events"), env: { DB: db }, data: ADMIN,
    } as unknown as Parameters<typeof onRequestGet>[0]);
    expect(res.status).toBe(200);
    expect([batches, statements]).toEqual([1, 11]); // two idempotent layout repairs, then the nine reads
  });
});

describe("POST /api/admin/events: lanes and capacity", () => {
  it("creates the lanes in order with the capacity, and answers with them, ids included", async () => {
    const body = await create({ lanes: [{ name: "Ring 2" }, { name: "Ring 1" }], capacity: 3 });
    expect(body.event).toMatchObject({ capacity: 3, lanes: [{ id: expect.any(Number), name: "Ring 2" }, { id: expect.any(Number), name: "Ring 1" }] });
    const pub = (await publicEvent(body.event.slug)) as unknown as { event: { capacity: number; lanes: { name: string }[] } };
    expect(pub.event.capacity).toBe(3);
    expect(pub.event.lanes.map((l) => l.name)).toEqual(["Ring 2", "Ring 1"]);
  });

  it("answers with the event's configRev (0 for a new event), on a replay too, as the edit page needs it to save the layout", async () => {
    const key = generateBookingToken();
    const first = await post(draft({ idempotencyKey: key, capacity: 2 }));
    expect(((await first.json()) as { event: { configRev: number } }).event.configRev).toBe(0);
    const replay = await post(draft({ idempotencyKey: key, capacity: 2 }));
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(((await replay.json()) as { event: { configRev: number } }).event.configRev).toBe(0);
  });

  it("creates one unnamed lane and capacity 1 when the body says nothing", async () => {
    const body = await create();
    expect(body.event).toMatchObject({ capacity: 1, lanes: [{ id: expect.any(Number), name: "" }] });
  });

  it("answers a retry (same key, same lanes and capacity) with the same body and an Idempotent-Replayed header, and a changed layout with 422", async () => {
    const first = draft({ lanes: [{ name: "A" }, { name: "B" }], capacity: 2 });
    const one = await post(first);
    expect(one.status).toBe(201);
    const events = await countRows(t.env.DB, "events");
    const lanes = await countRows(t.env.DB, "event_lanes");
    const again = await post(first);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.json()).toEqual(await one.json());
    const changed = await post({ ...first, capacity: 3 });
    expect(changed.status).toBe(422);
    expect(((await changed.json()) as { error: { code: string } }).error.code).toBe("idempotency_key_reuse");
    expect([await countRows(t.env.DB, "events"), await countRows(t.env.DB, "event_lanes")]).toEqual([events, lanes]);
  });

  it("refuses bad lanes or capacity with field errors and stores nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ lanes: [{ name: "A" }, { name: "" }], capacity: 99 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: Record<string, string> }).fields).toEqual({
      capacity: "Enter a whole number of places from 1 to 50.", "lanes.1.name": "Enter the lane name.",
    });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });
});

describe("POST /api/admin/events: the booking form's fields and the identity limit", () => {
  const F = (label: string, over: Record<string, unknown> = {}) => ({ label, required: true, maxLength: 80, identity: false, ...over });
  const fieldsOf = async (res: Response) => ((await res.json()) as { fields: Record<string, string> }).fields;
  const post400 = async (over: Record<string, unknown>) => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft(over));
    expect(res.status, JSON.stringify(over)).toBe(400);
    expect(await countRows(t.env.DB, "events")).toBe(events);
    return fieldsOf(res);
  };

  it("creates the fields in order with the identity limit, stores them, and answers with them", async () => {
    const fields = [F("Rider", { identity: true }), F("Pony", { identity: true, maxLength: 30 }), F("Phone", { required: false, maxLength: 12 })];
    const body = await create({ fields, identityLimit: 2 });
    expect(body.event).toMatchObject({ fields, identityLimit: 2 });
    const id = (await t.env.DB.prepare("SELECT id FROM events WHERE slug = ?").bind(body.event.slug).first<{ id: number }>())!.id;
    expect((await t.env.DB.prepare("SELECT position, label, required, max_length, in_identity FROM event_fields WHERE event_id = ? ORDER BY position").bind(id).all()).results).toEqual([
      { position: 1, label: "Rider", required: 1, max_length: 80, in_identity: 1 },
      { position: 2, label: "Pony", required: 1, max_length: 30, in_identity: 1 },
      { position: 3, label: "Phone", required: 0, max_length: 12, in_identity: 0 },
    ]);
    expect(await t.env.DB.prepare("SELECT identity_limit FROM event_layout WHERE event_id = ?").bind(id).first()).toEqual({ identity_limit: 2 });
    const pub = (await publicEvent(body.event.slug)) as unknown as { event: { fields: unknown[] } };
    expect(pub.event.fields).toEqual([
      { position: 1, label: "Rider", required: true, maxLength: 80 }, { position: 2, label: "Pony", required: true, maxLength: 30 }, { position: 3, label: "Phone", required: false, maxLength: 12 },
    ]);
  });

  it("answers a retry (same key, same fields) with the same body and an Idempotent-Replayed header, and changed fields or limit with 422", async () => {
    const first = draft({ fields: [F("Car reg", { identity: true })], identityLimit: 2 });
    const one = await post(first);
    expect(one.status).toBe(201);
    const events = await countRows(t.env.DB, "events");
    const fieldRows = await countRows(t.env.DB, "event_fields");
    const again = await post(first);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.json()).toEqual(await one.json());
    for (const changed of [{ fields: [F("Car reg", { identity: true, maxLength: 10 })] }, { fields: [F("Registration", { identity: true })] }, { identityLimit: 3 }, { fields: undefined }]) {
      const res = await post({ ...first, ...changed });
      expect(res.status, JSON.stringify(changed)).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("idempotency_key_reuse");
    }
    expect([await countRows(t.env.DB, "events"), await countRows(t.env.DB, "event_fields")]).toEqual([events, fieldRows]);
  });

  it("answers a retry of a body that left the fields out as the same event, with the default Name field", async () => {
    const first = draft();
    const one = await post(first);
    const again = await post(first);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(await one.json());
  });

  describe("validation", () => {
    it("needs a list of one to four fields", async () => {
      expect(await post400({ fields: "Dog" })).toEqual({ fields: "Fields must be a list." });
      expect(await post400({ fields: {} })).toEqual({ fields: "Fields must be a list." });
      expect(await post400({ fields: [] })).toEqual({ fields: "A booking form needs at least one field." });
      expect(await post400({ fields: [1, 2, 3, 4, 5].map((i) => F(`F${i}`, { identity: i === 1 })) })).toEqual({ fields: "You can have at most 4 fields." });
      expect((await post(draft({ fields: [1, 2, 3, 4].map((i) => F(`F${i}`, { identity: i === 1 })) }))).status).toBe(201);
    });

    it("needs each field to be an object, keyed fields.N (counting from 0)", async () => {
      expect(await post400({ fields: [F("A", { identity: true }), "B", null] })).toEqual({ "fields.1": "Each field needs a label.", "fields.2": "Each field needs a label." });
    });

    it("checks the label like an event name: text, at most 40 characters, no invisible, control or line-separating characters", async () => {
      const bad = async (label: unknown) => (await post400({ fields: [F(label as string, { identity: true })] }))["fields.0.label"];
      expect(await bad(undefined)).toBe("Enter the field label.");
      expect(await bad(7)).toBe("Enter the field label.");
      expect(await bad("")).toBe("Enter the field label.");
      expect(await bad("   ")).toBe("Enter the field label.");
      expect(await bad("x".repeat(41))).toBe("The field label must be at most 40 characters.");
      expect(await bad("Do\u200Bg")).toContain("The field label can't contain invisible or direction-changing characters.");
      expect(await bad("Do\u2028g")).toBe("The field label can't contain line or paragraph separators.");
      expect(await bad("Do\u0007g")).toBe("The field label can't contain control characters.");
      expect(await bad("Do\ud800g")).toBe("The field label can't contain unpaired surrogate characters.");
      expect((await post(draft({ fields: [F("é".repeat(40), { identity: true })] }))).status).toBe(201);
    });

    it("trims a label and refuses two that are the same ignoring case, Unicode form and spacing at the ends", async () => {
      expect((await create({ fields: [F("  Dog  ", { identity: true })] })).event.fields).toEqual([F("Dog", { identity: true })]);
      expect(await post400({ fields: [F("Dog", { identity: true }), F("dog")] })).toEqual({ "fields.1.label": "Two fields can't have the same label." });
      expect(await post400({ fields: [F("Zo\u00EB", { identity: true }), F("ZOE\u0308")] })).toEqual({ "fields.1.label": "Two fields can't have the same label." });
      expect(await post400({ fields: [F("Dog", { identity: true }), F("Handler"), F("DOG ")] })).toEqual({ "fields.2.label": "Two fields can't have the same label." });
    });

    it("needs a longest value of a whole number from 1 to 80", async () => {
      for (const maxLength of [0, 81, 1.5, "10", null, undefined, -1]) {
        expect(await post400({ fields: [F("Dog", { identity: true, maxLength })] }), String(maxLength)).toEqual({ "fields.0.maxLength": "Enter a whole number of characters from 1 to 80." });
      }
      expect((await post(draft({ fields: [F("A", { identity: true, maxLength: 1 }), F("B", { maxLength: 80 })] }))).status).toBe(201);
    });

    it("needs required and identity to be true or false", async () => {
      expect(await post400({ fields: [F("Dog", { identity: true, required: "yes" })] })).toEqual({ "fields.0.required": "Required must be true or false." });
      expect(await post400({ fields: [F("Dog", { identity: "yes" })] })).toEqual({ "fields.0.identity": "Identifies a booking must be true or false." });
      expect(await post400({ fields: [{ label: "Dog" }] })).toEqual({
        "fields.0.maxLength": "Enter a whole number of characters from 1 to 80.", "fields.0.required": "Required must be true or false.", "fields.0.identity": "Identifies a booking must be true or false.",
      });
    });

    it("makes the first field required, and every field that identifies a booking", async () => {
      expect(await post400({ fields: [F("Dog", { required: false, identity: false }), F("Handler", { identity: true })] })).toEqual({ "fields.0.required": "The first field must be required." });
      expect(await post400({ fields: [F("Dog", { required: false, identity: true })] })).toEqual({ "fields.0.required": "The first field must be required." });
      expect(await post400({ fields: [F("Dog", { identity: true }), F("Handler", { required: false, identity: true })] })).toEqual({ "fields.1.required": "A field that identifies a booking must be required." });
      expect((await post(draft({ fields: [F("Dog", { identity: true }), F("Handler", { required: false, identity: false })] }))).status).toBe(201);
    });

    it("needs at least one field that identifies a booking", async () => {
      expect(await post400({ fields: [F("Dog"), F("Handler")] })).toEqual({ fields: "At least one field must identify a booking." });
    });

    it("needs an identity limit of a whole number from 1 to 20", async () => {
      for (const identityLimit of [0, 21, 1.5, "2", null, -3]) {
        expect(await post400({ identityLimit }), String(identityLimit)).toEqual({ identityLimit: "Enter a whole number of bookings from 1 to 20." });
      }
      expect((await create({ identityLimit: 20 })).event.identityLimit).toBe(20);
      expect((await create({ identityLimit: 1 })).event.identityLimit).toBe(1);
    });

    it("reports every error at once, with the other fields' errors", async () => {
      expect(await post400({ name: "", fields: [F("", { identity: true }), F("Dog", { maxLength: 0 })], identityLimit: 0 })).toEqual({
        name: "Enter the event name.", "fields.0.label": "Enter the field label.", "fields.1.maxLength": "Enter a whole number of characters from 1 to 80.",
        identityLimit: "Enter a whole number of bookings from 1 to 20.",
      });
    });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPrivacyNotice } from "../../../../server/config";
import type { AppEnv } from "../../../../server/env";
import { createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../../../../test/db";
import { onRequestGet } from "./index";

let t: TestEnv;
// The test events are dated 2026-06-13: pin the clock before them so bookings are open (Date only; timers stay real).
beforeAll(async () => {
  t = await createTestEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(() => { vi.setSystemTime(new Date("2026-06-01T00:00:00Z")); });
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

/** `vars` stands in for the Worker variables (BOOKING_CUTOFF_OFFSET_MINUTES, PRIVACY_NOTICE). */
const get = (slug: string, vars: Partial<AppEnv> = {}): Promise<Response> =>
  Promise.resolve(
    onRequestGet({
      request: new Request(`http://localhost/api/events/${slug}`),
      env: { DB: t.env.DB, ...vars },
      params: { slug },
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );

async function book(eventId: number, slotStart: string, dog: string, handler: string): Promise<void> {
  await insertBooking(t.env.DB, eventId, slotStart, dog, handler);
}

describe("GET /api/events/:slug", () => {
  it("maps the event details", async () => {
    const { slug, laneId } = await insertEvent(t.env.DB, {
      name: "Summer show", costPence: 1250, venuePostcode: "AB1 2CD", details: "Bring water",
    });
    const res = await get(slug);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { event: unknown };
    expect(body.event).toEqual({
      slug, name: "Summer show",
      startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T11:00:00Z",
      costPence: 1250, venuePostcode: "AB1 2CD", details: "Bring water", archived: false,
      lanes: [{ id: laneId, name: "" }], capacity: 1,
      fields: [{ position: 1, label: "Dog", required: true, maxLength: 80 }, { position: 2, label: "Handler", required: true, maxLength: 80 }],
    });
  });

  it("lists the booking form's fields in order with their label, whether they are required and their longest value, and never which identify a booking", async () => {
    const { slug } = await insertEvent(t.env.DB, {
      fields: [{ label: "Rider", identity: true }, { label: "Pony", identity: true }, { label: "Notes", required: false, maxLength: 20 }],
    });
    const text = await (await get(slug)).text();
    expect((JSON.parse(text) as { event: { fields: unknown } }).event.fields).toEqual([
      { position: 1, label: "Rider", required: true, maxLength: 80 }, { position: 2, label: "Pony", required: true, maxLength: 80 },
      { position: 3, label: "Notes", required: false, maxLength: 20 },
    ]);
    expect(text).not.toMatch(/identity/i);
  });

  it("serves an unlisted event exactly as a listed one, without saying it is unlisted", async () => {
    const listed = await insertEvent(t.env.DB, { name: "Same", slug: "L".repeat(22) });
    const unlisted = await insertEvent(t.env.DB, { name: "Same", slug: "U".repeat(22), listed: false });
    const [a, b] = await Promise.all([get(listed.slug), get(unlisted.slug)]);
    expect(b.status).toBe(200);
    const [bodyA, bodyB] = (await Promise.all([a.json(), b.json()])) as { event: Record<string, unknown>; slots: unknown[] }[];
    expect(bodyB.event).toEqual({ ...bodyA.event, slug: unlisted.slug, lanes: [{ id: unlisted.laneId, name: "" }] });
    const withoutLane = (slots: unknown[]) => (slots as { places: unknown[] }[]).map((s) => ({ ...s, places: (s.places as { free: number }[]).map((p) => p.free) }));
    expect(withoutLane(bodyB.slots)).toEqual(withoutLane(bodyA.slots));
    expect(JSON.stringify(bodyA)).not.toContain("listed");
    expect(JSON.stringify(bodyB)).not.toContain("listed");
  });

  it("lists sorted free slots and sets Cache-Control: no-store", async () => {
    const { slug, laneId } = await insertEvent(t.env.DB);
    const res = await get(slug);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { slots } = (await res.json()) as { slots: { start: string; end: string; status: string }[] };
    expect(slots).toHaveLength(12);
    expect(slots[0]).toEqual({ start: "2026-06-13T08:00:00Z", end: "2026-06-13T08:15:00Z", status: "free", places: [{ laneId, free: 1 }] });
    expect(slots.map((s) => s.start)).toEqual([...slots.map((s) => s.start)].sort());
    expect(slots.every((s) => s.status === "free")).toBe(true);
  });

  it("offers no slots inside a break", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
    const { slots } = (await (await get(slug)).json()) as { slots: { start: string }[] };
    const starts = slots.map((s) => s.start);
    expect(starts).toHaveLength(10);
    expect(starts).not.toContain("2026-06-13T09:00:00Z");
    expect(starts).not.toContain("2026-06-13T09:15:00Z");
    expect(starts).toContain("2026-06-13T09:30:00Z");
  });

  it("marks booked slots taken and the rest free; ignores bookings outside the schedule", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await book(id, "2026-06-13T08:15:00Z", "Rex", "Sam Jones");
    await book(id, "2026-06-13T08:07:00Z", "Fido", "Ann Lee");
    const { slots } = (await (await get(slug)).json()) as { slots: { start: string; status: string }[] };
    expect(slots).toHaveLength(12);
    expect(slots.filter((s) => s.status === "taken").map((s) => s.start)).toEqual(["2026-06-13T08:15:00Z"]);
  });

  it("returns 404 for an unknown slug", async () => {
    const res = await get("unknownslug0123456789");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("returns the same 404 for a malformed slug", async () => {
    const unknown = await get("unknownslug0123456789");
    const unknownBody = await unknown.json();
    for (const bad of ["short", "../etc/passwd", "a b c d e f g h i j k l", "é".repeat(20), "a".repeat(65)]) {
      const res = await get(bad);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(unknownBody);
    }
  });

  it("returns 200 with archived true and no slots for an archived event", async () => {
    const { slug } = await insertEvent(t.env.DB, { archived: true });
    const res = await get(slug);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { archived: boolean }; slots: unknown[]; bookings: unknown };
    expect(body.event.archived).toBe(true);
    expect(body.slots).toEqual([]);
    expect(body.bookings).toEqual({ open: false, closesAt: "2026-06-13T08:00:00Z" });
  });

  describe("bookings window", () => {
    const window = async (slug: string, vars?: Partial<AppEnv>) =>
      ((await (await get(slug, vars)).json()) as { bookings: unknown }).bookings;

    it("is open before the start, closing at the start by default", async () => {
      const { slug } = await insertEvent(t.env.DB);
      expect(await window(slug)).toEqual({ open: true, closesAt: "2026-06-13T08:00:00Z" });
    });

    it("closes exactly at the closing time, and still lists the slots", async () => {
      const { slug } = await insertEvent(t.env.DB);
      vi.setSystemTime(new Date("2026-06-13T07:59:59Z"));
      expect(await window(slug)).toEqual({ open: true, closesAt: "2026-06-13T08:00:00Z" });
      vi.setSystemTime(new Date("2026-06-13T08:00:00Z"));
      const body = (await (await get(slug)).json()) as { bookings: unknown; slots: unknown[] };
      expect(body.bookings).toEqual({ open: false, closesAt: "2026-06-13T08:00:00Z" });
      expect(body.slots).toHaveLength(12);
    });

    it("applies BOOKING_CUTOFF_OFFSET_MINUTES, positive or negative", async () => {
      const { slug } = await insertEvent(t.env.DB);
      vi.setSystemTime(new Date("2026-06-13T08:10:00Z"));
      expect(await window(slug, { BOOKING_CUTOFF_OFFSET_MINUTES: "30" })).toEqual({ open: true, closesAt: "2026-06-13T08:30:00Z" });
      expect(await window(slug, { BOOKING_CUTOFF_OFFSET_MINUTES: "-30" })).toEqual({ open: false, closesAt: "2026-06-13T07:30:00Z" });
    });
  });

  describe("slots whose start has passed", () => {
    const PLUS_60 = { BOOKING_CUTOFF_OFFSET_MINUTES: "60" };
    const statuses = async (slug: string, vars?: Partial<AppEnv>) =>
      Object.fromEntries(
        ((await (await get(slug, vars)).json()) as { slots: { start: string; status: string }[] }).slots
          .map((s) => [s.start.slice(11, 16), s.status]),
      );

    it("with +60 mid-event reports started slots past and later ones free", async () => {
      const { slug } = await insertEvent(t.env.DB);
      vi.setSystemTime(new Date("2026-06-13T08:40:00Z"));
      const got = await statuses(slug, PLUS_60);
      expect(got["08:00"]).toBe("past");
      expect(got["08:15"]).toBe("past");
      expect(got["08:30"]).toBe("past");
      expect(got["08:45"]).toBe("free");
      expect(got["10:45"]).toBe("free");
      const body = (await (await get(slug, PLUS_60)).json()) as { bookings: unknown };
      expect(body.bookings).toEqual({ open: true, closesAt: "2026-06-13T09:00:00Z" });
    });

    it("treats a slot as past from exactly its start instant", async () => {
      const { slug } = await insertEvent(t.env.DB);
      vi.setSystemTime(new Date("2026-06-13T08:14:59Z"));
      expect((await statuses(slug, PLUS_60))["08:15"]).toBe("free");
      vi.setSystemTime(new Date("2026-06-13T08:15:00Z"));
      expect((await statuses(slug, PLUS_60))["08:15"]).toBe("past");
      vi.setSystemTime(new Date("2026-06-13T08:15:01Z"));
      expect((await statuses(slug, PLUS_60))["08:15"]).toBe("past");
    });

    it("reports a slot that is both taken and past as taken", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      await book(id, "2026-06-13T08:15:00Z", "Rex", "Sam Jones");
      vi.setSystemTime(new Date("2026-06-13T08:40:00Z"));
      const got = await statuses(slug, PLUS_60);
      expect(got["08:15"]).toBe("taken");
      expect(got["08:00"]).toBe("past");
    });

    it("leaves offsets of 0 and -30 free before the start", async () => {
      const { slug } = await insertEvent(t.env.DB);
      vi.setSystemTime(new Date("2026-06-13T07:00:00Z"));
      for (const vars of [{}, { BOOKING_CUTOFF_OFFSET_MINUTES: "-30" }]) {
        expect(Object.values(await statuses(slug, vars)).every((s) => s === "free")).toBe(true);
      }
    });
  });

  describe("privacy notice", () => {
    const notice = async (vars?: Partial<AppEnv>) => {
      const { slug } = await insertEvent(t.env.DB);
      return ((await (await get(slug, vars)).json()) as { privacyNotice: string }).privacyNotice;
    };

    it("is the default for the form's labels when PRIVACY_NOTICE is unset or blank", async () => {
      expect(await notice()).toBe(defaultPrivacyNotice(["Dog", "Handler"]));
      expect(await notice({ PRIVACY_NOTICE: "  \n " })).toBe(defaultPrivacyNotice(["Dog", "Handler"]));
    });

    it("names the labels the event's form really has", async () => {
      const { slug } = await insertEvent(t.env.DB, { fields: [{ label: "Car reg", identity: true }] });
      const text = ((await (await get(slug)).json()) as { privacyNotice: string }).privacyNotice;
      expect(text).toBe(defaultPrivacyNotice(["Car reg"]));
      expect(text).toContain("(Car reg)");
      expect(text).not.toContain("Dog");
    });

    it("is the club's own text, trimmed, when set", async () => {
      expect(await notice({ PRIVACY_NOTICE: "  We keep names.\n\nAsk us to delete them.\n" }))
        .toBe("We keep names.\n\nAsk us to delete them.");
    });
  });

  it("never leaks names, keys, ids or timestamps of bookings", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await book(id, "2026-06-13T08:00:00Z", "Zxqdogname", "Zxqhandlername");
    const res = await get(slug, { PRIVACY_NOTICE: "Plain notice." }); // the default wording mentions dogs
    const text = await res.text();
    expect(text).toContain('"taken"');
    for (const secret of ["Zxqdogname", "Zxqhandlername", "zxqdogname", "zxqhandlername", "dog", "handler", "key", "created", "identity"]) {
      expect(text).not.toContain(secret);
    }
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["bookings", "event", "privacyNotice", "slots"]);
    // The lanes (id and name) and each slot's places (laneId and free) are what a booker needs; nothing else about them.
    const { event, slots } = body as { event: { lanes: object[]; fields: object[] }; slots: { places: object[] }[] };
    expect(Object.keys(body.event as object).sort()).toEqual(
      ["archived", "capacity", "costPence", "details", "endUtc", "fields", "lanes", "name", "slug", "startUtc", "venuePostcode"],
    );
    expect(event.fields.map((f) => Object.keys(f).sort())).toEqual(
      [["label", "maxLength", "position", "required"], ["label", "maxLength", "position", "required"]],
    );
    expect(event.lanes.map((l) => Object.keys(l).sort())).toEqual([["id", "name"]]);
    expect(slots.flatMap((s) => s.places.map((p) => Object.keys(p).sort()))).toEqual(slots.map(() => ["free", "laneId"]));
    // Lane ids and field positions are small numbers like any id, so look for the event's and the booking's ids with the lanes, fields and places left out.
    const scrubbed = JSON.stringify({ ...body, event: { ...event, lanes: [], fields: [] }, slots: slots.map((s) => ({ ...s, places: [] })) });
    expect(scrubbed).not.toMatch(new RegExp(`"id"|"${id}"|:${id}[,}]`));
  });
});

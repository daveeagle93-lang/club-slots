import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { identityKeyOf } from "../../../../core/identity";
import { generateBookingToken } from "../../../../core/slug";
import type { AppEnv } from "../../../../server/env";
import { createTestEnv, insertBooking, insertBreak, insertEvent, insertsBooking, interceptBatches, type TestEnv } from "../../../../test/db";
import { onRequestPost } from "./bookings";

// The test events are dated 2026-06-13: pin the clock before them so bookings are open (Date only; timers stay real).
const BEFORE_EVENTS = "2026-06-01T00:00:00Z";

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(() => { vi.setSystemTime(new Date(BEFORE_EVENTS)); });
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

const SLOT = "2026-06-13T08:00:00Z";

interface PostOptions {
  contentType?: string | null; raw?: string; env?: AppEnv;
  headers?: Record<string, string>; stream?: ReadableStream<Uint8Array>;
}

const post = (slug: string, body: unknown, o: PostOptions = {}): Promise<Response> => {
  const headers: Record<string, string> = { ...o.headers };
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  return Promise.resolve(
    onRequestPost({
      request: new Request(`http://localhost/api/events/${slug}/bookings`, {
        method: "POST", headers, body: o.stream ?? o.raw ?? JSON.stringify(body),
        ...(o.stream ? { duplex: "half" } : {}),
      } as RequestInit),
      env: o.env ?? t.env,
      params: { slug },
    } as unknown as Parameters<typeof onRequestPost>[0]),
  );
};

const newKey = generateBookingToken; // 22 base64url characters, the same shape as the browser's key

/** Each call is a different form load, so it gets a fresh key unless one is passed. */
const entry = (slot: string, dog: string, handler: string, idempotencyKey = newKey()) =>
  ({ slot, field1: dog, field2: handler, idempotencyKey });

/** The booking as the answer shows it for the Dog and Handler form: each value with its label. */
const dogHandler = (dog: string, handler: string) => [{ label: "Dog", value: dog }, { label: "Handler", value: handler }];

interface ErrorBody {
  error: { code: string; message: string };
  fields?: Record<string, string>;
  freeSlots?: { start: string; end: string; places: { laneId: number; free: number }[] }[];
}

async function rows(eventId: number): Promise<Record<string, unknown>[]> {
  const { results } = await t.env.DB.prepare("SELECT * FROM bookings WHERE event_id = ? ORDER BY slot_start_utc")
    .bind(eventId)
    .all<Record<string, unknown>>();
  return results;
}

/** Quarter-hour slots 08:00 to 10:45, as the default test event generates them, each with the one place of the event's lane free. */
const quarterSlots = (laneId?: number): { start: string; end: string; places?: { laneId: number; free: number }[] }[] =>
  Array.from({ length: 12 }, (_, i) => {
    const at = (m: number) => `2026-06-13T${String(8 + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00Z`;
    return { start: at(i * 15), end: at(i * 15 + 15), ...(laneId === undefined ? {} : { places: [{ laneId, free: 1 }] }) };
  });

describe("POST /api/events/:slug/bookings", () => {
  it("books a slot: 201, payload shape, row stored as entered (trimmed) with identity keys", async () => {
    const { id, slug, laneId } = await insertEvent(t.env.DB, { name: "Summer show", costPence: 1250, details: "Bring water" });
    const res = await post(slug, entry("2026-06-13T08:15:00Z", "  Zoë ", "Sam   Jones\t"));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const payload = await res.json();
    expect(payload).toEqual({
      booking: {
        slot: { start: "2026-06-13T08:15:00Z", end: "2026-06-13T08:30:00Z" }, lane: { id: laneId, name: "" },
        fields: dogHandler("Zoë", "Sam   Jones"),
      },
      event: {
        slug, name: "Summer show", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T11:00:00Z",
        costPence: 1250, venuePostcode: "AB1 2CD", details: "Bring water", archived: false,
        lanes: [{ id: laneId, name: "" }], capacity: 1,
        fields: [{ position: 1, label: "Dog", required: true, maxLength: 80 }, { position: 2, label: "Handler", required: true, maxLength: 80 }],
      },
      icsUrl: expect.stringMatching(new RegExp(`^/api/events/${slug}/bookings/[A-Za-z0-9_-]{22}/ics$`)),
    });
    const stored = await rows(id);
    expect(stored).toHaveLength(1);
    expect((payload as { icsUrl: string }).icsUrl).toBe(`/api/events/${slug}/bookings/${stored[0].token}/ics`);
    expect(stored[0]).toMatchObject({
      event_id: id, lane_id: laneId, slot_start_utc: "2026-06-13T08:15:00Z", place: 1, value_1: "Zoë", value_2: "Sam   Jones",
      identity_key: identityKeyOf(["Zoë", "Sam Jones"]), identity_seq: 1,
    });
    expect(stored[0].identity_key).toBe("zoë\u001fsam jones");
  });

  it("books an unlisted event through its link, and the response does not say it is unlisted", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { listed: false });
    const res = await post(slug, entry(SLOT, "Rex", "Sam"));
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toContain("listed");
    expect(await rows(id)).toHaveLength(1);
  });

  describe("concurrency (the database is the referee)", () => {
    it("20 parallel bookings for one slot: exactly one wins, nineteen get slot_taken", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) => post(slug, entry(SLOT, `Dog${i}`, `Handler${i}`))),
      );
      const tally: Record<string, number> = {};
      for (const r of responses) {
        const code = r.status === 201 ? "201" : `${r.status} ${((await r.json()) as ErrorBody).error.code}`;
        tally[code] = (tally[code] ?? 0) + 1;
      }
      console.info("one slot, 20 pairs:", JSON.stringify(tally));
      expect(tally).toEqual({ "201": 1, "409 slot_taken": 19 });
      const stored = await rows(id);
      expect(stored).toHaveLength(1);
      expect(stored[0].slot_start_utc).toBe(SLOT);
    });

    it("10 parallel bookings of one dog+handler to 10 slots: exactly one wins, nine get duplicate_booking", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const slots = quarterSlots().slice(0, 10);
      const responses = await Promise.all(slots.map((s) => post(slug, entry(s.start, "Rex", "Sam Jones"))));
      const tally: Record<string, number> = {};
      for (const r of responses) {
        const code = r.status === 201 ? "201" : `${r.status} ${((await r.json()) as ErrorBody).error.code}`;
        tally[code] = (tally[code] ?? 0) + 1;
      }
      console.info("one pair, 10 slots:", JSON.stringify(tally));
      expect(tally).toEqual({ "201": 1, "409 duplicate_booking": 9 });
      expect(await rows(id)).toHaveLength(1);
    });
  });

  describe("identity", () => {
    it("rejects the same dog+handler again, including case, Unicode and whitespace variants", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      expect((await post(slug, entry("2026-06-13T08:00:00Z", "Zoë", "Sam Jones"))).status).toBe(201);
      for (const [dog, handler] of [
        ["ZOË", " sam   jones "],
        ["Zoë", "SAM JONES"], // decomposed ë
        ["Zoë", "Sam Jones"],
      ]) {
        const res = await post(slug, entry("2026-06-13T08:15:00Z", dog, handler));
        expect(res.status).toBe(409);
        expect(((await res.json()) as ErrorBody).error.code).toBe("duplicate_booking");
      }
      expect(await rows(id)).toHaveLength(1);
    });

    it("rejects the same dog+handler again when the repeat hides an invisible character, and stores display names as entered", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      expect((await post(slug, entry("2026-06-13T08:00:00Z", "Rex \u2764\uFE0F", "Sam Jones"))).status).toBe(201);
      for (const [dog, handler] of [
        ["Rex \u2764", "Sam Jones"],
        ["Rex \u2764\uFE0F\uFE0F", "Sam\u3164 Jones"],
        ["Rex\u034F \u2764\uFE0F", "Sam Jones\uFE0F"],
      ]) {
        const res = await post(slug, entry("2026-06-13T08:15:00Z", dog, handler));
        expect(res.status, `${dog}/${handler}`).toBe(409);
        expect(((await res.json()) as ErrorBody).error.code).toBe("duplicate_booking");
      }
      const stored = await rows(id);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ value_1: "Rex \u2764\uFE0F", value_2: "Sam Jones" });
    });

    it("refuses a name with no letter or number, with a 400 naming the field", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const res = await post(slug, entry("2026-06-13T08:00:00Z", "\u3164", "Sam Jones"));
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).fields).toEqual({ field1: "Dog must contain at least one letter or number." });
      expect(await rows(id)).toHaveLength(0);
    });

    it("allows the same handler with a different dog, and the same pair in a different event", async () => {
      const a = await insertEvent(t.env.DB);
      const b = await insertEvent(t.env.DB);
      expect((await post(a.slug, entry("2026-06-13T08:00:00Z", "Rex", "Sam Jones"))).status).toBe(201);
      expect((await post(a.slug, entry("2026-06-13T08:15:00Z", "Fido", "Sam Jones"))).status).toBe(201);
      expect((await post(b.slug, entry("2026-06-13T08:00:00Z", "Rex", "Sam Jones"))).status).toBe(201);
      expect(await rows(a.id)).toHaveLength(2);
      expect(await rows(b.id)).toHaveLength(1);
    });

    it("gives duplicate_booking for a double submit (same pair, same slot), without naming anyone or any slot", async () => {
      const { slug } = await insertEvent(t.env.DB);
      await post(slug, entry(SLOT, "Rex", "Sam Jones"));
      const res = await post(slug, entry(SLOT, "rex", "sam jones"));
      expect(res.status).toBe(409);
      const text = await res.text();
      const body = JSON.parse(text) as ErrorBody;
      expect(body.error).toEqual({
        code: "duplicate_booking", message: "That dog and handler already have a booking for this event.",
      });
      expect(body.freeSlots).toBeUndefined();
      expect(text).not.toMatch(/Rex|Sam|2026-06-13T08/i);
    });
  });

  describe("no oracle for who has booked", () => {
    const S1 = "2026-06-13T08:00:00Z";
    const S2 = "2026-06-13T08:15:00Z";
    const S3 = "2026-06-13T08:30:00Z";

    it("says slot_taken, not duplicate_booking, when a known pair asks for a slot someone else holds", async () => {
      const { id, slug, laneId } = await insertEvent(t.env.DB);
      expect((await post(slug, entry(S1, "Rex", "Sam Jones"))).status).toBe(201); // pair A
      expect((await post(slug, entry(S2, "Fido", "Ann Lee"))).status).toBe(201); // pair B
      const res = await post(slug, entry(S2, "rex", "SAM JONES")); // pair A again, at B's slot
      expect(res.status).toBe(409);
      const text = await res.text();
      const body = JSON.parse(text) as ErrorBody;
      expect(body.error).toEqual({ code: "slot_taken", message: "That slot's just gone." });
      expect(body.freeSlots).toEqual(quarterSlots(laneId).filter((s) => s.start !== S1 && s.start !== S2));
      expect(text).not.toMatch(/Rex|Sam|Fido|Ann/i);
      expect(await rows(id)).toHaveLength(2);
    });

    it("answers a pair that has never booked the same way as one that has", async () => {
      const { slug } = await insertEvent(t.env.DB);
      await post(slug, entry(S1, "Rex", "Sam Jones"));
      await post(slug, entry(S2, "Fido", "Ann Lee"));
      const known = await post(slug, entry(S2, "Rex", "Sam Jones"));
      const unknown = await post(slug, entry(S2, "Nobody", "Here"));
      expect(known.status).toBe(unknown.status);
      expect(await known.text()).toBe(await unknown.text());
    });

    it("still says duplicate_booking for the pair's own slot and for a free slot", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      await post(slug, entry(S1, "Rex", "Sam Jones"));
      for (const slot of [S1, S3]) {
        const res = await post(slug, entry(slot, "Rex", "Sam Jones"));
        expect(res.status, slot).toBe(409);
        expect(((await res.json()) as ErrorBody).error.code, slot).toBe("duplicate_booking");
      }
      expect(await rows(id)).toHaveLength(1);
    });

    it("falls back to slot_taken with fresh free slots if the holding row has vanished by the time it is read", async () => {
      const { slug, laneId } = await insertEvent(t.env.DB);
      const racing = interceptBatches(t.env.DB, async (sqls, run) => {
        if (insertsBooking(sqls)) throw new Error("D1_ERROR: UNIQUE constraint failed: bookings.event_id, bookings.lane_id, bookings.slot_start_utc, bookings.place");
        return run();
      });
      const res = await post(slug, entry(S1, "Rex", "Sam Jones"), { env: { DB: racing } });
      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("slot_taken");
      expect(body.freeSlots).toEqual(quarterSlots(laneId));
    });
  });

  describe("slot_taken", () => {
    it("returns exactly the current free slots, with only their times and places, and no other people's names", async () => {
      const { id, slug, laneId } = await insertEvent(t.env.DB);
      await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
      expect((await post(slug, entry(SLOT, "Zxqdogname", "Zxqhandlername"))).status).toBe(201);
      expect((await post(slug, entry("2026-06-13T10:00:00Z", "Other", "Person"))).status).toBe(201);
      const res = await post(slug, entry(SLOT, "Fido", "Ann Lee"));
      expect(res.status).toBe(409);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      const body = JSON.parse(text) as ErrorBody;
      expect(body.error).toEqual({ code: "slot_taken", message: "That slot's just gone." });
      const taken = new Set([SLOT, "2026-06-13T09:00:00Z", "2026-06-13T09:15:00Z", "2026-06-13T10:00:00Z"]);
      const expected = quarterSlots(laneId).filter((s) => !taken.has(s.start));
      expect(expected).toHaveLength(8);
      expect(body.freeSlots).toEqual(expected);
      expect(Object.keys(body).sort()).toEqual(["error", "freeSlots"]);
      for (const secret of ["Zxqdogname", "Zxqhandlername", "Other", "Person", "Fido", "Ann", "key", "\"id\""]) {
        expect(text).not.toContain(secret);
      }
      expect(await rows(id)).toHaveLength(2);
    });
  });

  it("sends nosniff and noindex on success and on errors", async () => {
    const { slug } = await insertEvent(t.env.DB);
    for (const res of [
      await post(slug, entry(SLOT, "Rex", "Sam Jones")), // 201
      await post(slug, entry(SLOT, "Fido", "Ann Lee")), // 409
      await post("unknownslug0123456789", entry(SLOT, "Rex", "Sam")), // 404
      await post(slug, undefined, { raw: "{nope" }), // 400
    ]) {
      expect(res.headers.get("x-content-type-options"), String(res.status)).toBe("nosniff");
      expect(res.headers.get("x-robots-tag"), String(res.status)).toBe("noindex");
    }
  });

  describe("rejections", () => {
    it("returns 404 for an unknown or malformed slug", async () => {
      for (const slug of ["unknownslug0123456789", "short", "../etc/passwd"]) {
        const res = await post(slug, entry(SLOT, "Rex", "Sam"));
        expect(res.status).toBe(404);
        expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
      }
    });

    it("returns 410 for an archived event and inserts nothing", async () => {
      const { id, slug } = await insertEvent(t.env.DB, { archived: true });
      const res = await post(slug, entry(SLOT, "Rex", "Sam Jones"));
      expect(res.status).toBe(410);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as ErrorBody).error).toEqual({
        code: "event_archived", message: "This event is closed to bookings.",
      });
      expect(await rows(id)).toHaveLength(0);
    });

    it("reads the body before the archived check, so a retry can still find its booking: a bad content type beats archived", async () => {
      const { slug } = await insertEvent(t.env.DB, { archived: true });
      expect((await post(slug, {}, { contentType: "text/plain" })).status).toBe(415);
    });

    it("returns 400 invalid_slot for times that are not slots, and inserts nothing", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
      for (const slot of [
        "2026-06-13T09:00:00Z", // inside a break
        "2026-06-13T09:15:00Z", // inside a break
        "2026-06-13T08:07:00Z", // off the grid
        "2026-06-13T11:00:00Z", // at the end
        "2026-06-13T12:00:00Z", // after the end
        "2026-06-13T08:00:00.000Z", // not the canonical form
        "2026-06-13 08:00", "not a time", "",
      ]) {
        const res = await post(slug, entry(slot, "Rex", "Sam Jones"));
        expect(res.status, slot).toBe(400);
        expect(((await res.json()) as ErrorBody).error, slot).toEqual({
          code: "invalid_slot", message: "That time isn't one of this event's slots.",
        });
      }
      expect(await rows(id)).toHaveLength(0);
    });

    it("returns 400 invalid_input for a missing or non-string slot", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      for (const body of [{ field1: "Rex", field2: "Sam", idempotencyKey: newKey() }, { ...entry(SLOT, "Rex", "Sam"), slot: 123 }]) {
        const res = await post(slug, body);
        expect(res.status).toBe(400);
        const parsed = (await res.json()) as ErrorBody;
        expect(parsed.error.code).toBe("invalid_input");
        expect(Object.keys(parsed.fields ?? {})).toEqual(["slot"]);
      }
      expect(await rows(id)).toHaveLength(0);
    });

    it("returns 400 invalid_json for bad JSON and non-objects", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      for (const raw of ["{nope", "", "null", "[]", "\"text\"", "42"]) {
        const res = await post(slug, undefined, { raw });
        expect(res.status, raw).toBe(400);
        expect(((await res.json()) as ErrorBody).error.code, raw).toBe("invalid_json");
      }
      expect(await rows(id)).toHaveLength(0);
    });

    it("returns 415 unless the content type is application/json", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
        const res = await post(slug, entry(SLOT, "Rex", "Sam Jones"), { contentType });
        expect(res.status, String(contentType)).toBe(415);
        expect(((await res.json()) as ErrorBody).error.code).toBe("unsupported_media_type");
      }
      expect(await rows(id)).toHaveLength(0);
      const ok = await post(slug, entry(SLOT, "Rex", "Sam Jones"), { contentType: "Application/JSON; charset=utf-8" });
      expect(ok.status).toBe(201);
    });

    it("returns 413 for a body over 4 KB", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const res = await post(slug, { ...entry(SLOT, "Rex", "Sam Jones"), padding: "x".repeat(4096) });
      expect(res.status).toBe(413);
      expect(((await res.json()) as ErrorBody).error.code).toBe("payload_too_large");
      expect(await rows(id)).toHaveLength(0);
    });

    it("returns 413 from the declared Content-Length alone, before any database lookup", async () => {
      const exploding = { prepare: () => { throw new Error("database touched"); } } as unknown as D1Database;
      for (const slug of ["unknownslug0123456789", "short"]) {
        const res = await post(slug, entry(SLOT, "Rex", "Sam"), { headers: { "Content-Length": "4097" }, env: { DB: exploding } });
        expect(res.status, slug).toBe(413);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(((await res.json()) as ErrorBody).error.code).toBe("payload_too_large");
      }
    });

    it("accepts a declared Content-Length of exactly 4096 (and ignores a nonsense value)", async () => {
      const { slug } = await insertEvent(t.env.DB);
      const base = JSON.stringify({ ...entry(SLOT, "Rex", "Sam Jones"), padding: "" });
      const raw = JSON.stringify({ ...entry(SLOT, "Rex", "Sam Jones"), padding: "x".repeat(4096 - base.length) });
      expect(new TextEncoder().encode(raw).length).toBe(4096);
      expect((await post(slug, undefined, { raw, headers: { "Content-Length": "4096" } })).status).toBe(201);
      const { slug: other } = await insertEvent(t.env.DB);
      expect((await post(other, entry(SLOT, "Rex", "Sam"), { headers: { "Content-Length": "abc" } })).status).toBe(201);
    });

    it("counts the cap in bytes: 2000 two-byte characters is over 4096 bytes", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const res = await post(slug, { ...entry(SLOT, "Rex", "Sam"), padding: "é".repeat(2100) });
      expect(res.status).toBe(413);
      expect(await rows(id)).toHaveLength(0);
    });

    it("returns 413 for an oversized streamed body with no Content-Length, and cancels the stream", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const chunk = new TextEncoder().encode("x".repeat(1024));
      let pulled = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          if (pulled > 1000) return controller.close();
          controller.enqueue(chunk);
        },
        cancel() { cancelled = true; },
      });
      const res = await post(slug, undefined, { stream });
      expect(res.status).toBe(413);
      expect(((await res.json()) as ErrorBody).error.code).toBe("payload_too_large");
      expect(cancelled).toBe(true);
      expect(pulled).toBeLessThan(20); // stopped reading soon after the cap, not after 1000 KB
      expect(await rows(id)).toHaveLength(0);
    });

    it("still reads a normal streamed body in several chunks", async () => {
      const { slug } = await insertEvent(t.env.DB);
      const bytes = new TextEncoder().encode(JSON.stringify(entry(SLOT, "Zoë", "Sam")));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); // splits multi-byte ë
          controller.close();
        },
      });
      const res = await post(slug, undefined, { stream });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { booking: { fields: { value: string }[] } }).booking.fields[0].value).toBe("Zoë");
    });

    it("returns 400 invalid_input naming each bad name field", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const cases: [string, Record<string, unknown>, string[]][] = [
        ["missing dog", { slot: SLOT, field2: "Sam", idempotencyKey: newKey() }, ["field1"]],
        ["missing handler", { slot: SLOT, field1: "Rex", idempotencyKey: newKey() }, ["field2"]],
        ["both missing", { slot: SLOT, idempotencyKey: newKey() }, ["field1", "field2"]],
        ["the v1.0 names are not read any more", { slot: SLOT, dogName: "Rex", handlerName: "Sam", idempotencyKey: newKey() }, ["field1", "field2"]],
        ["non-string", entry(SLOT, "Rex", 7 as unknown as string), ["field2"]],
        ["blank", entry(SLOT, "   ", "Sam"), ["field1"]],
        ["too long (81 chars)", entry(SLOT, "Rex", "a".repeat(81)), ["field2"]],
        ["80 characters after trim is fine", entry(SLOT, "Rex", ` ${"a".repeat(80)} `), []],
        ["control character", entry(SLOT, "Re\u0000x", "Sam"), ["field1"]],
        ["newline inside", entry(SLOT, "Rex", "Sam\nJones"), ["field2"]],
        ["both bad", entry(SLOT, "", "\u0007"), ["field1", "field2"]],
      ];
      for (const [label, body, bad] of cases) {
        const res = await post(slug, body);
        if (bad.length === 0) {
          expect(res.status, label).toBe(201);
          continue;
        }
        expect(res.status, label).toBe(400);
        const parsed = (await res.json()) as ErrorBody;
        expect(parsed.error.code, label).toBe("invalid_input");
        expect(Object.keys(parsed.fields ?? {}).sort(), label).toEqual(bad);
        for (const message of Object.values(parsed.fields ?? {})) expect(message).toEqual(expect.any(String));
      }
      expect(await rows(id)).toHaveLength(1);
    });

    it("rejects a lone surrogate with 400 and inserts nothing (it would break the icsUrl after the insert)", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      // The escape survives JSON.parse as a real lone surrogate.
      const raw = `{"slot":"${SLOT}","field1":"Rex\\ud800","field2":"Sam","idempotencyKey":"${newKey()}"}`;
      const res = await post(slug, undefined, { raw });
      expect(res.status).toBe(400);
      const parsed = (await res.json()) as ErrorBody;
      expect(parsed.error.code).toBe("invalid_input");
      expect(Object.keys(parsed.fields ?? {})).toEqual(["field1"]);
      expect(await rows(id)).toHaveLength(0);
      const handler = `{"slot":"${SLOT}","field1":"Rex","field2":"\\udc00Sam","idempotencyKey":"${newKey()}"}`;
      expect(Object.keys(((await (await post(slug, undefined, { raw: handler })).json()) as ErrorBody).fields ?? {})).toEqual(["field2"]);
      expect(await rows(id)).toHaveLength(0);
    });

    describe("invisible and direction-changing characters", () => {
      const groups: [string, string[]][] = [
        ["soft hyphen", ["\u00AD"]],
        ["zero-width space", ["\u200B"]],
        ["LRM and RLM", ["\u200E", "\u200F"]],
        ["bidi embeddings and overrides", ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E"]],
        ["word joiner and invisible operators", ["\u2060", "\u2061", "\u2062", "\u2063", "\u2064"]],
        ["bidi isolates", ["\u2066", "\u2067", "\u2068", "\u2069"]],
        ["BOM / zero-width no-break space", ["\uFEFF"]],
      ];
      it.each(groups)("rejects %s inside, at the start and at the end of either name", async (_label, chars) => {
        const { id, slug } = await insertEvent(t.env.DB);
        for (const ch of chars) {
          for (const make of [(n: string) => `Re${ch}x${n}`, (n: string) => `${ch}${n}`, (n: string) => `${n}${ch}`]) {
            const res = await post(slug, entry(SLOT, make("Rex"), make("Sam")));
            const label = JSON.stringify(make("Rex"));
            expect(res.status, label).toBe(400);
            const parsed = (await res.json()) as ErrorBody;
            expect(parsed.error.code, label).toBe("invalid_input");
            expect(Object.keys(parsed.fields ?? {}).sort(), label).toEqual(["field1", "field2"]);
            expect(parsed.fields?.field1, label).toBe("Dog can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.");
          }
        }
        expect(await rows(id)).toHaveLength(0);
      });

      it("rejects a name made only of zero-width spaces (it would otherwise look blank but pass the blank check)", async () => {
        const { id, slug } = await insertEvent(t.env.DB);
        const res = await post(slug, entry(SLOT, "\u200B\u200B", "Sam"));
        expect(res.status).toBe(400);
        expect(Object.keys(((await res.json()) as ErrorBody).fields ?? {})).toEqual(["field1"]);
        expect(await rows(id)).toHaveLength(0);
      });

      it("rejects ZWJ and ZWNJ too: every Unicode format character (Cf) is refused, even in emoji sequences and some scripts", async () => {
        const { id, slug } = await insertEvent(t.env.DB);
        expect((await post(slug, entry(SLOT, "👨\u200D👩\u200D👧", "Sam"))).status).toBe(400);
        expect((await post(slug, entry("2026-06-13T08:15:00Z", "می\u200Cخواهم", "Sam"))).status).toBe(400);
        expect(await rows(id)).toHaveLength(0);
      });
    });

    it("refuses private-use characters and the braille blank beside a real letter, with a 400 naming the field, and stores nothing", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      for (const ch of ["\uE000", "\u{F0000}", "\u2800"]) {
        const res = await post(slug, entry(SLOT, `Rex${ch}`, `${ch}Sam`));
        expect(res.status, JSON.stringify(ch)).toBe(400);
        expect(((await res.json()) as ErrorBody).fields).toEqual({
          field1: "Dog can't contain private-use or blank-looking characters. Try plain text.",
          field2: "Handler can't contain private-use or blank-looking characters. Try plain text.",
        });
      }
      expect(await rows(id)).toHaveLength(0);
    });

    describe("line and paragraph separators (they could fake a line in a pasted lineup)", () => {
      it.each([
        ["LINE SEPARATOR U+2028", "\u2028", "can't contain line or paragraph separators"],
        ["PARAGRAPH SEPARATOR U+2029", "\u2029", "can't contain line or paragraph separators"],
        ["NEXT LINE U+0085 (a control character)", "\u0085", "can't contain control characters"],
      ])("rejects %s inside, at the start and at the end of either name", async (_label, ch, text) => {
        const { id, slug } = await insertEvent(t.env.DB);
        for (const make of [(n: string) => `${n}${ch}10:00 \u2014 free ${n}`, (n: string) => `${ch}${n}`, (n: string) => `${n}${ch}`]) {
          const res = await post(slug, entry(SLOT, make("Rex"), make("Sam")));
          const label = JSON.stringify(make("Rex"));
          expect(res.status, label).toBe(400);
          const parsed = (await res.json()) as ErrorBody;
          expect(parsed.error.code, label).toBe("invalid_input");
          expect(Object.keys(parsed.fields ?? {}).sort(), label).toEqual(["field1", "field2"]);
          expect(parsed.fields?.field1, label).toContain(text);
          expect(parsed.fields?.field2, label).toContain(text);
        }
        expect(await rows(id)).toHaveLength(0);
      });
    });

    it("counts the 80-character limit in code points, not UTF-16 units", async () => {
      const { slug } = await insertEvent(t.env.DB);
      expect((await post(slug, entry(SLOT, `a${"🐕".repeat(79)}`, "Sam"))).status).toBe(201);
      expect((await post(slug, entry("2026-06-13T08:15:00Z", `a${"🐕".repeat(80)}`, "Sam"))).status).toBe(400);
    });
  });

  describe("idempotency keys", () => {
    const S1 = "2026-06-13T08:00:00Z";
    const S2 = "2026-06-13T08:15:00Z";

    it("answers a retry after a dropped response with the original booking, token and icsUrl", async () => {
      const { id, slug, laneId } = await insertEvent(t.env.DB, { name: "Summer show" });
      const body = entry(S1, "Rex", "Sam Jones");
      void (await post(slug, body)); // the response is lost: its body is never read
      const stored = await rows(id);
      expect(stored).toHaveLength(1);

      const retry = await post(slug, body);
      expect(retry.status).toBe(201);
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      expect(retry.headers.get("cache-control")).toBe("no-store");
      expect(await retry.json()).toEqual({
        booking: { slot: { start: S1, end: "2026-06-13T08:15:00Z" }, lane: { id: laneId, name: "" }, fields: dogHandler("Rex", "Sam Jones") },
        event: expect.objectContaining({ slug, name: "Summer show", archived: false }),
        icsUrl: `/api/events/${slug}/bookings/${stored[0].token}/ics`,
      });
      expect(await rows(id)).toHaveLength(1);
    });

    it("gives a replay byte-for-byte the same body as the first response, and marks only the replay", async () => {
      const { slug } = await insertEvent(t.env.DB);
      const body = entry(S1, "Rex", "Sam Jones");
      const first = await post(slug, body);
      const second = await post(slug, body);
      const third = await post(slug, body);
      expect(first.headers.get("idempotent-replayed")).toBeNull();
      expect(second.headers.get("idempotent-replayed")).toBe("true");
      const original = await first.text();
      expect(await second.text()).toBe(original);
      expect(await third.text()).toBe(original);
    });

    it("replays with the names as first stored when the retry differs only in case or spacing", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const key = newKey();
      await post(slug, entry(S1, "Rex", "Sam Jones", key));
      const res = await post(slug, entry(S1, " REX ", "sam   jones", key));
      expect(res.status).toBe(201);
      expect(((await res.json()) as { booking: { fields: unknown } }).booking.fields).toEqual(dogHandler("Rex", "Sam Jones"));
      expect(await rows(id)).toHaveLength(1);
    });

    it("gives 6 simultaneous requests with one key exactly one row and one token", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const body = entry(S1, "Rex", "Sam Jones");
      const responses = await Promise.all(Array.from({ length: 6 }, () => post(slug, body)));
      expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
      const urls = await Promise.all(responses.map(async (r) => ((await r.json()) as { icsUrl: string }).icsUrl));
      expect(new Set(urls).size).toBe(1);
      const stored = await rows(id);
      expect(stored).toHaveLength(1);
      expect(urls[0]).toBe(`/api/events/${slug}/bookings/${stored[0].token}/ics`);
    });

    it("tells simultaneous requests with one key but different payloads apart: the winner's payload replays as 201, the rest are 422", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const key = newKey();
      // Three of each: whichever payload wins, its two duplicates must come back through the replay branch.
      const payloads = [
        ...Array.from({ length: 3 }, () => entry(S1, "Rex", "Sam Jones", key)),
        ...Array.from({ length: 3 }, () => entry(S2, "Fido", "Ann Lee", key)),
      ];
      const responses = await Promise.all(payloads.map((p) => post(slug, p)));
      const stored = await rows(id);
      expect(stored).toHaveLength(1);
      const winner = stored[0].slot_start_utc;
      const ics = `/api/events/${slug}/bookings/${stored[0].token}/ics`;
      for (const [i, res] of responses.entries()) {
        const body = (await res.json()) as { icsUrl?: string; error?: { code: string } };
        if (payloads[i].slot === winner) {
          expect(res.status).toBe(201);
          expect(body.icsUrl).toBe(ics);
        } else {
          expect(res.status).toBe(422);
          expect(body.error?.code).toBe("idempotency_key_reuse");
        }
      }
      // Exactly one request created the row; the other two with its payload replayed it.
      expect(responses.filter((r) => r.status === 201 && r.headers.get("idempotent-replayed") === null)).toHaveLength(1);
      expect(responses.filter((r) => r.headers.get("idempotent-replayed") === "true")).toHaveLength(2);
      expect(responses.filter((r) => r.status === 422)).toHaveLength(3);
    });

    describe("a key reused with a different payload", () => {
      // The key is a 128-bit secret held only by the browser that made the booking, so presenting it
      // proves ownership. That makes it safe to hand that booking back (as stored, never as requested)
      // so someone whose first response was lost, then edited the form, can still find their slot and
      // the calendar link. Nothing is ever returned for a key that no booking holds.
      const message = "An earlier attempt from this page was already saved, so this change wasn't applied. To change a booking, contact the organiser.";

      it.each([
        ["handler name", entry(S1, "Rex", "Sam Jones")],
        ["slot", entry(S2, "Rex", "Sam Jnes")],
        ["dog", entry(S1, "Fido", "Sam Jnes")],
      ])("answers a changed %s with 422 and the ORIGINAL booking, and writes nothing", async (_what, edited) => {
        const { id, slug, laneId } = await insertEvent(t.env.DB, { name: "Summer show" });
        const key = newKey();
        const first = await post(slug, entry(S1, "Rex", "Sam Jnes", key));
        const original = (await first.json()) as { icsUrl: string };
        const before = await rows(id);

        const res = await post(slug, { ...edited, idempotencyKey: key });
        expect(res.status).toBe(422);
        expect(res.headers.get("idempotent-replayed")).toBeNull();
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({
          error: { code: "idempotency_key_reuse", message },
          booking: { slot: { start: S1, end: "2026-06-13T08:15:00Z" }, lane: { id: laneId, name: "" }, fields: dogHandler("Rex", "Sam Jnes") },
          event: expect.objectContaining({ slug, name: "Summer show" }),
          icsUrl: original.icsUrl,
        });
        expect(await rows(id)).toEqual(before);
      });

      it("returns the stored spelling, not the requested one, even when the request differs in case and spelling", async () => {
        const { slug } = await insertEvent(t.env.DB);
        const key = newKey();
        await post(slug, entry(S1, "Rex", "Sam Jnes", key));
        const res = await post(slug, entry(S1, "REX", "SAM JONES", key));
        const body = (await res.json()) as { booking: { fields: unknown } };
        expect(res.status).toBe(422);
        expect(body.booking.fields).toEqual(dogHandler("Rex", "Sam Jnes"));
      });

      it("reveals nothing for a key that no booking holds", async () => {
        const { id, slug } = await insertEvent(t.env.DB);
        await post(slug, entry(S1, "Rex", "Sam Jones")); // someone else's booking, under another key
        const res = await post(slug, entry(S1, "Rex", "Sam Jones"));
        expect(res.status).toBe(409);
        const text = await res.text();
        expect(Object.keys(JSON.parse(text) as object)).toEqual(["error"]);
        expect(text).not.toMatch(/icsUrl|"booking"|\/ics|Sam/);
        expect(await rows(id)).toHaveLength(1);
      });

      it("finds a booking by event and key only: the same key in another event reveals nothing and is independent", async () => {
        const a = await insertEvent(t.env.DB);
        const b = await insertEvent(t.env.DB);
        const key = newKey();
        await post(a.slug, entry(S1, "Rex", "Sam Jones", key));
        const other = await post(b.slug, entry(S2, "Fido", "Ann Lee", key));
        expect(other.status).toBe(201);
        expect(other.headers.get("idempotent-replayed")).toBeNull();
        expect(((await other.json()) as { booking: { fields: { value: string }[] } }).booking.fields[0].value).toBe("Fido");
        // Event b's own key holder can see only event b's booking.
        const edited = await post(b.slug, entry(S2, "Fido", "Ann Leigh", key));
        expect(edited.status).toBe(422);
        const body = (await edited.json()) as { booking: { fields: { value: string }[] }; icsUrl: string };
        expect(body.booking.fields[0].value).toBe("Fido");
        expect(body.icsUrl).toContain(`/api/events/${b.slug}/`);
        expect(await rows(a.id)).toHaveLength(1);
        expect(await rows(b.id)).toHaveLength(1);
      });

      it("keeps a plain 422, with no booking, when the original slot has since left the schedule", async () => {
        const { id, slug } = await insertEvent(t.env.DB);
        const key = newKey();
        await post(slug, entry(S1, "Rex", "Sam Jnes", key));
        await t.env.DB.prepare("UPDATE bookings SET slot_start_utc = '2026-06-13T08:07:00Z' WHERE event_id = ?").bind(id).run();
        const res = await post(slug, entry(S2, "Rex", "Sam Jones", key));
        expect(res.status).toBe(422);
        const parsed = (await res.json()) as ErrorBody;
        expect(Object.keys(parsed)).toEqual(["error"]);
        expect(parsed.error.code).toBe("idempotency_key_reuse");
      });
    });

    it("keeps keys apart per event", async () => {
      const a = await insertEvent(t.env.DB);
      const b = await insertEvent(t.env.DB);
      const key = newKey();
      const first = await post(a.slug, entry(S1, "Rex", "Sam Jones", key));
      const second = await post(b.slug, entry(S1, "Rex", "Sam Jones", key));
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers.get("idempotent-replayed")).toBeNull();
      expect(((await first.json()) as { icsUrl: string }).icsUrl).not.toBe(((await second.json()) as { icsUrl: string }).icsUrl);
      expect(await rows(a.id)).toHaveLength(1);
      expect(await rows(b.id)).toHaveLength(1);
    });

    it("still replays once the booking cut-off has passed, but refuses new bookings", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const body = entry(S1, "Rex", "Sam Jones");
      const first = await post(slug, body);
      vi.setSystemTime(new Date("2026-06-13T08:00:00Z")); // exactly at the start: closed
      const retry = await post(slug, body);
      expect(retry.status).toBe(201);
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      expect(((await retry.json()) as { icsUrl: string }).icsUrl).toBe(((await first.json()) as { icsUrl: string }).icsUrl);
      expect((await post(slug, entry(S2, "Fido", "Ann Lee"))).status).toBe(410);
      expect(await rows(id)).toHaveLength(1);
    });

    it("still replays for an event archived after the first booking", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const body = entry(S1, "Rex", "Sam Jones");
      const first = await post(slug, body);
      await t.env.DB.prepare("UPDATE events SET archived = 1 WHERE id = ?").bind(id).run();
      const retry = await post(slug, body);
      expect(retry.status).toBe(201);
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      expect(((await retry.json()) as { icsUrl: string }).icsUrl).toBe(((await first.json()) as { icsUrl: string }).icsUrl);
      expect((await post(slug, entry(S2, "Fido", "Ann Lee"))).status).toBe(410);
      expect(await rows(id)).toHaveLength(1);
    });

    it("binds a key only once a booking exists: a 409 leaves it free for another slot", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      await post(slug, entry(S1, "Fido", "Ann Lee"));
      const key = newKey();
      const taken = await post(slug, entry(S1, "Rex", "Sam Jones", key));
      expect(taken.status).toBe(409);
      expect(((await taken.json()) as ErrorBody).error.code).toBe("slot_taken");
      const other = await post(slug, entry(S2, "Rex", "Sam Jones", key));
      expect(other.status).toBe(201);
      expect(other.headers.get("idempotent-replayed")).toBeNull();
      expect(await rows(id)).toHaveLength(2);
    });

    it("keeps duplicate_booking for a second booking by the same pair under a new key", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      expect((await post(slug, entry(S1, "Rex", "Sam Jones"))).status).toBe(201);
      const res = await post(slug, entry(S2, "Rex", "Sam Jones"));
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe("duplicate_booking");
      expect(await rows(id)).toHaveLength(1);
    });

    it("stores the key with the booking", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const key = newKey();
      await post(slug, entry(S1, "Rex", "Sam Jones", key));
      expect((await rows(id))[0].idempotency_key).toBe(key);
    });

    describe("validation", () => {
      const message = "Reload the page and try again.";
      it.each([
        ["missing", undefined],
        ["not a string", 1234567890123456],
        ["null", null],
        ["15 characters", "a".repeat(15)],
        ["65 characters", "a".repeat(65)],
        ["empty", ""],
        ["a space", "abcdefgh ijklmnop"],
        ["base64 plus", "abcdefgh+ijklmnop"],
        ["base64 padding", "abcdefghijklmnop=="],
        ["a non-ASCII letter", "abcdefghijklmnopé"],
        ["a newline", "abcdefghijklmnop\n"],
      ])("returns 400 invalid_input with a field message when the key is %s", async (_what, key) => {
        const { id, slug } = await insertEvent(t.env.DB);
        const body: Record<string, unknown> = { ...entry(S1, "Rex", "Sam Jones"), idempotencyKey: key };
        if (key === undefined) delete body.idempotencyKey;
        const res = await post(slug, body);
        expect(res.status).toBe(400);
        const parsed = (await res.json()) as ErrorBody;
        expect(parsed.error.code).toBe("invalid_input");
        expect(parsed.fields).toEqual({ idempotencyKey: message });
        expect(await rows(id)).toHaveLength(0);
      });

      it("accepts keys of 16 and 64 characters, and underscores and hyphens", async () => {
        const { slug } = await insertEvent(t.env.DB);
        expect((await post(slug, entry(S1, "Rex", "Sam Jones", "a_-".repeat(5) + "b"))).status).toBe(201);
        expect((await post(slug, entry(S2, "Fido", "Ann Lee", "Z".repeat(64)))).status).toBe(201);
      });

      it("reports the key alongside other bad fields", async () => {
        const { slug } = await insertEvent(t.env.DB);
        const res = await post(slug, { slot: S1, field1: "", field2: "Sam" });
        expect(Object.keys(((await res.json()) as ErrorBody).fields ?? {}).sort()).toEqual(["field1", "idempotencyKey"]);
      });
    });
  });

  describe("booking cut-off", () => {
    const START = "2026-06-13T08:00:00Z";
    const at = (iso: string) => vi.setSystemTime(new Date(iso));
    const withOffset = (value: string): AppEnv => ({ DB: t.env.DB, BOOKING_CUTOFF_OFFSET_MINUTES: value });

    it.each([
      ["default offset: open 1 s before the start", undefined, "2026-06-13T07:59:59Z", 201],
      ["default offset: closed exactly at the start", undefined, START, 410],
      ["default offset: closed after the start", undefined, "2026-06-13T09:00:00Z", 410],
      ["+30: open 1 s before the cut-off", "30", "2026-06-13T08:29:59Z", 201],
      ["+30: closed exactly at the cut-off", "30", "2026-06-13T08:30:00Z", 410],
      ["-30: open 1 s before the cut-off", "-30", "2026-06-13T07:29:59Z", 201],
      ["-30: closed exactly at the cut-off", "-30", "2026-06-13T07:30:00Z", 410],
    ])("%s", async (_what, offset, now, status) => {
      const { id, slug } = await insertEvent(t.env.DB);
      at(now);
      const res = await post(slug, entry("2026-06-13T10:00:00Z", "Rex", "Sam Jones"), {
        ...(offset === undefined ? {} : { env: withOffset(offset) }),
      });
      expect(res.status).toBe(status);
      expect(await rows(id)).toHaveLength(status === 201 ? 1 : 0);
    });

    it("returns 410 bookings_closed, distinct from event_archived, with no-store", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      at(START);
      const res = await post(slug, entry(START, "Rex", "Sam Jones"));
      expect(res.status).toBe(410);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as ErrorBody).error).toEqual({
        code: "bookings_closed", message: "Bookings for this event are now closed.",
      });
      expect(await rows(id)).toHaveLength(0);
    });

    it("keeps event_archived for an archived event even before the cut-off", async () => {
      const { slug } = await insertEvent(t.env.DB, { archived: true });
      const res = await post(slug, entry(START, "Rex", "Sam Jones"));
      expect(((await res.json()) as ErrorBody).error.code).toBe("event_archived");
    });

    it("falls back to the default offset, with a warning, for an invalid setting", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { slug } = await insertEvent(t.env.DB);
        at("2026-06-13T08:00:01Z");
        expect((await post(slug, entry(START, "Rex", "Sam Jones"), { env: withOffset("soon") })).status).toBe(410);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("slots that have already started (positive offset)", () => {
    const at = (iso: string) => vi.setSystemTime(new Date(iso));
    const plus60 = (): AppEnv => ({ DB: t.env.DB, BOOKING_CUTOFF_OFFSET_MINUTES: "60" });
    const minus30 = (): AppEnv => ({ DB: t.env.DB, BOOKING_CUTOFF_OFFSET_MINUTES: "-30" });
    const startsOf = (list: { start: string }[] | undefined) => (list ?? []).map((s) => s.start.slice(11, 16));

    it.each([
      ["1 s before the slot starts", "2026-06-13T08:29:59Z", 201],
      ["exactly at the slot's start", "2026-06-13T08:30:00Z", 409],
      ["1 s after the slot starts", "2026-06-13T08:30:01Z", 409],
    ])("+60, 08:30 slot, %s", async (_what, now, status) => {
      const { id, slug } = await insertEvent(t.env.DB);
      at(now);
      const res = await post(slug, entry("2026-06-13T08:30:00Z", "Rex", "Sam Jones"), { env: plus60() });
      expect(res.status).toBe(status);
      if (status === 409) expect(((await res.json()) as ErrorBody).error.code).toBe("slot_started");
      expect(await rows(id)).toHaveLength(status === 201 ? 1 : 0);
    });

    it("returns 409 slot_started for a started slot, with only bookable freeSlots and no-store", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      await post(slug, entry("2026-06-13T09:00:00Z", "Fido", "Ann Lee"));
      at("2026-06-13T08:40:00Z");
      const res = await post(slug, entry("2026-06-13T08:15:00Z", "Rex", "Sam Jones"), { env: plus60() });
      expect(res.status).toBe(409);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const parsed = (await res.json()) as ErrorBody;
      expect(parsed.error).toEqual({ code: "slot_started", message: "That session has already started." });
      expect(startsOf(parsed.freeSlots)).toEqual(
        ["08:45", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45"],
      );
      expect(Object.keys(parsed.freeSlots![0]).sort()).toEqual(["end", "places", "start"]);
      expect(await rows(id)).toHaveLength(1); // only Fido's earlier booking
    });

    it("books a later slot in the same event while the earlier ones are refused", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      at("2026-06-13T08:40:00Z");
      expect((await post(slug, entry("2026-06-13T08:30:00Z", "Rex", "Sam Jones"), { env: plus60() })).status).toBe(409);
      expect((await post(slug, entry("2026-06-13T08:45:00Z", "Rex", "Sam Jones"), { env: plus60() })).status).toBe(201);
      expect((await rows(id)).map((r) => r.slot_start_utc)).toEqual(["2026-06-13T08:45:00Z"]);
    });

    it("keeps invalid_slot for a time that is not a slot, even mid-event", async () => {
      const { slug } = await insertEvent(t.env.DB);
      at("2026-06-13T08:40:00Z");
      const res = await post(slug, entry("2026-06-13T08:07:00Z", "Rex", "Sam Jones"), { env: plus60() });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe("invalid_slot");
    });

    it("checks the window first: after the cut-off a started slot is bookings_closed", async () => {
      const { slug } = await insertEvent(t.env.DB);
      at("2026-06-13T09:00:00Z");
      const res = await post(slug, entry("2026-06-13T08:15:00Z", "Rex", "Sam Jones"), { env: plus60() });
      expect(res.status).toBe(410);
      expect(((await res.json()) as ErrorBody).error.code).toBe("bookings_closed");
    });

    it("refuses a started slot that is already booked as slot_started, not slot_taken", async () => {
      const { slug } = await insertEvent(t.env.DB);
      await post(slug, entry("2026-06-13T08:15:00Z", "Fido", "Ann Lee"));
      at("2026-06-13T08:40:00Z");
      const res = await post(slug, entry("2026-06-13T08:15:00Z", "Rex", "Sam Jones"), { env: plus60() });
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe("slot_started");
    });

    it("still replays an idempotent retry of a booking whose slot has since started", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const body = entry("2026-06-13T08:15:00Z", "Rex", "Sam Jones");
      const first = await post(slug, body, { env: plus60() });
      expect(first.status).toBe(201);
      at("2026-06-13T08:40:00Z"); // slot started, window still open
      const retry = await post(slug, body, { env: plus60() });
      expect(retry.status).toBe(201);
      expect(retry.headers.get("idempotent-replayed")).toBe("true");
      expect(((await retry.json()) as { icsUrl: string }).icsUrl).toBe(((await first.json()) as { icsUrl: string }).icsUrl);
      expect(await rows(id)).toHaveLength(1);
    });

    it("slot_taken freeSlots leaves out started slots", async () => {
      const { slug } = await insertEvent(t.env.DB);
      await post(slug, entry("2026-06-13T09:00:00Z", "Fido", "Ann Lee"));
      at("2026-06-13T08:40:00Z");
      const res = await post(slug, entry("2026-06-13T09:00:00Z", "Rex", "Sam Jones"), { env: plus60() });
      expect(res.status).toBe(409);
      const parsed = (await res.json()) as ErrorBody;
      expect(parsed.error.code).toBe("slot_taken");
      expect(startsOf(parsed.freeSlots)).toEqual(["08:45", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45"]);
    });

    it("leaves offsets of -30 and 0 as before: free slots listed in full, closed means 410", async () => {
      const { slug } = await insertEvent(t.env.DB);
      await post(slug, entry("2026-06-13T10:00:00Z", "Fido", "Ann Lee"));
      at("2026-06-13T07:00:00Z");
      for (const env of [minus30(), t.env]) {
        const res = await post(slug, entry("2026-06-13T10:00:00Z", "Rex", "Sam Jones"), { env });
        expect(((await res.json()) as ErrorBody).error.code).toBe("slot_taken");
      }
      const res = await post(slug, entry("2026-06-13T10:00:00Z", "Rex", "Sam Jones"), { env: minus30() });
      expect(startsOf(((await res.json()) as ErrorBody).freeSlots)).toHaveLength(11);
      at("2026-06-13T07:30:00Z");
      expect((await post(slug, entry("2026-06-13T10:15:00Z", "Rex", "Sam Jones"), { env: minus30() })).status).toBe(410);
      at("2026-06-13T08:00:00Z");
      expect((await post(slug, entry("2026-06-13T10:15:00Z", "Rex", "Sam Jones"))).status).toBe(410);
    });
  });

  describe("an edit racing the booking (the insert is guarded on the schedule)", () => {
    const LAST = "2026-06-13T10:45:00Z";
    /** The real database, except that `before` runs once per booking insert (up to `times`) just before its batch: the edit lands between the handler's read and its insert. */
    const racing = (before: () => Promise<void>, times = 1) => {
      let batches = 0;
      const env = {
        DB: interceptBatches(t.env.DB, async (sqls, run) => {
          if (!insertsBooking(sqls)) return run();
          batches++;
          if (batches <= times) await before();
          return run();
        }),
      };
      return { env, batches: () => batches };
    };

    it("answers invalid_slot and writes nothing when the edit removed the requested slot", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const r = racing(async () => { await t.env.DB.prepare("UPDATE events SET end_utc = '2026-06-13T10:30:00Z' WHERE id = ?").bind(id).run(); });
      const res = await post(slug, entry(LAST, "Rex", "Sam Jones"), { env: r.env });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error).toEqual({ code: "invalid_slot", message: "That time isn't one of this event's slots." });
      expect(await rows(id)).toHaveLength(0);
      expect(r.batches()).toBe(1);
    });

    it("answers not_found when the event was deleted in between", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const r = racing(async () => { await t.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run(); });
      const res = await post(slug, entry(SLOT, "Rex", "Sam Jones"), { env: r.env });
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
      expect(await rows(id)).toHaveLength(0);
    });

    it("retries once against the fresh event when the edit kept the slot, and books it", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const r = racing(() => insertBreak(t.env.DB, id, "2026-06-13T10:00:00Z", "2026-06-13T10:15:00Z"));
      const res = await post(slug, entry(SLOT, "Rex", "Sam Jones"), { env: r.env });
      expect(res.status).toBe(201);
      expect(r.batches()).toBe(2);
      expect(await rows(id)).toHaveLength(1);
    });

    it("gives 409 event_changed, writing nothing, when the schedule changes again during the retry", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const breaks = ["2026-06-13T09:00:00Z", "2026-06-13T10:00:00Z"];
      const r = racing(() => { const at = breaks.shift()!; return insertBreak(t.env.DB, id, at, at.replace(":00:00", ":15:00")); }, 2);
      const res = await post(slug, entry(SLOT, "Rex", "Sam Jones"), { env: r.env });
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error).toEqual({
        code: "event_changed", message: "The event was just changed. Reload the page and try again.",
      });
      expect(await rows(id)).toHaveLength(0);
      expect(r.batches()).toBe(2);
    });

    it("still classifies a UNIQUE failure after a retry (slot_taken)", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const r = racing(async () => {
        await insertBreak(t.env.DB, id, "2026-06-13T10:00:00Z", "2026-06-13T10:15:00Z");
        await insertBooking(t.env.DB, id, SLOT, "Other", "Person");
      });
      const res = await post(slug, entry(SLOT, "Rex", "Sam Jones"), { env: r.env });
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe("slot_taken");
      expect(await rows(id)).toHaveLength(1);
    });
  });

  describe("an edit of the booking form racing the booking (the retry is checked against the fresh form)", () => {
    const body = (over: Record<string, unknown>) => ({ slot: SLOT, idempotencyKey: newKey(), ...over });
    /** The real database, except that `edit` runs once, just before the first booking insert: the form is edited between the handler's read and its insert. */
    const racing = (edit: () => Promise<unknown>) => {
      let first = true;
      return {
        DB: interceptBatches(t.env.DB, async (sqls, run) => {
          if (insertsBooking(sqls) && first) {
            first = false;
            await edit();
          }
          return run();
        }),
      };
    };
    const bump = (id: number) => t.env.DB.prepare("UPDATE event_layout SET config_rev = config_rev + 1 WHERE event_id = ?").bind(id).run();
    const answer = async (res: Response) => ({ status: res.status, ...((await res.json()) as ErrorBody) });

    it("refuses a value that is longer than the new longest value, writing nothing", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const env = racing(async () => {
        await t.env.DB.prepare("UPDATE event_fields SET max_length = 5 WHERE event_id = ? AND position = 1").bind(id).run();
        await bump(id);
      });
      const res = await answer(await post(slug, body({ field1: "Fly-away", field2: "Pat" }), { env }));
      expect(res).toMatchObject({ status: 400, error: { code: "invalid_input" }, fields: { field1: "Dog must be at most 5 characters." } });
      expect(await rows(id)).toHaveLength(0);
    });

    it("refuses a blank value for an optional field that became required, writing nothing", async () => {
      const { id, slug } = await insertEvent(t.env.DB, { fields: [{ label: "Rider", identity: true }, { label: "Phone", required: false }] });
      const env = racing(async () => {
        await t.env.DB.prepare("UPDATE event_fields SET required = 1 WHERE event_id = ? AND position = 2").bind(id).run();
        await bump(id);
      });
      const res = await answer(await post(slug, body({ field1: "Ann" }), { env }));
      expect(res).toMatchObject({ status: 400, error: { code: "invalid_input" }, fields: { field2: "Phone is required." } });
      expect(await rows(id)).toHaveLength(0);
    });

    it("answers 400 for the new field, not 500, when the form grew from one field to two", async () => {
      const { id, slug } = await insertEvent(t.env.DB, { fields: [{ label: "Car reg", identity: true }] });
      const env = racing(async () => {
        await t.env.DB.prepare("INSERT INTO event_fields (event_id, position, label, required, max_length, in_identity) VALUES (?, 2, 'Driver', 1, 80, 1)").bind(id).run();
        await bump(id);
      });
      const res = await answer(await post(slug, body({ field1: "AB12 CDE" }), { env }));
      expect(res).toMatchObject({ status: 400, error: { code: "invalid_input" }, fields: { field2: "Driver is required." } });
      expect(await rows(id)).toHaveLength(0);
    });

    it("books with the fresh form's one value, and stores nothing in the second column, when the form shrank from two fields to one", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const env = racing(async () => {
        await t.env.DB.prepare("DELETE FROM event_fields WHERE event_id = ? AND position = 2").bind(id).run();
        await bump(id);
      });
      const res = await answer(await post(slug, body({ field1: "Rex", field2: "Sam Jones" }), { env }));
      expect(res).toMatchObject({ status: 201, booking: { fields: [{ label: "Dog", value: "Rex" }] } });
      expect(await rows(id)).toMatchObject([{ value_1: "Rex", value_2: "", identity_key: identityKeyOf(["Rex"]) }]);
    });

    it("books when the edit left the form as the request was checked against", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const env = racing(() => bump(id));
      expect((await post(slug, body({ field1: "Rex", field2: "Sam Jones" }), { env })).status).toBe(201);
      expect(await rows(id)).toHaveLength(1);
    });

    it("refuses a lane the edit removed with the laneId message, writing nothing", async () => {
      const { id, slug, laneIds } = await insertEvent(t.env.DB, { lanes: ["Ring 1", "Ring 2"] });
      const env = racing(async () => {
        await t.env.DB.prepare("DELETE FROM event_lanes WHERE id = ?").bind(laneIds[1]).run();
        await bump(id);
      });
      const res = await answer(await post(slug, body({ field1: "Rex", field2: "Sam Jones", laneId: laneIds[1] }), { env }));
      expect(res).toMatchObject({ status: 400, error: { code: "invalid_input" }, fields: { laneId: "Choose a lane." } });
      expect(await rows(id)).toHaveLength(0);
    });
  });

  describe("unexpected failures", () => {
    it("returns a generic 500 and logs, without leaking SQL, when the insert fails for another reason", async () => {
      const { slug } = await insertEvent(t.env.DB);
      const failing = interceptBatches(t.env.DB, async (sqls, run) => {
        if (insertsBooking(sqls)) throw new Error("D1_ERROR: SECRET sql detail");
        return run();
      });
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await post(slug, entry(SLOT, "Rex", "Sam Jones"), { env: { DB: failing } });
        expect(res.status).toBe(500);
        const text = await res.text();
        expect((JSON.parse(text) as ErrorBody).error.code).toBe("internal_error");
        expect(text).not.toMatch(/SECRET|D1_ERROR|INSERT/);
        expect(spy).toHaveBeenCalledTimes(1);
        // Strings only: never the raw error object (its stack and cause can carry SQL and bound values).
        expect(spy.mock.calls[0]).toEqual(["createBooking failed:", "D1_ERROR: SECRET sql detail"]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("lanes and places", () => {
    const withLane = (slot: string, dog: string, handler: string, laneId?: unknown) => ({ ...entry(slot, dog, handler), ...(laneId === undefined ? {} : { laneId }) });
    const fieldsOf = async (res: Response) => ((await res.json()) as ErrorBody).fields;

    it("books the event's only lane when laneId is left out, and says which lane in the answer", async () => {
      const { id, slug, laneId } = await insertEvent(t.env.DB);
      const res = await post(slug, withLane(SLOT, "Rex", "Sam"));
      expect(res.status).toBe(201);
      expect(((await res.json()) as { booking: { lane: unknown } }).booking.lane).toEqual({ id: laneId, name: "" });
      expect((await rows(id))[0]).toMatchObject({ lane_id: laneId, place: 1 });
    });

    it("accepts the only lane's id when it is sent", async () => {
      const { slug, laneId } = await insertEvent(t.env.DB);
      expect((await post(slug, withLane(SLOT, "Rex", "Sam", laneId))).status).toBe(201);
    });

    it("books the chosen lane of several, naming it in the answer", async () => {
      const { id, slug, laneIds } = await insertEvent(t.env.DB, { lanes: ["Ring 1", "Ring 2"] });
      const res = await post(slug, withLane(SLOT, "Rex", "Sam", laneIds[1]));
      expect(res.status).toBe(201);
      expect(((await res.json()) as { booking: { lane: unknown } }).booking.lane).toEqual({ id: laneIds[1], name: "Ring 2" });
      expect((await rows(id))[0]).toMatchObject({ lane_id: laneIds[1] });
    });

    it("refuses a missing laneId with 400 invalid_input fields.laneId when the event has two or more lanes, writing nothing", async () => {
      const { id, slug } = await insertEvent(t.env.DB, { lanes: ["Ring 1", "Ring 2"] });
      const res = await post(slug, withLane(SLOT, "Rex", "Sam"));
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody & { error: { code: string } }).error.code).toBe("invalid_input");
      expect(await rows(id)).toHaveLength(0);
      expect(await fieldsOf(await post(slug, withLane(SLOT, "Rex", "Sam")))).toEqual({ laneId: "Choose a lane." });
    });

    it.each([["an unknown id", 987654], ["a string", "1"], ["null", null], ["a float", 1.5], ["zero", 0], ["an object", {}]])("refuses laneId as %s with fields.laneId", async (_what, laneId) => {
      const { id, slug } = await insertEvent(t.env.DB, { lanes: ["Ring 1", "Ring 2"] });
      const res = await post(slug, withLane(SLOT, "Rex", "Sam", laneId));
      expect(res.status).toBe(400);
      expect(await fieldsOf(res)).toEqual({ laneId: "Choose a lane." });
      expect(await rows(id)).toHaveLength(0);
    });

    it("refuses another event's lane, and reports it together with the other field errors", async () => {
      const { slug } = await insertEvent(t.env.DB, { lanes: ["Ring 1", "Ring 2"] });
      const other = await insertEvent(t.env.DB);
      const res = await post(slug, withLane(SLOT, "", "Sam", other.laneId));
      expect(res.status).toBe(400);
      expect(await fieldsOf(res)).toEqual({ field1: "Dog is required.", laneId: "Choose a lane." });
    });

    it("refuses a lane id on a one-lane event when it is not that lane's", async () => {
      const { slug } = await insertEvent(t.env.DB);
      const other = await insertEvent(t.env.DB);
      expect(await fieldsOf(await post(slug, withLane(SLOT, "Rex", "Sam", other.laneId)))).toEqual({ laneId: "Choose a lane." });
    });

    it("lets a capacity-3 slot take three different bookings in places 1, 2 and 3, then answers slot_taken with the lane's places", async () => {
      const { id, slug, laneId } = await insertEvent(t.env.DB, { capacity: 3 });
      for (const [dog, place] of [["A", 1], ["B", 2], ["C", 3]] as const) {
        const res = await post(slug, withLane(SLOT, dog, "H"));
        expect(res.status, dog).toBe(201);
        expect((await rows(id)).find((r) => r.value_1 === dog)?.place).toBe(place);
      }
      const res = await post(slug, withLane(SLOT, "D", "H"));
      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("slot_taken");
      expect(body.freeSlots?.map((s) => s.start)).not.toContain(SLOT);
      expect(body.freeSlots?.[0].places).toEqual([{ laneId, free: 3 }]);
    });

    it("keeps the same dog+handler to one booking per event while the identity limit is 1, however many places there are", async () => {
      const { slug } = await insertEvent(t.env.DB, { capacity: 3 });
      expect((await post(slug, withLane(SLOT, "Rex", "Sam"))).status).toBe(201);
      const again = await post(slug, withLane("2026-06-13T08:15:00Z", "Rex", "Sam"));
      expect(again.status).toBe(409);
      expect(((await again.json()) as ErrorBody).error.code).toBe("duplicate_booking");
    });

    it("lets one identity book up to the event's identity limit", async () => {
      const { id, slug } = await insertEvent(t.env.DB, { identityLimit: 2 });
      expect((await post(slug, withLane(SLOT, "Rex", "Sam"))).status).toBe(201);
      expect((await post(slug, withLane("2026-06-13T08:15:00Z", "Rex", "Sam"))).status).toBe(201);
      expect((await post(slug, withLane("2026-06-13T08:30:00Z", "Rex", "Sam"))).status).toBe(409);
      expect((await rows(id)).map((r) => r.identity_seq)).toEqual([1, 2]);
    });

    it("answers a replay with the lane it was booked in, and a changed lane with idempotency_key_reuse", async () => {
      const { slug, laneIds } = await insertEvent(t.env.DB, { lanes: ["Ring 1", "Ring 2"] });
      const key = newKey();
      expect((await post(slug, { ...withLane(SLOT, "Rex", "Sam", laneIds[0]), idempotencyKey: key })).status).toBe(201);
      const same = await post(slug, { ...withLane(SLOT, "Rex", "Sam", laneIds[0]), idempotencyKey: key });
      expect(same.status).toBe(201);
      expect(same.headers.get("idempotent-replayed")).toBe("true");
      const changed = await post(slug, { ...withLane(SLOT, "Rex", "Sam", laneIds[1]), idempotencyKey: key });
      expect(changed.status).toBe(422);
      expect(((await changed.json()) as { booking: { lane: unknown } }).booking.lane).toEqual({ id: laneIds[0], name: "Ring 1" });
    });

    it("books on the fresh event (the guard refused the first insert) when the layout was edited between reading the event and the insert", async () => {
      const { id, slug } = await insertEvent(t.env.DB, { capacity: 2 });
      let first = true;
      const env = {
        DB: interceptBatches(t.env.DB, async (sqls, run) => {
          if (insertsBooking(sqls) && first) {
            first = false;
            await t.env.DB.prepare("UPDATE event_layout SET capacity = 1, config_rev = config_rev + 1 WHERE event_id = ?").bind(id).run();
          }
          return run();
        }),
      };
      const res = await post(slug, withLane(SLOT, "Rex", "Sam"), { env });
      expect(res.status).toBe(201); // the retry against the fresh event books it
      expect((await rows(id))).toHaveLength(1);
    });
  });

  describe("configured booking forms", () => {
    const RIDER_PONY: Parameters<typeof insertEvent>[1] = {
      fields: [
        { label: "Rider", identity: true }, { label: "Pony", identity: true },
        { label: "Phone", required: false, maxLength: 12 },
      ],
    };
    const S2 = "2026-06-13T08:15:00Z";
    const body = (over: Record<string, unknown>) => ({ slot: SLOT, idempotencyKey: newKey(), ...over });
    const errors = async (res: Response) => ((await res.json()) as ErrorBody).fields;

    it("takes field1 to field3, answers with each non-empty value under its label in the form's order, and stores them in value_1 to value_3", async () => {
      const { id, slug, laneId } = await insertEvent(t.env.DB, RIDER_PONY);
      const res = await post(slug, body({ field1: " Ann Lee ", field2: "Biscuit", field3: "07700 900123" }));
      expect(res.status).toBe(201);
      expect(((await res.json()) as { booking: unknown }).booking).toEqual({
        slot: { start: SLOT, end: S2 }, lane: { id: laneId, name: "" },
        fields: [{ label: "Rider", value: "Ann Lee" }, { label: "Pony", value: "Biscuit" }, { label: "Phone", value: "07700 900123" }],
      });
      expect((await rows(id))[0]).toMatchObject({
        value_1: "Ann Lee", value_2: "Biscuit", value_3: "07700 900123", value_4: "", identity_key: identityKeyOf(["Ann Lee", "Biscuit"]),
      });
    });

    it("leaves an optional field left blank out of the answer, and stores it as empty", async () => {
      const { id, slug } = await insertEvent(t.env.DB, RIDER_PONY);
      for (const [i, blank] of [{}, { field3: "" }, { field3: "   " }, { field3: null }].entries()) {
        const slot = `2026-06-13T08:${String(i * 15).padStart(2, "0")}:00Z`;
        const res = await post(slug, body({ slot, field1: `Ann${i}`, field2: "Biscuit", ...blank }));
        expect(res.status, JSON.stringify(blank)).toBe(201);
        expect(((await res.json()) as { booking: { fields: { label: string }[] } }).booking.fields.map((f) => f.label), JSON.stringify(blank)).toEqual(["Rider", "Pony"]);
      }
      expect((await rows(id)).every((r) => r.value_3 === "")).toBe(true);
    });

    it("keys each error by the field's number, with the field's own label and longest value, and does not ask a one-field event for a second", async () => {
      const { slug } = await insertEvent(t.env.DB, RIDER_PONY);
      expect(await errors(await post(slug, body({ field1: "", field2: "\u200B", field3: "x".repeat(13) })))).toEqual({
        field1: "Rider is required.", field2: expect.stringContaining("Pony can't contain invisible"), field3: "Phone must be at most 12 characters.",
      });
      const one = await insertEvent(t.env.DB, { fields: [{ label: "Car reg", identity: true }] });
      expect(await errors(await post(one.slug, body({})))).toEqual({ field1: "Car reg is required." });
      expect((await post(one.slug, body({ field1: "AB12 CDE" }))).status).toBe(201); // no second field is asked for
    });

    it("identifies a booking by the identity fields only: another Phone is the same booking, another Pony is not", async () => {
      const { id, slug } = await insertEvent(t.env.DB, RIDER_PONY);
      expect((await post(slug, body({ field1: "Ann", field2: "Biscuit", field3: "111" }))).status).toBe(201);
      const same = await post(slug, body({ slot: S2, field1: " ANN", field2: "biscuit ", field3: "222" }));
      expect(same.status).toBe(409);
      expect(((await same.json()) as ErrorBody).error).toEqual({ code: "duplicate_booking", message: "That rider and pony already have a booking for this event." });
      expect((await post(slug, body({ slot: S2, field1: "Ann", field2: "Nutmeg" }))).status).toBe(201);
      expect(await rows(id)).toHaveLength(2);
    });

    it("identifies a booking by one field alone", async () => {
      const { slug } = await insertEvent(t.env.DB, { fields: [{ label: "Car reg", identity: true }, { label: "Driver", required: false }] });
      expect((await post(slug, body({ field1: "AB12 CDE", field2: "Ann" }))).status).toBe(201);
      const again = await post(slug, body({ slot: S2, field1: "ab12  cde", field2: "Sam" }));
      expect(again.status).toBe(409);
      expect(((await again.json()) as ErrorBody).error.message).toBe("That car reg already has a booking for this event.");
    });

    it("lets an identity that is made of two fields book up to the limit, and not a booking more, with the numbers 1 to the limit", async () => {
      const { id, slug } = await insertEvent(t.env.DB, { ...RIDER_PONY, identityLimit: 2 });
      const slots = ["2026-06-13T08:00:00Z", "2026-06-13T08:15:00Z", "2026-06-13T08:30:00Z"];
      expect((await Promise.all(slots.map((slot) => post(slug, body({ slot, field1: "Ann", field2: "Biscuit" }))))).map((r) => r.status).sort()).toEqual([201, 201, 409]);
      expect((await rows(id)).map((r) => r.identity_seq).sort()).toEqual([1, 2]);
    });

    it("replays a retry, and answers a retry that changed an optional field as the booking as it was saved", async () => {
      const { slug } = await insertEvent(t.env.DB, RIDER_PONY);
      const key = newKey();
      const first = await post(slug, { ...body({ field1: "Ann", field2: "Biscuit", field3: "111" }), idempotencyKey: key });
      expect(first.status).toBe(201);
      const replay = await post(slug, { ...body({ field1: "ann", field2: "BISCUIT", field3: "111" }), idempotencyKey: key });
      expect(replay.status).toBe(201);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      const changed = await post(slug, { ...body({ field1: "Ann", field2: "Biscuit", field3: "222" }), idempotencyKey: key });
      expect(changed.status).toBe(422);
      expect(((await changed.json()) as { booking: { fields: unknown[] } }).booking.fields).toEqual([
        { label: "Rider", value: "Ann" }, { label: "Pony", value: "Biscuit" }, { label: "Phone", value: "111" },
      ]);
    });

    it("books a four-field form, and shows every value in the answer", async () => {
      const { slug } = await insertEvent(t.env.DB, { fields: [{ label: "A", identity: true }, { label: "B" }, { label: "C", required: false }, { label: "D", required: false, maxLength: 1 }] });
      const res = await post(slug, body({ field1: "a", field2: "b", field3: "c", field4: "d" }));
      expect(res.status).toBe(201);
      expect(((await res.json()) as { booking: { fields: unknown[] } }).booking.fields).toEqual([
        { label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }, { label: "D", value: "d" },
      ]);
      expect(await errors(await post(slug, body({ slot: S2, field1: "x", field2: "y", field4: "dd" })))).toEqual({ field4: "D must be at most 1 characters." });
    });

    it("books against the fields as the event has them now: a form edited after the page loaded is validated by the new one", async () => {
      const { id, slug } = await insertEvent(t.env.DB, RIDER_PONY);
      await t.env.DB.prepare("UPDATE event_fields SET required = 0, in_identity = 0 WHERE event_id = ? AND position = 2").bind(id).run();
      expect((await post(slug, body({ field1: "Ann" }))).status).toBe(201); // Pony is optional now
    });
  });
});

import { describe, expect, it } from "vitest";
import { onRequestPost } from "./preview";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };

interface PostOptions { contentType?: string | null; raw?: string; data?: unknown; stream?: ReadableStream<Uint8Array> }

/** No database binding at all: preview must not need one. */
const post = (body: unknown, o: PostOptions = {}): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  return Promise.resolve(
    onRequestPost({
      request: new Request("http://localhost/api/admin/events/preview", {
        method: "POST", headers, body: o.stream ?? o.raw ?? JSON.stringify(body),
        ...(o.stream ? { duplex: "half" } : {}),
      } as RequestInit),
      env: {},
      data: "data" in o ? o.data : ADMIN,
    } as unknown as Parameters<typeof onRequestPost>[0]),
  );
};

const draft = (over: Record<string, unknown> = {}) => ({
  name: "Trial day", date: "2026-10-24", start: "09:00", end: "17:00", sessionMinutes: 15, gapMinutes: 0,
  costPence: 1500, venuePostcode: "AB1 2CD", details: "", breaks: [{ start: "12:05", end: "13:00" }], ...over,
});

describe("POST /api/admin/events/preview", () => {
  it("returns the slots and suggestions, no-store", async () => {
    const res = await post(draft());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { slots: { start: string; end: string }[]; suggestions: unknown[] };
    expect(body.slots[0]).toEqual({ start: "2026-10-24T08:00:00Z", end: "2026-10-24T08:15:00Z" });
    expect(body.slots.map((s) => s.start)).not.toContain("2026-10-24T11:00:00Z");
    expect(body.suggestions).toEqual([{
      breakIndex: 0,
      droppedSlot: { start: "2026-10-24T11:00:00Z", end: "2026-10-24T11:15:00Z" },
      overrunMinutes: 10,
      suggestedBreak: { start: "2026-10-24T11:15:00Z", end: "2026-10-24T12:10:00Z" },
      suggestedLocal: { start: "12:15", end: "13:10" },
      breakLabel: "",
    }]);
  });

  it("returns the break's label with its suggestion", async () => {
    const res = await post(draft({ breaks: [{ start: "12:05", end: "13:00", label: " Lunch " }] }));
    expect(((await res.json()) as { suggestions: { breakLabel: string }[] }).suggestions[0].breakLabel).toBe("Lunch");
  });

  it("previews a date in the past (it is not an event yet)", async () => {
    expect((await post(draft({ date: "2020-01-04" }))).status).toBe(200);
  });

  it("returns 400 invalid_input with fields, in the booking API's shape", async () => {
    const res = await post(draft({ name: "", breaks: [{ start: "9", end: "10:00" }] }));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: { code: "invalid_input", message: "Check the highlighted fields." },
      fields: { name: "Enter the event name.", "breaks.0.start": "Enter a time as HH:MM." },
    });
  });

  it("refuses with 401 unless the guard set an admin identity", async () => {
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await post(draft(), { data });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthenticated");
    }
  });

  it("returns 415 for a non-JSON content type, 400 for bad JSON and for a non-object", async () => {
    expect((await post(draft(), { contentType: "text/plain" })).status).toBe(415);
    expect((await post(draft(), { contentType: null })).status).toBe(415);
    expect((await post(undefined, { raw: "{nope" })).status).toBe(400);
    expect((await post(undefined, { raw: "[1]" })).status).toBe(400);
  });

  it("allows a body up to 32 KB and returns 413 above it", async () => {
    const pad = (bytes: number) => JSON.stringify({ ...draft(), padding: "x".repeat(bytes - JSON.stringify({ ...draft(), padding: "" }).length) });
    expect(new TextEncoder().encode(pad(32768)).length).toBe(32768);
    expect((await post(undefined, { raw: pad(32768) })).status).toBe(200);
    const res = await post(undefined, { raw: pad(32769) });
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("gives placeCount: slots times lanes times capacity, one lane and one place where the draft says nothing", async () => {
    const count = async (over: Record<string, unknown>) => ((await (await post(draft({ breaks: [], end: "10:00", ...over }))).json()) as { placeCount: number }).placeCount;
    expect(await count({})).toBe(4);
    expect(await count({ capacity: 3 })).toBe(12);
    expect(await count({ lanes: [{ name: "A" }, { name: "B" }], capacity: 3 })).toBe(24);
  });

  it("validates lanes and capacity like a create, and refuses a lane id", async () => {
    const res = await post(draft({ lanes: [{ id: 3, name: "A" }, { name: "a" }], capacity: 0 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: Record<string, string> }).fields).toEqual({
      capacity: "Enter a whole number of places from 1 to 50.", "lanes.0.id": "A new event's lanes don't have an id.", "lanes.1.name": "Two lanes can't have the same name.",
    });
  });
});

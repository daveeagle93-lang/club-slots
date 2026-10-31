import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSlug } from "../../../../core/slug";
import type { AppEnv } from "../../../../server/env";
import { countRows, createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../../../../test/db";
import { onRequestPost } from "./clear-past";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };
const NOW = "2026-10-01T12:00:00Z";

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(async () => {
  vi.setSystemTime(new Date(NOW));
  await t.env.DB.prepare("DELETE FROM events").run();
});
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

interface Options { contentType?: string | null; raw?: string; data?: unknown[] }

const clear = (body: unknown, o: Options = {}): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  return Promise.resolve(
    onRequestPost({
      request: new Request("http://localhost/api/admin/events/clear-past", { method: "POST", headers, body: o.raw ?? JSON.stringify(body) }),
      env: t.env as AppEnv, data: o.data ? o.data[0] : ADMIN,
    } as unknown as Parameters<typeof onRequestPost>[0]),
  );
};

interface Cleared { deletedEvents: number; deletedBookings: number; skipped: { slug: string; reason: string }[] }
const PAST = { startUtc: "2026-09-01T08:00:00Z", endUtc: "2026-09-01T11:00:00Z" };
const UPCOMING = { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z" };

/** An event with one break and `bookings` bookings. */
async function seed(over: Parameters<typeof insertEvent>[1], bookings = 2) {
  const e = await insertEvent(t.env.DB, over);
  await insertBreak(t.env.DB, e.id, over!.startUtc!.replace("T08:", "T09:"), over!.startUtc!.replace("T08:00", "T09:30"));
  for (let i = 0; i < bookings; i++) {
    await insertBooking(t.env.DB, e.id, `${over!.startUtc!.slice(0, 11)}08:${String(i * 15).padStart(2, "0")}:00Z`, `Dog${i}`, "Sam");
  }
  return e;
}
const rows = async () => [await countRows(t.env.DB, "events"), await countRows(t.env.DB, "breaks"), await countRows(t.env.DB, "bookings")];
const exists = async (slug: string) => (await t.env.DB.prepare("SELECT 1 AS n FROM events WHERE slug = ?").bind(slug).first()) !== null;
const orphans = async (): Promise<number> => (await t.env.DB.prepare(
  `SELECT (SELECT COUNT(*) FROM bookings WHERE event_id NOT IN (SELECT id FROM events))
        + (SELECT COUNT(*) FROM breaks WHERE event_id NOT IN (SELECT id FROM events)) AS n`,
).first<{ n: number }>())!.n;

describe("POST /api/admin/events/clear-past: the request", () => {
  it("needs the literal string DELETE as confirm, deleting nothing", async () => {
    const e = await seed(PAST);
    for (const confirm of [undefined, "delete", "Delete", "DELETE ", " DELETE", "", true, 1, null, ["DELETE"]]) {
      const res = await clear({ slugs: [e.slug], confirm });
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("confirmation_required");
    }
    expect(await rows()).toEqual([1, 1, 2]);
  });

  it("needs 1 to 100 distinct valid slugs, deleting nothing", async () => {
    const e = await seed(PAST);
    const many = (n: number) => Array.from({ length: n }, (_, i) => `slug-number-${String(i).padStart(4, "0")}`);
    const bad: unknown[] = [undefined, null, "x", {}, [], many(101), [e.slug, e.slug], [e.slug, "nope"], [e.slug, 5], [e.slug, null], ["../etc/passwd-padding"], [""]];
    for (const slugs of bad) {
      const res = await clear({ slugs, confirm: "DELETE" });
      expect(res.status, JSON.stringify(slugs)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_input");
    }
    expect(await rows()).toEqual([1, 1, 2]);
    expect((await clear({ slugs: many(100), confirm: "DELETE" })).status).toBe(200); // 100 is allowed (all unknown: skipped)
  });

  it("returns 415, 400 and 413 for bad bodies, deleting nothing", async () => {
    await seed(PAST);
    expect((await clear({}, { contentType: "text/plain" })).status).toBe(415);
    expect((await clear(undefined, { raw: "{nope" })).status).toBe(400);
    expect((await clear(undefined, { raw: "[1]" })).status).toBe(400);
    expect((await clear({ slugs: [], confirm: "DELETE", padding: "x".repeat(40_000) })).status).toBe(413);
    expect(await rows()).toEqual([1, 1, 2]);
  });

  it("refuses with 401 unless the guard set an admin identity, deleting nothing", async () => {
    const e = await seed(PAST);
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await clear({ slugs: [e.slug], confirm: "DELETE" }, { data: [data] });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await rows()).toEqual([1, 1, 2]);
  });
});

describe("POST /api/admin/events/clear-past: what is deleted", () => {
  it("deletes past events with their breaks and bookings, reports the counts, and leaves other events alone", async () => {
    const a = await seed(PAST, 2);
    const b = await seed({ startUtc: "2026-08-01T08:00:00Z", endUtc: "2026-08-01T11:00:00Z" }, 3);
    const keep = await seed(UPCOMING, 1);
    const res = await clear({ slugs: [a.slug, b.slug], confirm: "DELETE" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ deletedEvents: 2, deletedBookings: 5, skipped: [] });
    expect(await rows()).toEqual([1, 1, 1]);
    expect(await exists(keep.slug)).toBe(true);
    expect(await orphans()).toBe(0);
  });

  it("deletes only the past events of a mixed request, reporting the others as skipped in request order", async () => {
    const past = await seed(PAST, 1);
    const upcoming = await seed(UPCOMING, 2);
    const unknown = generateSlug();
    const res = await clear({ slugs: [upcoming.slug, past.slug, unknown], confirm: "DELETE" });
    expect(await res.json()).toEqual({
      deletedEvents: 1, deletedBookings: 1,
      skipped: [{ slug: upcoming.slug, reason: "not_past" }, { slug: unknown, reason: "not_found" }],
    });
    expect(await exists(past.slug)).toBe(false);
    expect(await exists(upcoming.slug)).toBe(true);
    expect(await rows()).toEqual([1, 1, 2]); // the upcoming event keeps its break and both bookings
  });

  it("draws the line at end_utc <= now: ending exactly now is past, one second later is not", async () => {
    const exactly = await seed({ startUtc: "2026-10-01T08:00:00Z", endUtc: "2026-10-01T12:00:00Z" }, 1);
    const after = await seed({ startUtc: "2026-10-01T08:00:00Z", endUtc: "2026-10-01T12:00:01Z" }, 1);
    const res = await clear({ slugs: [exactly.slug, after.slug], confirm: "DELETE" });
    expect(await res.json()).toEqual({ deletedEvents: 1, deletedBookings: 1, skipped: [{ slug: after.slug, reason: "not_past" }] });
  });

  it("deletes an archived past event, but not an archived upcoming one", async () => {
    const old = await seed({ ...PAST, archived: true }, 1);
    const future = await seed({ ...UPCOMING, archived: true }, 1);
    const res = await clear({ slugs: [old.slug, future.slug], confirm: "DELETE" });
    expect(await res.json()).toEqual({ deletedEvents: 1, deletedBookings: 1, skipped: [{ slug: future.slug, reason: "not_past" }] });
    expect(await exists(future.slug)).toBe(true);
  });

  it("deletes nothing and says so when every slug is skipped", async () => {
    const upcoming = await seed(UPCOMING, 1);
    const res = await clear({ slugs: [upcoming.slug], confirm: "DELETE" });
    expect(await res.json()).toEqual({ deletedEvents: 0, deletedBookings: 0, skipped: [{ slug: upcoming.slug, reason: "not_past" }] });
    expect(await rows()).toEqual([1, 1, 1]);
  });

  it("reports an event already deleted as not_found, so a retry is harmless", async () => {
    const e = await seed(PAST, 1);
    const body = { slugs: [e.slug], confirm: "DELETE" };
    expect(await (await clear(body)).json()).toEqual({ deletedEvents: 1, deletedBookings: 1, skipped: [] });
    expect(await (await clear(body)).json()).toEqual({ deletedEvents: 0, deletedBookings: 0, skipped: [{ slug: e.slug, reason: "not_found" }] });
  });

  it("takes each event's lanes and layout with it, though bookings point at the lanes (several lanes, several places each)", async () => {
    const e = await insertEvent(t.env.DB, { ...PAST, capacity: 2, lanes: ["Ring 1", "Ring 2", "Ring 3"] });
    for (const [i, laneId] of e.laneIds.entries()) {
      await insertBooking(t.env.DB, e.id, PAST.startUtc, `A${i}`, "H", { laneId });
      await insertBooking(t.env.DB, e.id, PAST.startUtc, `B${i}`, "H", { laneId });
    }
    const keep = await insertEvent(t.env.DB, { ...UPCOMING, lanes: ["Ring 1", "Ring 2"] });
    await insertBooking(t.env.DB, keep.id, UPCOMING.startUtc, "K", "H", { laneId: keep.laneIds[1] });
    const res = await clear({ slugs: [e.slug, keep.slug], confirm: "DELETE" });
    expect(await res.json()).toEqual({ deletedEvents: 1, deletedBookings: 6, skipped: [{ slug: keep.slug, reason: "not_past" }] });
    expect(await countRows(t.env.DB, "event_lanes")).toBe(2);
    expect(await countRows(t.env.DB, "event_layout")).toBe(1);
    expect(await countRows(t.env.DB, "bookings")).toBe(1);
    expect((await t.env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("deletes 100 past events with their rows in one request", async () => {
    const statement = t.env.DB.prepare(
      "INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode) VALUES (?, 'E', ?, ?, 15, 'AB1 2CD')",
    );
    const slugs = Array.from({ length: 100 }, (_, i) => `bulk-test-slug-${String(i).padStart(3, "0")}`);
    await t.env.DB.batch(slugs.map((s, i) => {
      const iso = (h: number) => new Date(Date.UTC(2025, 0, 1 + i, h)).toISOString().replace(".000Z", "Z");
      return statement.bind(s, iso(8), iso(9));
    }));
    const res = await clear({ slugs, confirm: "DELETE" });
    expect(await res.json()).toEqual({ deletedEvents: 100, deletedBookings: 0, skipped: [] });
    expect(await countRows(t.env.DB, "events")).toBe(0);
  });
});

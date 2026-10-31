import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../../server/env";
import { createTestEnv, insertEvent, type TestEnv } from "../../../test/db";
import { onRequestGet } from "./index";

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

interface Listed { slug: string; name: string; startUtc: string; endUtc: string }

const list = async (): Promise<{ res: Response; events: Listed[] }> => {
  const res = await Promise.resolve(
    onRequestGet({
      request: new Request("http://localhost/api/events"), env: t.env as AppEnv,
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );
  return { res, events: ((await res.json()) as { events: Listed[] }).events };
};
const at = (day: number, hour = 8) => ({
  startUtc: `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`,
  endUtc: `2026-10-${String(day).padStart(2, "0")}T${String(hour + 3).padStart(2, "0")}:00:00Z`,
});

describe("GET /api/events", () => {
  it("lists upcoming events soonest first with exactly slug, name, startUtc and endUtc", async () => {
    const later = await insertEvent(t.env.DB, { name: "Later", ...at(20), details: "secret", venuePostcode: "ZZ9 9ZZ" });
    const sooner = await insertEvent(t.env.DB, { name: "Sooner", ...at(10) });
    const { res, events } = await list();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(events).toEqual([
      { slug: sooner.slug, name: "Sooner", ...at(10) },
      { slug: later.slug, name: "Later", ...at(20) },
    ]);
    for (const e of events) expect(Object.keys(e).sort()).toEqual(["endUtc", "name", "slug", "startUtc"]);
  });

  it("leaves out archived, past, starting-exactly-now and slug-less events", async () => {
    const shown = await insertEvent(t.env.DB, { name: "Shown", ...at(10) });
    await insertEvent(t.env.DB, { name: "Archived", ...at(11), archived: true });
    await insertEvent(t.env.DB, { name: "Past", ...at(1) });
    await insertEvent(t.env.DB, { name: "Now", startUtc: NOW, endUtc: "2026-10-01T15:00:00Z" });
    await insertEvent(t.env.DB, { name: "One second later", startUtc: "2026-10-01T12:00:01Z", endUtc: "2026-10-01T15:00:00Z" });
    const noSlug = await insertEvent(t.env.DB, { name: "No slug", ...at(12) });
    await t.env.DB.prepare("UPDATE events SET slug = NULL WHERE id = ?").bind(noSlug.id).run();
    const { events } = await list();
    expect(events.map((e) => e.name)).toEqual(["One second later", "Shown"]);
    expect(events[1].slug).toBe(shown.slug);
  });

  it("leaves out unlisted events and keeps the listed ones", async () => {
    const shown = await insertEvent(t.env.DB, { name: "Shown", ...at(12) });
    await insertEvent(t.env.DB, { name: "Hidden", ...at(10), listed: false });
    const { events } = await list();
    expect(events).toEqual([{ slug: shown.slug, name: "Shown", ...at(12) }]);
  });

  it("returns an empty list when every upcoming event is unlisted", async () => {
    await insertEvent(t.env.DB, { name: "Hidden", ...at(10), listed: false });
    await insertEvent(t.env.DB, { name: "Also hidden", ...at(11), listed: false });
    const { res, events } = await list();
    expect(res.status).toBe(200);
    expect(events).toEqual([]);
  });

  it("returns an empty list when nothing is upcoming", async () => {
    expect((await list()).events).toEqual([]);
  });

  it("returns at most 50 events, the soonest", async () => {
    const statement = t.env.DB.prepare(
      "INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode) VALUES (?, ?, ?, ?, 15, 'AB1 2CD')",
    );
    await t.env.DB.batch(Array.from({ length: 55 }, (_, i) => {
      const iso = (h: number) => new Date(Date.UTC(2026, 10, 1 + i, h)).toISOString().replace(".000Z", "Z");
      return statement.bind(`limit-test-slug-${String(i).padStart(3, "0")}`, `E${i}`, iso(8), iso(9));
    }));
    const { events } = await list();
    expect(events).toHaveLength(50);
    expect(events[0].name).toBe("E0");
    expect(events[49].name).toBe("E49");
  });
});

describe("GET /api/events when the database fails", () => {
  it("answers a clean JSON 500, logs only the message, and is never cached", async () => {
    const broken = { DB: { prepare: () => { throw new Error("D1 is down: SELECT secret FROM x"); } } };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await Promise.resolve(
        onRequestGet({ request: new Request("http://localhost/api/events"), env: broken } as unknown as Parameters<typeof onRequestGet>[0]),
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: "internal_error", message: "Something went wrong. Please try again." } });
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0].every((a) => typeof a === "string")).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

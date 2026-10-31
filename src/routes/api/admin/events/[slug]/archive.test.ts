import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSlug } from "../../../../../core/slug";
import type { AppEnv } from "../../../../../server/env";
import { countRows, createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../../../../../test/db";
import { onRequestPost as book } from "../../../events/[slug]/bookings";
import { onRequestGet as publicGet } from "../../../events/[slug]/index";
import { onRequestPost } from "./archive";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(async () => {
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  await t.env.DB.prepare("DELETE FROM events").run();
});
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

interface Options { contentType?: string | null; raw?: string; data?: unknown[] }

const archive = (slug: string, body: unknown, o: Options = {}): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  return Promise.resolve(
    onRequestPost({
      request: new Request(`http://localhost/api/admin/events/${slug}/archive`, { method: "POST", headers, body: o.raw ?? JSON.stringify(body) }),
      env: t.env as AppEnv, params: { slug }, data: o.data ? o.data[0] : ADMIN,
    } as unknown as Parameters<typeof onRequestPost>[0]),
  );
};

const flag = async (id: number) => (await t.env.DB.prepare("SELECT archived FROM events WHERE id = ?").bind(id).first<{ archived: number }>())!.archived;

const publicBook = (slug: string, slot: string) => book({
  request: new Request(`http://localhost/api/events/${slug}/bookings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slot, field1: "Rex", field2: "Sam Smith", idempotencyKey: generateSlug() }),
  }),
  env: t.env, params: { slug },
} as unknown as Parameters<typeof book>[0]);

const FUTURE = { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z" };

describe("POST /api/admin/events/[slug]/archive", () => {
  it("archives and unarchives, answering the new state, no-store", async () => {
    const { id, slug } = await insertEvent(t.env.DB, FUTURE);
    const on = await archive(slug, { archived: true });
    expect(on.status).toBe(200);
    expect(on.headers.get("cache-control")).toBe("no-store");
    expect(await on.json()).toEqual({ archived: true });
    expect(await flag(id)).toBe(1);
    const off = await archive(slug, { archived: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ archived: false });
    expect(await flag(id)).toBe(0);
  });

  it("is idempotent in both directions", async () => {
    const { id, slug } = await insertEvent(t.env.DB, FUTURE);
    for (let i = 0; i < 2; i++) {
      expect(((await (await archive(slug, { archived: true })).json()) as { archived: boolean }).archived).toBe(true);
      expect(await flag(id)).toBe(1);
    }
    for (let i = 0; i < 2; i++) {
      expect(((await (await archive(slug, { archived: false })).json()) as { archived: boolean }).archived).toBe(false);
      expect(await flag(id)).toBe(0);
    }
  });

  it("refuses anything but a boolean with 400, changing nothing", async () => {
    const { id, slug } = await insertEvent(t.env.DB, FUTURE);
    for (const archived of [undefined, null, 1, 0, "true", "false", [], {}, [true]]) {
      const res = await archive(slug, { archived });
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_input");
    }
    expect(await flag(id)).toBe(0);
    await archive(slug, { archived: true });
    expect((await archive(slug, { archived: 0 })).status).toBe(400);
    expect(await flag(id)).toBe(1);
  });

  it("returns 415, 400 for bad bodies", async () => {
    const { slug } = await insertEvent(t.env.DB, FUTURE);
    expect((await archive(slug, { archived: true }, { contentType: "text/plain" })).status).toBe(415);
    expect((await archive(slug, undefined, { raw: "{nope" })).status).toBe(400);
    expect((await archive(slug, undefined, { raw: "[true]" })).status).toBe(400);
  });

  it("returns 404 for an unknown or malformed slug, creating nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    for (const slug of [generateSlug(), "nope"]) {
      const res = await archive(slug, { archived: true });
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("only touches the one event", async () => {
    const a = await insertEvent(t.env.DB, FUTURE);
    const b = await insertEvent(t.env.DB, FUTURE);
    await archive(a.slug, { archived: true });
    expect([await flag(a.id), await flag(b.id)]).toEqual([1, 0]);
  });

  it("keeps the event's breaks and bookings", async () => {
    const { id, slug } = await insertEvent(t.env.DB, FUTURE);
    await insertBreak(t.env.DB, id, "2026-10-24T08:30:00Z", "2026-10-24T08:45:00Z", "Tea");
    await insertBooking(t.env.DB, id, "2026-10-24T08:00:00Z", "Rex", "Sam");
    await archive(slug, { archived: true });
    expect([await countRows(t.env.DB, "events"), await countRows(t.env.DB, "breaks"), await countRows(t.env.DB, "bookings")]).toEqual([1, 1, 1]);
    await archive(slug, { archived: false });
    expect([await countRows(t.env.DB, "breaks"), await countRows(t.env.DB, "bookings")]).toEqual([1, 1]);
  });

  it("closes the public page's bookings with 410 event_archived, and Unarchive reopens them", async () => {
    const { slug } = await insertEvent(t.env.DB, FUTURE);
    await archive(slug, { archived: true });
    const closed = await publicBook(slug, "2026-10-24T08:00:00Z");
    expect(closed.status).toBe(410);
    expect(((await closed.json()) as { error: { code: string } }).error.code).toBe("event_archived");
    const page = await publicGet({ request: new Request(`http://localhost/api/events/${slug}`), env: { DB: t.env.DB }, params: { slug } } as never);
    expect(((await page.json()) as { event: { archived: boolean }; slots: unknown[] })).toMatchObject({ event: { archived: true }, slots: [] });

    await archive(slug, { archived: false });
    expect((await publicBook(slug, "2026-10-24T08:00:00Z")).status).toBe(201);
  });

  it("refuses with 401 unless the guard set an admin identity, changing nothing", async () => {
    const { id, slug } = await insertEvent(t.env.DB, FUTURE);
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await archive(slug, { archived: true }, { data: [data] });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await flag(id)).toBe(0);
  });
});

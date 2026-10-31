import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSlug } from "../core/slug";
import { onRequestGet as adminDetail } from "../routes/api/admin/events/[slug]/index";
import { onRequestGet as adminList } from "../routes/api/admin/events/index";
import { onRequestPost as book } from "../routes/api/events/[slug]/bookings";
import { onRequestGet as publicGet } from "../routes/api/events/[slug]/index";
import { countRows, createTestEnv, type TestEnv } from "../test/db";
import { ensureEventLayout, loadEventBySlug } from "./events";
import { loadTemplates } from "./admin-templates";

// An event made by the previous version of the app, in the moments between `migrations apply` and `wrangler deploy`: the old
// code inserts the event and its breaks and knows nothing of lanes, a layout or booking form fields. The new code must take it
// as an ordinary one-lane event rather than show every slot taken.

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(() => { vi.setSystemTime(new Date("2026-06-01T00:00:00Z")); });
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };
const SLOT = "2026-06-13T08:00:00Z";

/** The old app's INSERT: the events row only, no lane, no layout, no field rows. */
async function legacyEvent(): Promise<{ id: number; slug: string }> {
  const slug = generateSlug();
  const row = await t.env.DB.prepare(
    `INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, gap_minutes, cost_pence, venue_postcode, details)
     VALUES (?, 'Old app event', '2026-06-13T08:00:00Z', '2026-06-13T11:00:00Z', 15, 0, 1250, 'AB1 2CD', '') RETURNING id`,
  ).bind(slug).first<{ id: number }>();
  return { id: row!.id, slug };
}
const counts = async (eventId: number) => ({
  lanes: (await t.env.DB.prepare("SELECT COUNT(*) AS n FROM event_lanes WHERE event_id = ?").bind(eventId).first<{ n: number }>())!.n,
  layouts: (await t.env.DB.prepare("SELECT COUNT(*) AS n FROM event_layout WHERE event_id = ?").bind(eventId).first<{ n: number }>())!.n,
});

describe("an event with no lane or layout rows (made by the old app between the migration and the deploy)", () => {
  it("loads as one unnamed lane, capacity 1, limit 1, revision 0, and the lane and layout rows now exist", async () => {
    const { id, slug } = await legacyEvent();
    expect(await counts(id)).toEqual({ lanes: 0, layouts: 0 });
    const event = (await loadEventBySlug(t.env.DB, slug))!;
    expect(event).toMatchObject({ lanes: [{ position: 1, name: "" }], capacity: 1, identityLimit: 1, configRev: 0 });
    expect(event.fields.map((f) => f.label)).toEqual(["Dog", "Handler"]);
    expect(await counts(id)).toEqual({ lanes: 1, layouts: 1 });
  });

  it("is repaired once: loading again, or repairing again, adds no second lane and keeps the same lane id", async () => {
    const { id, slug } = await legacyEvent();
    const first = (await loadEventBySlug(t.env.DB, slug))!;
    await ensureEventLayout(t.env.DB, id);
    const second = (await loadEventBySlug(t.env.DB, slug))!;
    expect(second.lanes).toEqual(first.lanes);
    expect(await counts(id)).toEqual({ lanes: 1, layouts: 1 });
  });

  it("is repaired once when several requests load it at the same time", async () => {
    const { id, slug } = await legacyEvent();
    const loaded = await Promise.all(Array.from({ length: 6 }, () => loadEventBySlug(t.env.DB, slug)));
    expect(new Set(loaded.map((e) => e!.lanes[0].id)).size).toBe(1);
    expect(await counts(id)).toEqual({ lanes: 1, layouts: 1 });
  });

  it("keeps a layout row that exists (capacity, limit and revision) and only adds the missing lane", async () => {
    const { id, slug } = await legacyEvent();
    await t.env.DB.prepare("INSERT INTO event_layout (event_id, capacity, identity_limit, config_rev) VALUES (?, 3, 2, 7)").bind(id).run();
    expect(await loadEventBySlug(t.env.DB, slug)).toMatchObject({ lanes: [{ name: "" }], capacity: 3, identityLimit: 2, configRev: 7 });
    expect(await counts(id)).toEqual({ lanes: 1, layouts: 1 });
  });

  it("does nothing, and does not fail, for an event that does not exist", async () => {
    const lanes = await countRows(t.env.DB, "event_lanes");
    const layouts = await countRows(t.env.DB, "event_layout");
    await ensureEventLayout(t.env.DB, 999_999);
    expect([await countRows(t.env.DB, "event_lanes"), await countRows(t.env.DB, "event_layout")]).toEqual([lanes, layouts]);
  });

  it("shows its slots as free on the public page, not every slot taken", async () => {
    const { slug } = await legacyEvent();
    const res = await publicGet({ request: new Request(`http://localhost/api/events/${slug}`), env: { DB: t.env.DB }, params: { slug } } as unknown as Parameters<typeof publicGet>[0]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { lanes: { id: number }[] }; slots: { status: string; places: { laneId: number; free: number }[] }[] };
    expect(body.slots).toHaveLength(12);
    expect(new Set(body.slots.map((s) => s.status))).toEqual(new Set(["free"]));
    expect(body.slots[0].places).toEqual([{ laneId: body.event.lanes[0].id, free: 1 }]);
  });

  it("takes a public booking, in its one lane", async () => {
    const { id, slug } = await legacyEvent();
    const res = await book({
      request: new Request(`http://localhost/api/events/${slug}/bookings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot: SLOT, field1: "Rex", field2: "Sam Jones", idempotencyKey: generateSlug() }),
      }),
      env: { DB: t.env.DB }, params: { slug },
    } as unknown as Parameters<typeof book>[0]);
    expect(res.status).toBe(201);
    const lane = await t.env.DB.prepare("SELECT id FROM event_lanes WHERE event_id = ?").bind(id).first<{ id: number }>();
    expect(await t.env.DB.prepare("SELECT lane_id, place, value_1, value_2 FROM bookings WHERE event_id = ?").bind(id).all()).toMatchObject({
      results: [{ lane_id: lane!.id, place: 1, value_1: "Rex", value_2: "Sam Jones" }],
    });
  });

  it("shows in the admin detail as a normal event with free places", async () => {
    const { slug } = await legacyEvent();
    const res = await adminDetail({ request: new Request(`http://localhost/api/admin/events/${slug}`), env: { DB: t.env.DB }, params: { slug }, data: ADMIN } as unknown as Parameters<typeof adminDetail>[0]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { lanes: unknown[]; capacity: number }; slots: { places: { free: number }[] }[] };
    expect(body.event).toMatchObject({ lanes: [{ name: "" }], capacity: 1 });
    expect(body.slots).toHaveLength(12);
    expect(body.slots.every((s) => s.places.length === 1 && s.places[0].free === 1)).toBe(true);
  });

  it("shows in the admin list with its places, not as full, and the list repairs it", async () => {
    const { id, slug } = await legacyEvent();
    expect(await counts(id)).toEqual({ lanes: 0, layouts: 0 });
    const res = await adminList({ request: new Request("http://localhost/api/admin/events"), env: { DB: t.env.DB }, data: ADMIN } as unknown as Parameters<typeof adminList>[0]);
    expect(res.status).toBe(200);
    const listed = ((await res.json()) as { events: { slug: string; full: boolean; laneCount: number; capacity: number; placeCount: number; slotCount: number; bookedCount: number }[] }).events.find((e) => e.slug === slug)!;
    expect(listed).toMatchObject({ full: false, laneCount: 1, capacity: 1, placeCount: 12, slotCount: 12, bookedCount: 0 });
    expect(await counts(id)).toEqual({ lanes: 1, layouts: 1 });
  });
});

describe("a template with no lane or layout rows", () => {
  it("reads as one unnamed lane, capacity 1, and the Dog and Handler form", async () => {
    const row = await t.env.DB.prepare(
      "INSERT INTO event_templates (name, venue_postcode, start_time, end_time, session_minutes) VALUES ('Bare template', 'AB1 2CD', '09:00', '12:00', 15) RETURNING id",
    ).first<{ id: number }>();
    const [template] = await loadTemplates(t.env.DB, row!.id);
    expect(template).toMatchObject({ lanes: [{ name: "" }], capacity: 1, identityLimit: 1 });
    expect(template.fields.map((f) => f.label)).toEqual(["Dog", "Handler"]);
  });
});

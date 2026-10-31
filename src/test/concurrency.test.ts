/// <reference types="node" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateBookingToken } from "../core/slug";
import { NOW, ORIGIN, passwordEnv, TEST_PASSWORD } from "../server/auth/test-harness";
import { createWorker } from "../worker";
import { createTestEnv, insertBooking, insertEvent, insertsBooking, interceptBatches, type TestEnv } from "./db";

// Requests are sent to the real Worker (guards, router, handlers) all at once with Promise.all against a real local D1.
// The database decides who gets a place; these tests check that it decides correctly however the requests interleave.
// How often the requests really did interleave is counted (a booking insert that lost to another request on a UNIQUE
// constraint, then retried) and printed at the end of each test, because local D1 is one SQLite behind async calls and
// a test like this can pass without any race having happened.

// Each test repeats its race this many times (CONCURRENCY_ROUNDS=20 for a longer run).
const ITERATIONS = Number(process.env.CONCURRENCY_ROUNDS) || 10;
const DAY = { startUtc: "2026-10-17T08:00:00Z", endUtc: "2026-10-17T11:00:00Z", sessionMinutes: 15 }; // 12 slots, 08:00 to 10:45
const slotAt = (i: number) => new Date(Date.parse(DAY.startUtc) + i * 15 * 60_000).toISOString().replace(".000Z", "Z");

let t: TestEnv;
const stats = { inserts: 0, uniqueFailures: 0 };
const worker = createWorker({ now: () => NOW });
let env: Awaited<ReturnType<typeof passwordEnv>>;
let session: { cookie: string; csrf: string };

beforeAll(async () => {
  t = await createTestEnv();
  // Counts booking inserts and the ones that failed on a UNIQUE constraint (the retry path); everything else goes through.
  const counting = interceptBatches(t.env.DB, async (sqls, run) => {
    if (!insertsBooking(sqls) && !sqls.some((s) => /^\s*UPDATE bookings/.test(s))) return run();
    stats.inserts++;
    try {
      return await run();
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) stats.uniqueFailures++;
      throw e;
    }
  });
  env = await passwordEnv(counting);
  const login = await worker.fetch(new Request(`${ORIGIN}/api/admin/login`, {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.50" },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  }), env);
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const csrf = ((await (await worker.fetch(new Request(`${ORIGIN}/api/admin/session`, { headers: { Cookie: cookie } }), env)).json()) as { csrfToken: string }).csrfToken;
  session = { cookie, csrf };
});
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  console.info(`concurrency: ${stats.inserts} booking writes, ${stats.uniqueFailures} lost to another request on a UNIQUE constraint (the retry path ran)`);
  await t.dispose();
});

interface Answer { status: number; code?: string; token?: string; replayed: boolean; body: any }
async function send(path: string, init: { method: string; body?: unknown; admin?: boolean }): Promise<Answer> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.admin) Object.assign(headers, { Cookie: session.cookie, Origin: ORIGIN, "X-CSRF-Token": session.csrf });
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env);
  const body = await res.json().catch(() => null) as any;
  return { status: res.status, code: body?.error?.code, token: body?.icsUrl?.split("/").at(-2), replayed: res.headers.get("idempotent-replayed") === "true", body };
}
const book = (slug: string, slot: string, dog: string, handler: string, o: { laneId?: number; key?: string; extra?: Record<string, string> } = {}) =>
  send(`/api/events/${slug}/bookings`, {
    method: "POST", body: { slot, field1: dog, field2: handler, ...o.extra, idempotencyKey: o.key ?? generateBookingToken(), ...(o.laneId === undefined ? {} : { laneId: o.laneId }) },
  });
const adminAdd = (slug: string, slot: string, dog: string, handler: string, laneId?: number) =>
  send(`/api/admin/events/${slug}/bookings`, { method: "POST", admin: true, body: { slot, field1: dog, field2: handler, ...(laneId === undefined ? {} : { laneId }) } });
const adminMove = (slug: string, id: number, fromSlot: string, toSlot: string, toLane?: number) =>
  send(`/api/admin/events/${slug}/bookings/${id}/move`, { method: "POST", admin: true, body: { fromSlot, toSlot, ...(toLane === undefined ? {} : { toLane }) } });

const tally = (answers: Answer[]) => {
  const out: Record<string, number> = {};
  for (const a of answers) out[a.status === 201 || a.status === 200 ? String(a.status) : `${a.status} ${a.code}`] = (out[a.status === 201 || a.status === 200 ? String(a.status) : `${a.status} ${a.code}`] ?? 0) + 1;
  return out;
};
const rows = async (eventId: number) =>
  (await t.env.DB.prepare("SELECT id, lane_id, slot_start_utc, place, identity_key, identity_seq FROM bookings WHERE event_id = ? ORDER BY slot_start_utc, lane_id, place").bind(eventId).all<{
    id: number; lane_id: number; slot_start_utc: string; place: number; identity_key: string; identity_seq: number;
  }>()).results;

describe("booking places under concurrent requests", () => {
  it(`12 parallel distinct bookings into one capacity-3 slot: exactly 3 created and 9 slot_taken, places 1, 2 and 3 (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, capacity: 3 });
      const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => book(e.slug, slotAt(0), `Dog${i}`, `Handler${i}`)));
      expect(tally(answers), `round ${round}`).toEqual({ "201": 3, "409 slot_taken": 9 });
      expect((await rows(e.id)).map((r) => r.place), `round ${round}`).toEqual([1, 2, 3]);
    }
  }, 120_000);

  it(`3 lanes of 2 places raced across two times: exactly 2 per lane per time, places 1 and 2 (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, capacity: 2, lanes: ["Ring 1", "Ring 2", "Ring 3"] });
      const requests: Promise<Answer>[] = [];
      for (const slot of [slotAt(0), slotAt(1)]) for (const laneId of e.laneIds) for (let i = 0; i < 4; i++) {
        requests.push(book(e.slug, slot, `D${requests.length}`, `H${requests.length}`, { laneId }));
      }
      const answers = await Promise.all(requests);
      expect(tally(answers), `round ${round}`).toEqual({ "201": 12, "409 slot_taken": 12 });
      const stored = await rows(e.id);
      for (const slot of [slotAt(0), slotAt(1)]) for (const laneId of e.laneIds) {
        expect(stored.filter((r) => r.slot_start_utc === slot && r.lane_id === laneId).map((r) => r.place), `round ${round} ${slot} lane ${laneId}`).toEqual([1, 2]);
      }
    }
  }, 120_000);

  it.each([1, 2, 3])("N parallel bookings of ONE identity into different slots with an identity limit of %i: exactly that many are created, with numbers 1 to the limit", async (limit) => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, identityLimit: 1 });
      await t.env.DB.prepare("UPDATE event_layout SET identity_limit = ? WHERE event_id = ?").bind(limit, e.id).run();
      const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => book(e.slug, slotAt(i), "Rex", "Sam Jones")));
      expect(tally(answers), `round ${round}`).toEqual({ "201": limit, "409 duplicate_booking": 8 - limit });
      expect((await rows(e.id)).map((r) => r.identity_seq).sort(), `round ${round}`).toEqual(Array.from({ length: limit }, (_, i) => i + 1));
    }
  }, 120_000);

  it.each([
    { held: "numbers 2 and 3", cleared: 1, created: 0 },
    { held: "only number 3", cleared: 2, created: 1 },
  ])("an identity limit lowered from 3 to 2 while the identity holds $held: 8 parallel bookings of it never take it above 2 (exactly $created created)", async ({ cleared, created }) => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, identityLimit: 3 });
      for (let i = 0; i < 3; i++) await insertBooking(t.env.DB, e.id, slotAt(i), "Rex", "Sam Jones");
      await t.env.DB.prepare("DELETE FROM bookings WHERE event_id = ? AND identity_seq <= ?").bind(e.id, cleared).run();
      await t.env.DB.prepare("UPDATE event_layout SET identity_limit = 2, config_rev = config_rev + 1 WHERE event_id = ?").bind(e.id).run();
      const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => book(e.slug, slotAt(4 + i), "Rex", "Sam Jones")));
      expect(tally(answers), `round ${round}`).toEqual(created === 0 ? { "409 duplicate_booking": 8 } : { "201": 1, "409 duplicate_booking": 7 });
      expect((await rows(e.id)).length, `round ${round}`).toBe(2);
    }
  }, 120_000);

  it.each([1, 2, 3])("N parallel bookings of ONE rider and pony (a form with an optional third field that differs every time) with an identity limit of %i: exactly that many are created", async (limit) => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, {
        ...DAY, identityLimit: limit,
        fields: [{ label: "Rider", identity: true }, { label: "Pony", identity: true }, { label: "Phone", required: false }],
      });
      const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => book(e.slug, slotAt(i), "Ann Lee", "Biscuit", { extra: { field3: `0770090000${i}` } })));
      expect(tally(answers), `round ${round}`).toEqual({ "201": limit, "409 duplicate_booking": 8 - limit });
      expect((await rows(e.id)).map((r) => r.identity_seq).sort(), `round ${round}`).toEqual(Array.from({ length: limit }, (_, i) => i + 1));
    }
  }, 120_000);

  it.each([1, 2])("N parallel bookings of ONE car reg (a form of one field, the identity) with an identity limit of %i: exactly that many are created", async (limit) => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, identityLimit: limit, fields: [{ label: "Car reg", identity: true }] });
      const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => send(`/api/events/${e.slug}/bookings`, {
        method: "POST", body: { slot: slotAt(i), field1: i % 2 ? "AB12 CDE" : "ab12  cde", idempotencyKey: generateBookingToken() },
      })));
      expect(tally(answers), `round ${round}`).toEqual({ "201": limit, "409 duplicate_booking": 6 - limit });
      expect((await rows(e.id)).map((r) => r.identity_seq).sort(), `round ${round}`).toEqual(Array.from({ length: limit }, (_, i) => i + 1));
    }
  }, 120_000);

  it(`parallel identical requests with ONE idempotency key: one booking, every answer is that booking (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, capacity: 2 });
      const key = generateBookingToken();
      const answers = await Promise.all(Array.from({ length: 6 }, () => book(e.slug, slotAt(0), "Rex", "Sam Jones", { key })));
      expect(answers.map((a) => a.status), `round ${round}`).toEqual([201, 201, 201, 201, 201, 201]);
      expect(new Set(answers.map((a) => a.token)).size, `round ${round}`).toBe(1);
      expect(answers.filter((a) => a.replayed).length, `round ${round}`).toBeGreaterThanOrEqual(0);
      expect(await rows(e.id), `round ${round}`).toHaveLength(1);
    }
  }, 120_000);

  it(`parallel admin moves into the one free slot: exactly one wins, the other gets slot_taken (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, DAY);
      const a = await insertBooking(t.env.DB, e.id, slotAt(0), "Rex", "Sam");
      const b = await insertBooking(t.env.DB, e.id, slotAt(1), "Fido", "Ann");
      const answers = await Promise.all([adminMove(e.slug, a, slotAt(0), slotAt(5)), adminMove(e.slug, b, slotAt(1), slotAt(5))]);
      expect(tally(answers), `round ${round}`).toEqual({ "200": 1, "409 slot_taken": 1 });
      expect((await rows(e.id)).filter((r) => r.slot_start_utc === slotAt(5)), `round ${round}`).toHaveLength(1);
    }
  }, 120_000);

  it(`parallel admin moves into a capacity-2 slot with one place left, and one public booking too: exactly one place is taken (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, capacity: 2 });
      await insertBooking(t.env.DB, e.id, slotAt(5), "Held", "Already");
      const a = await insertBooking(t.env.DB, e.id, slotAt(0), "Rex", "Sam");
      const b = await insertBooking(t.env.DB, e.id, slotAt(1), "Fido", "Ann");
      const answers = await Promise.all([adminMove(e.slug, a, slotAt(0), slotAt(5)), adminMove(e.slug, b, slotAt(1), slotAt(5)), book(e.slug, slotAt(5), "Pub", "Lic")]);
      expect(answers.filter((x) => x.status === 200 || x.status === 201), `round ${round}`).toHaveLength(1);
      expect((await rows(e.id)).filter((r) => r.slot_start_utc === slotAt(5)).map((r) => r.place), `round ${round}`).toEqual([1, 2]);
    }
  }, 120_000);

  it(`an admin add and a public booking racing for the one free place: exactly one wins (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, DAY);
      const answers = await Promise.all([adminAdd(e.slug, slotAt(3), "Admin", "Added"), book(e.slug, slotAt(3), "Pub", "Lic")]);
      expect(answers.filter((x) => x.status === 201), `round ${round}`).toHaveLength(1);
      expect(answers.filter((x) => x.status === 409 && x.code === "slot_taken"), `round ${round}`).toHaveLength(1);
      expect(await rows(e.id), `round ${round}`).toHaveLength(1);
    }
  }, 120_000);

  it(`parallel admin moves from several lanes into the one free place of a lane: exactly one wins, the others get slot_taken (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, lanes: ["Ring 1", "Ring 2", "Ring 3"] });
      const [l1, l2, l3] = e.laneIds;
      const a = await insertBooking(t.env.DB, e.id, slotAt(0), "Rex", "Sam", { laneId: l1 });
      const b = await insertBooking(t.env.DB, e.id, slotAt(1), "Fido", "Ann", { laneId: l2 });
      const c = await insertBooking(t.env.DB, e.id, slotAt(2), "Bo", "Cy", { laneId: l3 });
      const answers = await Promise.all([adminMove(e.slug, a, slotAt(0), slotAt(5), l3), adminMove(e.slug, b, slotAt(1), slotAt(5), l3), adminMove(e.slug, c, slotAt(2), slotAt(5))]);
      expect(tally(answers), `round ${round}`).toEqual({ "200": 1, "409 slot_taken": 2 });
      expect((await rows(e.id)).filter((r) => r.slot_start_utc === slotAt(5) && r.lane_id === l3), `round ${round}`).toHaveLength(1);
    }
  }, 120_000);

  it(`parallel admin moves and adds into a capacity-3 lane with one place left, and a public booking: exactly one takes the place, places stay 1 to 3 (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, capacity: 3, lanes: ["Ring 1", "Ring 2"] });
      const [l1, l2] = e.laneIds;
      await insertBooking(t.env.DB, e.id, slotAt(5), "H1", "X", { laneId: l1 });
      await insertBooking(t.env.DB, e.id, slotAt(5), "H2", "X", { laneId: l1 });
      const m1 = await insertBooking(t.env.DB, e.id, slotAt(0), "Rex", "Sam", { laneId: l2 });
      const m2 = await insertBooking(t.env.DB, e.id, slotAt(1), "Fido", "Ann", { laneId: l2 });
      const answers = await Promise.all([
        adminMove(e.slug, m1, slotAt(0), slotAt(5), l1), adminMove(e.slug, m2, slotAt(1), slotAt(5), l1),
        adminAdd(e.slug, slotAt(5), "Added", "Admin", l1), book(e.slug, slotAt(5), "Pub", "Lic", { laneId: l1 }),
      ]);
      expect(answers.filter((x) => x.status === 200 || x.status === 201), `round ${round}`).toHaveLength(1);
      expect((await rows(e.id)).filter((r) => r.slot_start_utc === slotAt(5) && r.lane_id === l1).map((r) => r.place), `round ${round}`).toEqual([1, 2, 3]);
    }
  }, 120_000);

  it(`parallel admin adds into a capacity-2 lane: exactly 2 are created, the rest slot_taken, and they never share a place (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, capacity: 2, lanes: ["Ring 1", "Ring 2"] });
      const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => adminAdd(e.slug, slotAt(0), `D${i}`, `H${i}`, e.laneIds[1])));
      expect(tally(answers), `round ${round}`).toEqual({ "201": 2, "409 slot_taken": 4 });
      expect((await rows(e.id)).map((r) => [r.lane_id, r.place]), `round ${round}`).toEqual([[e.laneIds[1], 1], [e.laneIds[1], 2]]);
    }
  }, 120_000);

  it(`an edit of the layout racing a burst of bookings: every booking is either in place before the edit or refused, never in a lane or place the edit removed (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, capacity: 2, lanes: ["Ring 1", "Ring 2"] });
      const [l1] = e.laneIds;
      const edit = send(`/api/admin/events/${e.slug}`, {
        method: "PUT", admin: true,
        body: {
          name: "Edited", date: "2026-10-17", start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 0, costPence: 0, venuePostcode: "AB1 2CD", details: "",
          breaks: [], lanes: [{ id: l1, name: "Ring 1" }], capacity: 1, configRev: 0,
        },
      });
      const bookings = Array.from({ length: 8 }, (_, i) => book(e.slug, slotAt(i % 2), `D${i}`, `H${i}`, { laneId: e.laneIds[i % 2] }));
      const [saved] = await Promise.all([edit, ...bookings]);
      // Either the edit saved (409 bookings_affected is fine too: the answer then lists what is in the way) and the database is consistent.
      expect([200, 409], `round ${round}`).toContain(saved.status);
      const stored = await rows(e.id);
      const lanes = (await t.env.DB.prepare("SELECT id FROM event_lanes WHERE event_id = ?").bind(e.id).all<{ id: number }>()).results.map((l) => l.id);
      const capacity = (await t.env.DB.prepare("SELECT capacity FROM event_layout WHERE event_id = ?").bind(e.id).first<{ capacity: number }>())!.capacity;
      for (const r of stored) {
        expect(lanes, `round ${round}`).toContain(r.lane_id);
        expect(r.place, `round ${round}`).toBeLessThanOrEqual(capacity);
      }
    }
  }, 120_000);
});

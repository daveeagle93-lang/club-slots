import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateBookingToken } from "../core/slug";
import { onRequestPut } from "../routes/api/admin/events/[slug]/index";
import { onRequestPost as book } from "../routes/api/events/[slug]/bookings";
import { createBooking } from "../server/bookings";
import { loadEventBySlug } from "../server/events";
import { createTestEnv, insertBreak, insertEvent, insertsBooking, interceptBatches, type TestEnv, type TestField } from "./db";

// How many SQL statements the Worker sends to D1 for one request, counted by wrapping the database. docs/known-limits.md quotes these
// numbers (the Workers Free plan allows 50 D1 queries per invocation; the 58-statement worst-case edit save below passed on a real Free
// account on the preview deployment, so a batch is not counted statement by statement), so
// a change that moves them should update that page. The numbers are pinned as ceilings, so the test fails when a request gets more
// expensive (and passes if one gets cheaper); run it with `--reporter=verbose --silent=false` to print what was measured.

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(() => { vi.setSystemTime(new Date("2026-10-01T12:00:00Z")); });
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };

interface Counts { statements: number; batches: number; largestBatch: number }

/** The database, except that every statement sent to it is counted (a batch counts each of its statements; a single query counts one). */
function counting(db: D1Database) {
  const counts: Counts = { statements: 0, batches: 0, largestBatch: 0 };
  interface Wrapped { real: D1PreparedStatement }
  const wrap = (real: D1PreparedStatement): Wrapped & Record<string, unknown> => ({
    real,
    bind: (...v: unknown[]) => wrap(real.bind(...v)),
    first: (...a: unknown[]) => { counts.statements++; return (real.first as (...x: unknown[]) => Promise<unknown>)(...a); },
    all: () => { counts.statements++; return real.all(); },
    run: () => { counts.statements++; return real.run(); },
    raw: (...a: unknown[]) => { counts.statements++; return (real.raw as (...x: unknown[]) => Promise<unknown>)(...a); },
  });
  const counted = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (list: Wrapped[]) => {
      counts.batches++;
      counts.statements += list.length;
      counts.largestBatch = Math.max(counts.largestBatch, list.length);
      return db.batch(list.map((s) => s.real));
    },
  } as unknown as D1Database;
  return { db: counted, counts };
}

const FOUR: TestField[] = [{ label: "Dog", identity: true }, { label: "Handler", identity: true }, { label: "Phone", required: false }, { label: "Notes", required: false }];
const FOUR_BODY = (over: Record<string, unknown> = {}) => FOUR.map((f) => ({ label: f.label, required: f.required !== false, maxLength: 80, identity: f.identity === true, ...over }));

async function put(slug: string, body: unknown, db: D1Database): Promise<Response> {
  return onRequestPut({
    request: new Request(`http://localhost/api/admin/events/${slug}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    env: { DB: db }, params: { slug }, data: ADMIN,
  } as unknown as Parameters<typeof onRequestPut>[0]);
}

const london = (utc: string) => `${String(Number(utc.slice(11, 13)) + 1).padStart(2, "0")}:${utc.slice(14, 16)}`; // BST on 24 October 2026: UTC + 1

describe("statements sent to D1 per request", () => {
  it("(a) a typical edit save: 3 breaks, 3 lanes, 4 fields, capacity 1 to 2", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, lanes: ["Ring 1", "Ring 2", "Ring 3"], fields: FOUR, capacity: 1 });
    const breaks = [["09:00", "09:15"], ["09:45", "10:00"], ["10:15", "10:30"]];
    for (const [s, f] of breaks) await insertBreak(t.env.DB, e.id, `2026-10-24T${s}:00Z`, `2026-10-24T${f}:00Z`, "Break");
    const { db, counts } = counting(t.env.DB);
    const res = await put(e.slug, {
      name: "Edited", date: "2026-10-24", start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 0, costPence: 1250, venuePostcode: "AB1 2CD", details: "",
      breaks: breaks.map(([s, f]) => ({ start: london(`2026-10-24T${s}:00Z`), end: london(`2026-10-24T${f}:00Z`), label: "Break" })), capacity: 2, configRev: 0,
    }, db);
    expect(res.status).toBe(200);
    console.info(`statements (a) typical edit save: ${JSON.stringify(counts)}`);
    expect(counts.statements).toBeLessThanOrEqual(18);
  });

  it("(b) a worst-case edit save: 20 breaks, 10 lanes (all renamed and reordered), 4 fields changed (shape too), capacity 2 to 1", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `Ring ${i + 1}`);
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T20:00:00Z", sessionMinutes: 5, lanes: names, fields: FOUR.slice(0, 3), capacity: 2 });
    const at = (i: number, minute: number) => { const m = 8 * 60 + 30 + i * 30 + minute; return `2026-10-24T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00Z`; };
    for (let i = 0; i < 20; i++) await insertBreak(t.env.DB, e.id, at(i, 0), at(i, 5), `Old ${i}`);
    const stored = (await t.env.DB.prepare("SELECT id FROM event_lanes WHERE event_id = ? ORDER BY position").bind(e.id).all<{ id: number }>()).results;
    const { db, counts } = counting(t.env.DB);
    const res = await put(e.slug, {
      name: "Edited", date: "2026-10-24", start: "09:00", end: "21:00", sessionMinutes: 5, gapMinutes: 0, costPence: 1250, venuePostcode: "AB1 2CD", details: "",
      breaks: Array.from({ length: 20 }, (_, i) => ({ start: london(at(i, 0)), end: london(at(i, 5)), label: `New ${i}` })),
      lanes: [...stored].reverse().map((l, i) => ({ id: l.id, name: `Arena ${i + 1}` })), capacity: 1,
      fields: FOUR_BODY({ maxLength: 40 }).map((f, i) => ({ ...f, identity: i < 3, required: i < 3 || f.required })), identityLimit: 2, configRev: 0,
    }, db);
    expect(res.status, await res.clone().text()).toBe(200);
    console.info(`statements (b) worst-case edit save: ${JSON.stringify(counts)}`);
    expect(counts.statements).toBeLessThanOrEqual(58);
  });

  const body = (slot: string, key: string) => ({ slot, field1: "Rex", field2: "Sam Jones", idempotencyKey: key });
  const post = (slug: string, payload: unknown, db: D1Database) => book({
    request: new Request(`http://localhost/api/events/${slug}/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    env: { DB: db }, params: { slug },
  } as unknown as Parameters<typeof book>[0]);

  it("(c) a public booking: the happy path, after one lost race for a place, and after one edit that raced the insert", async () => {
    const S = "2026-10-24T08:00:00Z";
    const make = () => insertEvent(t.env.DB, { startUtc: S, endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, capacity: 3 });

    const happy = await make();
    const a = counting(t.env.DB);
    expect((await post(happy.slug, body(S, generateBookingToken()), a.db)).status).toBe(201);
    console.info(`statements (c) public booking, happy path: ${JSON.stringify(a.counts)}`);

    // One lost race: another booking takes the place this request read as free, just before its insert.
    const raced = await make();
    let lost = false;
    const racing = interceptBatches(t.env.DB, async (sqls, run) => {
      if (insertsBooking(sqls) && !lost) {
        lost = true;
        await t.env.DB.prepare(
          "INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key, identity_seq, token) VALUES (?, ?, ?, 1, 'Other', 'Person', 'other', 1, ?)",
        ).bind(raced.id, raced.laneId, S, generateBookingToken()).run();
      }
      return run();
    });
    const b = counting(racing);
    expect((await post(raced.slug, body(S, generateBookingToken()), b.db)).status).toBe(201);
    console.info(`statements (c) public booking, after one lost race for a place: ${JSON.stringify(b.counts)}`);

    // One edit that raced the insert (schedule_changed): the event is read again and the request is checked and booked again.
    const edited = await make();
    let bumped = false;
    const editing = interceptBatches(t.env.DB, async (sqls, run) => {
      if (insertsBooking(sqls) && !bumped) {
        bumped = true;
        await t.env.DB.prepare("UPDATE event_layout SET config_rev = config_rev + 1 WHERE event_id = ?").bind(edited.id).run();
      }
      return run();
    });
    const c = counting(editing);
    expect((await post(edited.slug, body(S, generateBookingToken()), c.db)).status).toBe(201);
    console.info(`statements (c) public booking, after one edit that raced the insert: ${JSON.stringify(c.counts)}`);

    expect(a.counts.statements).toBeLessThanOrEqual(10);
    expect(b.counts.statements).toBeLessThanOrEqual(15);
    expect(c.counts.statements).toBeLessThanOrEqual(19);
  });

  it("(c) the longest a contended booking can loop: capacity 50 and identity limit 20, every insert lost (as a ceiling: nothing else can change)", async () => {
    const S = "2026-10-24T08:00:00Z";
    const e = await insertEvent(t.env.DB, { startUtc: S, endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, capacity: 50, identityLimit: 20 });
    const event = (await loadEventBySlug(t.env.DB, e.slug))!;
    const failing = interceptBatches(t.env.DB, async (sqls, run) => {
      if (insertsBooking(sqls)) throw new Error("D1_ERROR: UNIQUE constraint failed: bookings.token");
      return run();
    });
    const { db, counts } = counting(failing);
    const input = { slot: S, laneId: e.laneId, values: ["Rex", "Sam Jones"], idempotencyKey: generateBookingToken() };
    const result = await createBooking(db, event, { start: S, end: "2026-10-24T08:15:00Z" }, input, new Date());
    expect(result.kind).toBe("slot_taken");
    console.info(`statements (c) longest contended booking loop (createBooking only, not the handler's own reads): ${JSON.stringify(counts)}`);
    expect(counts.statements).toBeLessThanOrEqual(361);
  });
});

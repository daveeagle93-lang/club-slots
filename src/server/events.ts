import { generateSchedule, type TimeRange } from "../core/schedule";
import { isValidSlug } from "../core/slug";
import { LEGACY_FIELDS } from "./fields";

/** One lane (ring) of an event; lanes run in parallel, in `position` order. A single lane may have an empty name. */
export interface EventLane { id: number; position: number; name: string }

/** One field of an event's booking form: `position` (1 to 4) is also the number of the bookings column that holds its value. */
export interface EventField { position: number; label: string; required: boolean; maxLength: number; identity: boolean }

export interface EventRow {
  id: number;
  slug: string;
  name: string;
  startUtc: string;
  endUtc: string;
  sessionMinutes: number;
  gapMinutes: number;
  costPence: number;
  venuePostcode: string;
  details: string;
  /** What the admin's Share button builds its message from; empty means the default template's, then the built-in wording. Never public. */
  shareMessage: string;
  archived: boolean;
  /** Whether the landing page lists it. Unlisted events are still bookable by their link. */
  listed: boolean;
  breaks: (TimeRange & { label: string })[];
  lanes: EventLane[];
  /** Places per lane per time. */
  capacity: number;
  /** The booking form's fields in order (one to four). The identity fields together are what one booking is "by": see identityKeyOf. */
  fields: EventField[];
  /** How many bookings one identity (the values of the identity fields) may hold in the event. */
  identityLimit: number;
  /** Counts the edits of lanes, capacity, identity limit and the fields that matter to a booking, so a request can tell that they changed under it (db-guard.ts). */
  configRev: number;
}

/** What is left in one lane at one time. */
export interface LanePlaces { laneId: number; free: number }

export interface SlotView extends TimeRange {
  /** "free" if any place in any lane is free and the slot hasn't started, "taken" if none is (booked wins over past), else "past". */
  status: "free" | "taken" | "past";
  places: LanePlaces[];
}

interface RawEvent {
  id: number; slug: string; name: string; start_utc: string; end_utc: string; session_minutes: number;
  gap_minutes: number; cost_pence: number; venue_postcode: string; details: string; share_message: string; archived: number; listed: number;
}

/** The stored form of an event's or a template's field, as the queries select it. */
export interface RawField { position: number; label: string; required: number; max_length: number; in_identity: number }
export const fieldOf = (r: RawField): EventField =>
  ({ position: r.position, label: r.label, required: r.required === 1, maxLength: r.max_length, identity: r.in_identity === 1 });

/**
 * The two idempotent statements that give the events chosen by `idsSql` (a query that selects event ids, with `binds` for its
 * parameters) what the migration gave every event that existed then: a layout row (capacity 1, limit 1, revision 0) and one unnamed
 * lane at position 1. Each only adds what is missing, so running them again, or at the same time, changes nothing, and an event that
 * is gone is skipped (a foreign key would refuse it).
 */
export const layoutRepairStatements = (db: D1Database, idsSql: string, ...binds: unknown[]): D1PreparedStatement[] => [
  db.prepare(`INSERT OR IGNORE INTO event_layout (event_id) SELECT id FROM events WHERE id IN (${idsSql})`).bind(...binds),
  db.prepare(
    `INSERT INTO event_lanes (event_id, position, name) SELECT id, 1, '' FROM events
     WHERE id IN (${idsSql}) AND NOT EXISTS (SELECT 1 FROM event_lanes WHERE event_lanes.event_id = events.id)`,
  ).bind(...binds),
];

/**
 * Repairs an event that has no layout row or no lane: one made by the previous version of the app between `migrations apply` and
 * `wrangler deploy` (that code knows nothing of lanes), which would otherwise show every slot taken and refuse every booking.
 * Idempotent (see layoutRepairStatements).
 */
export async function ensureEventLayout(db: D1Database, eventId: number): Promise<void> {
  await db.batch(layoutRepairStatements(db, "SELECT ?", eventId));
}

/**
 * The event with its breaks, lanes, fields and layout, from one batch (one round trip, one consistent snapshot). One without
 * field rows has the Dog and Handler form (LEGACY_FIELDS). One with no lane (made by the previous version of the app in the moments
 * between the migration and the deploy) is repaired first (ensureEventLayout) and read again, so it has one unnamed lane, capacity 1,
 * limit 1 and revision 0; an event with a lane but no layout row reads as capacity 1, limit 1 and revision 0.
 */
export async function loadEventBySlug(db: D1Database, slug: string): Promise<EventRow | null> {
  if (!isValidSlug(slug)) return null;
  const idOf = "(SELECT id FROM events WHERE slug = ?)";
  const read = () => db.batch([
    db.prepare("SELECT * FROM events WHERE slug = ?").bind(slug),
    db.prepare(`SELECT start_utc, end_utc, label FROM breaks WHERE event_id = ${idOf} ORDER BY start_utc`).bind(slug),
    db.prepare(`SELECT id, position, name FROM event_lanes WHERE event_id = ${idOf} ORDER BY position`).bind(slug),
    db.prepare(`SELECT position, label, required, max_length, in_identity FROM event_fields WHERE event_id = ${idOf} ORDER BY position`).bind(slug),
    db.prepare(`SELECT capacity, identity_limit, config_rev FROM event_layout WHERE event_id = ${idOf}`).bind(slug),
  ]);
  let [event, breaks, lanes, fields, layout] = await read();
  const e = (event.results as unknown as RawEvent[])[0];
  if (!e) return null;
  if (lanes.results.length === 0) {
    await ensureEventLayout(db, e.id);
    [event, breaks, lanes, fields, layout] = await read();
  }
  const results = breaks.results as { start_utc: string; end_utc: string; label: string }[];
  const rawLayout = (layout.results as { capacity: number; identity_limit: number; config_rev: number }[])[0];
  return {
    id: e.id, slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc,
    sessionMinutes: e.session_minutes, gapMinutes: e.gap_minutes, costPence: e.cost_pence,
    venuePostcode: e.venue_postcode, details: e.details, shareMessage: e.share_message, archived: e.archived === 1, listed: e.listed === 1,
    breaks: results.map((b) => ({ start: b.start_utc, end: b.end_utc, label: b.label })),
    lanes: lanes.results as unknown as EventLane[], fields: fields.results.length > 0 ? (fields.results as unknown as RawField[]).map(fieldOf) : [...LEGACY_FIELDS],
    capacity: rawLayout?.capacity ?? 1, identityLimit: rawLayout?.identity_limit ?? 1, configRev: rawLayout?.config_rev ?? 0,
  };
}

/**
 * The public face of an event: no event id, no breaks, no share message. The lanes are the ones a booker chooses between and
 * the fields are what the form asks for. Which of them identify a booking is not listed, but it is not secret either: the 409
 * duplicate_booking message names the identity fields' labels ("That dog and handler already have a booking"), to a request that
 * guessed an identity, so a booker can learn which fields those are.
 */
export const eventSummary = (e: EventRow) => ({
  slug: e.slug, name: e.name, startUtc: e.startUtc, endUtc: e.endUtc,
  costPence: e.costPence, venuePostcode: e.venuePostcode, details: e.details, archived: e.archived,
  lanes: e.lanes.map((l) => ({ id: l.id, name: l.name })), capacity: e.capacity,
  fields: e.fields.map((f) => ({ position: f.position, label: f.label, required: f.required, maxLength: f.maxLength })),
});

/**
 * Bookings close at the event's start plus the offset (minutes, may be negative); a request at
 * exactly that instant is too late. `now` is passed in so callers and tests control the clock.
 */
export function bookingWindow(e: EventRow, offsetMinutes: number, now: Date): { open: boolean; closesAt: string } {
  const closesAt = new Date(Date.parse(e.startUtc) + offsetMinutes * 60_000);
  return { open: !e.archived && now.getTime() < closesAt.getTime(), closesAt: closesAt.toISOString().replace(".000Z", "Z") };
}

/**
 * The public rule for one slot: the booking window is open and the slot has not started (a request at
 * exactly its start is too late). Admin booking does not call this.
 */
export const isSlotBookable = (slotStart: string, window: { open: boolean }, now: Date): boolean =>
  window.open && Date.parse(slotStart) > now.getTime();

/**
 * Bookings whose slot is not in the current schedule are ignored. A slot with no free place in any lane is "taken", and
 * that wins over "past" (a slot that has started and is full shows as unavailable either way); a slot that has started
 * with places left is "past". `places` has one entry per lane, in lane order, so a page can offer a lane at a time.
 */
export async function computeSlotViews(db: D1Database, event: EventRow, now: Date): Promise<SlotView[]> {
  const { slots } = generateSchedule({
    start: event.startUtc, end: event.endUtc,
    sessionMinutes: event.sessionMinutes, gapMinutes: event.gapMinutes, breaks: event.breaks,
  });
  const { results } = await db
    .prepare("SELECT slot_start_utc, lane_id, COUNT(*) AS n FROM bookings WHERE event_id = ? GROUP BY slot_start_utc, lane_id")
    .bind(event.id)
    .all<{ slot_start_utc: string; lane_id: number; n: number }>();
  const booked = new Map(results.map((r) => [`${r.slot_start_utc}|${r.lane_id}`, r.n]));
  return slots.map((s) => {
    const places = event.lanes.map((l) => ({ laneId: l.id, free: Math.max(0, event.capacity - (booked.get(`${s.start}|${l.id}`) ?? 0)) }));
    const anyFree = places.some((p) => p.free > 0);
    return { ...s, status: !anyFree ? "taken" : isSlotBookable(s.start, { open: true }, now) ? "free" : "past", places };
  });
}

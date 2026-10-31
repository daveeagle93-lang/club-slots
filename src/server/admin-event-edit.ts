import { buildLineup } from "../core/lineup";
import { utcToLondon } from "../core/london";
import { generateSchedule, type TimeRange } from "../core/schedule";
import { defaultShareMessageStatement, previewSchedule, type EventDraft } from "./admin-events";
import { noStore } from "./bookings";
import { guard, isGuardFailure } from "./db-guard";
import { loadEventBySlug, type EventRow } from "./events";
import { draftsOf, fieldChange, shownValues, withPositions } from "./fields";
import { errorResponse } from "./http";
import { loadSettings } from "./settings";

export type EditResult =
  | { kind: "saved"; event: EventRow; slotCount: number; removed: BookingRef[]; hasBookings: boolean }
  | { kind: "bookings_affected"; affected: BookingRef[] }
  /** The lanes, capacity, identity limit or fields were edited by someone else after the page the request was made on was loaded (or after the event was read), and this request would have overwritten that. */
  | { kind: "layout_changed" }
  /** The request changes the number of fields or which of them identify a booking, and the event has bookings (or got one meanwhile): nothing was written. */
  | { kind: "fields_locked" }
  | { kind: "not_found" };

export const eventNotFound = (): Response => errorResponse(404, "not_found", "Event not found", {}, noStore);

export const editFailed = (what: string, e: unknown): Response => {
  console.error(`${what} failed:`, e instanceof Error ? e.message : String(e));
  return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
};

/**
 * A booking as the edit screens list it. `slotStart` is a UTC instant; the slot's end isn't needed. `fields` are the values of
 * the booking form, labelled, in the form's order (a blank optional one is left out).
 */
export interface BookingRef {
  id: number; slotStart: string; lane: { id: number; name: string };
  fields: { label: string; value: string }[];
}

/** A booking with what deciding a clash needs: its place and when it was made. */
export interface StoredBooking extends BookingRef { place: number; createdAt: string }

/** The bookings columns `value_1` to `value_4`, as every query that lists bookings selects them. */
export interface ValueColumns { value_1: string; value_2: string; value_3: string; value_4: string }

/** A booking as the admin API shows it, from its columns and the event's fields. */
export const bookingRefOf = (
  b: { id: number; slotStart: string; lane: { id: number; name: string } } & ValueColumns, fields: readonly { label: string }[],
): BookingRef => ({
  id: b.id, slotStart: b.slotStart, lane: b.lane, fields: shownValues(fields, [b.value_1, b.value_2, b.value_3, b.value_4]),
});

export const toRef = (b: StoredBooking): BookingRef => ({ id: b.id, slotStart: b.slotStart, lane: b.lane, fields: b.fields });

/**
 * The event as the edit form uses it: London-local date and times next to the stored UTC instants. `hasBookings` says whether the event
 * has any booking at all (an orphan counts): once it has, the number of fields and which of them identify a booking can't change.
 */
export const eventView = (e: EventRow, hasBookings: boolean) => ({
  slug: e.slug, name: e.name, archived: e.archived, listed: e.listed,
  date: utcToLondon(e.startUtc).date, start: utcToLondon(e.startUtc).time, end: utcToLondon(e.endUtc).time,
  sessionMinutes: e.sessionMinutes, gapMinutes: e.gapMinutes, costPence: e.costPence,
  venuePostcode: e.venuePostcode, details: e.details, shareMessage: e.shareMessage,
  startUtc: e.startUtc, endUtc: e.endUtc,
  lanes: e.lanes.map((l) => ({ id: l.id, name: l.name })), capacity: e.capacity,
  fields: draftsOf(e.fields), identityLimit: e.identityLimit, hasBookings,
  // What the page was loaded at: an edit of the lanes, places or form sends it back, and is refused if someone else's edit has raised it since.
  configRev: e.configRev,
  breaks: [...e.breaks].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0))
    .map((b) => ({ start: utcToLondon(b.start).time, end: utcToLondon(b.end).time, label: b.label, startUtc: b.start, endUtc: b.end })),
});

/** Every booking of the event, in slot, lane and place order: one query. */
export async function loadBookings(db: D1Database, event: Pick<EventRow, "id" | "fields">): Promise<StoredBooking[]> {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.slot_start_utc, b.value_1, b.value_2, b.value_3, b.value_4, b.lane_id, l.name AS lane_name, b.place, b.created_at
       FROM bookings b JOIN event_lanes l ON l.id = b.lane_id
       WHERE b.event_id = ? ORDER BY b.slot_start_utc, l.position, b.place, b.id`,
    )
    .bind(event.id)
    .all<ValueColumns & { id: number; slot_start_utc: string; lane_id: number; lane_name: string; place: number; created_at: string }>();
  return results.map((r) => ({
    ...bookingRefOf({ ...r, slotStart: r.slot_start_utc, lane: { id: r.lane_id, name: r.lane_name } }, event.fields),
    place: r.place, createdAt: r.created_at,
  }));
}

/** What a draft would leave of the event: the slots, the lanes (by id) and the places per lane per time. */
export interface LayoutPlan { slots: TimeRange[]; laneIds: ReadonlySet<number>; capacity: number }

/** The plan for saving `draft` over `event`: a draft that doesn't list the lanes or the capacity keeps the event's. */
export const planOf = (event: Pick<EventRow, "lanes" | "capacity">, draft: Pick<EventDraft, "lanes" | "capacity">, slots: TimeRange[]): LayoutPlan => ({
  slots,
  laneIds: new Set(draft.lanes ? draft.lanes.flatMap((l) => (l.id === undefined ? [] : [l.id])) : event.lanes.map((l) => l.id)),
  capacity: draft.capacity ?? event.capacity,
});

/**
 * The bookings that would not survive the plan, in the order given. A booking is stranded when its slot is not in the new
 * schedule, or its lane is removed, or it is over the new capacity: of the bookings that stay in one lane at one time, the
 * `capacity` made first stay (ties by id) and the later ones are stranded, so the booker who was there first keeps the place.
 */
export function strandedBookings(bookings: StoredBooking[], plan: LayoutPlan): StoredBooking[] {
  const starts = new Set(plan.slots.map((s) => s.start));
  const stranded = new Set<number>();
  const groups = new Map<string, StoredBooking[]>();
  for (const b of bookings) {
    if (!starts.has(b.slotStart) || !plan.laneIds.has(b.lane.id)) {
      stranded.add(b.id);
      continue;
    }
    const key = `${b.lane.id}|${b.slotStart}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  for (const group of groups.values()) {
    const byAge = [...group].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));
    for (const b of byAge.slice(plan.capacity)) stranded.add(b.id);
  }
  return bookings.filter((b) => stranded.has(b.id));
}

/** The bookings that are not where the event can hold them now: at a time that isn't a slot, in a lane it doesn't have, or at a place beyond its capacity. */
export const orphanBookings = (bookings: StoredBooking[], event: Pick<EventRow, "lanes" | "capacity">, slots: TimeRange[]): StoredBooking[] => {
  const starts = new Set(slots.map((s) => s.start));
  const lanes = new Set(event.lanes.map((l) => l.id));
  return bookings.filter((b) => !starts.has(b.slotStart) || !lanes.has(b.lane.id) || b.place > event.capacity);
};

/**
 * The saved schedule with each slot's bookings, and any booking that is not where the event can hold it (`orphans`: its time is
 * not a slot, its lane is gone, or its place is beyond the capacity; there should be none).
 *
 * Each slot has `places`: one entry per lane in lane order, with the lane's `bookings` (in place order) and how many places are
 * `free`.
 *
 * `lineup` is the WhatsApp text for the schedule page's Copy button, built here so the page can copy it
 * synchronously from what it already loaded (a clipboard write has to happen inside the click). It has one line per place (see
 * buildLineup): the lane is named in each line unless the event has one unnamed lane. A booked place shows only the values of the
 * fields that identify a booking, in the form's order (the other fields are not for a group chat).
 * `defaultShareMessage` is the default template's share message ("" if none), for events that have none of their own.
 */
export async function eventDetail(db: D1Database, event: EventRow) {
  const { slots } = generateSchedule({
    start: event.startUtc, end: event.endUtc, sessionMinutes: event.sessionMinutes, gapMinutes: event.gapMinutes, breaks: event.breaks,
  });
  const [bookings, { clubName }, defaultMessage] = await Promise.all([
    loadBookings(db, event), loadSettings(db), defaultShareMessageStatement(db).first<{ share_message: string }>(),
  ]);
  const orphans = orphanBookings(bookings, event, slots);
  const orphanIds = new Set(orphans.map((b) => b.id));
  const at = new Map<string, StoredBooking[]>(); // by slot and lane, in place order (loadBookings' order)
  for (const b of bookings) if (!orphanIds.has(b.id)) at.set(`${b.slotStart}|${b.lane.id}`, [...(at.get(`${b.slotStart}|${b.lane.id}`) ?? []), b]);
  const withBookings = slots.map((s) => {
    const places = event.lanes.map((l) => {
      const held = at.get(`${s.start}|${l.id}`) ?? [];
      return {
        laneId: l.id, laneName: l.name, free: Math.max(0, event.capacity - held.length),
        bookings: held.map((b) => ({ id: b.id, fields: b.fields })),
      };
    });
    return { ...s, places };
  });
  // The lineup is pasted into a club chat, so it names only who a booking is for (the fields that identify it): a phone number or a
  // note in an optional field is for the organisers and stays in these pages, the CSV and the booker's own confirmation. A booking's
  // `fields` leave out blank ones, so they are matched by label (unique within an event).
  const identityLabels = new Set(event.fields.filter((f) => f.identity).map((f) => f.label));
  const lineupSlots = withBookings.map((s) => ({
    ...s, places: s.places.map((p) => ({ ...p, bookings: p.bookings.map((b) => ({ fields: b.fields.filter((f) => identityLabels.has(f.label)) })) })),
  }));
  return {
    event: eventView(event, bookings.length > 0),
    slots: withBookings,
    orphans: orphans.map(toRef),
    defaultShareMessage: defaultMessage?.share_message ?? "",
    lineup: buildLineup({
      clubName, name: event.name, venuePostcode: event.venuePostcode, startUtc: event.startUtc,
      slots: lineupSlots, breaks: event.breaks,
    }),
  };
}

const MAX_REMOVE_IDS = 500;

/** The save request's optional `removeBookingIds` (missing means none), or the field error to report. */
export function checkRemoveIds(value: unknown): { ids: number[] } | { message: string } {
  if (value === undefined) return { ids: [] };
  const ok = Array.isArray(value) && value.length <= MAX_REMOVE_IDS
    && value.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0);
  return ok ? { ids: value as number[] } : { message: `Send at most ${MAX_REMOVE_IDS} booking ids, each a positive whole number.` };
}

/** Test seam: runs after the bookings were read and before the batch, where a real booking could land. */
export interface SaveHooks { afterRead?: () => Promise<void> }

/**
 * Saves the draft over the event, removing the bookings the admin confirmed.
 *
 * The bookings that would be stranded are worked out from a read (strandedBookings: their time leaves the schedule, their lane
 * is removed, or they are over a lowered capacity, the latest made first); if any of them was not confirmed, nothing is changed
 * and they are returned. Otherwise one batch updates the event, replaces its breaks, deletes exactly those bookings, renumbers
 * the places of the bookings that stay when the capacity went down (all parked above 10000 first, so UNIQUE is never hit half-way),
 * and rewrites the lanes and the layout. Its leading guards fail the whole batch if any booking now sits where the new schedule
 * or lanes can't hold it without being one of those (a booking made after the read: nothing is written and the fresh list is
 * returned), if a booking in the list has moved since (the read is repeated), or if the event was deleted after the read
 * (not_found, nothing written). A draft that lists the lanes or the capacity is written over the layout it was made from, so it
 * is refused (layout_changed) if the layout was edited after that: the draft carries the `configRev` of the page it was made on
 * (a request must; a draft without one is taken to have been made from the event as passed in), which is compared with the stored
 * one before anything is read, and again inside the batch; every edit that changes the lanes or the
 * capacity increases event_layout.config_rev in the same batch, which is how a booking request that read the old layout fails
 * its own guard (db-guard.ts). The same holds for a draft that lists `fields` or `identityLimit`: written over the form it was made
 * from, and config_rev goes up when the identity limit, the number of fields, which of them identify a booking, a required flag or a
 * longest value changes (labels alone don't matter to a booking in flight). Once the event has bookings the number of fields and the
 * identity fields can't change (fields_locked): checked on the bookings read, and by a guard in the batch, so a booking made
 * after the read stops the save too. Other event fields are last write wins.
 */
export async function saveEventEdit(
  db: D1Database, event: EventRow, draft: EventDraft, confirmedIds: number[], hooks: SaveHooks = {},
): Promise<EditResult> {
  const { slots } = previewSchedule(draft);
  const confirmed = new Set(confirmedIds);
  const touchesLayout = draft.lanes !== undefined || draft.capacity !== undefined || draft.fields !== undefined || draft.identityLimit !== undefined;
  // The revision the page was loaded at; a draft without one (not made by a request) is taken to have been made from the event as read.
  const expectedRev = draft.configRev ?? event.configRev;
  if (touchesLayout && expectedRev !== event.configRev) return { kind: "layout_changed" };
  let current = event;
  for (let attempt = 0; ; attempt++) {
    const bookings = await loadBookings(db, current);
    // Bookings hold values and identity keys made for the form they were booked with: its number of fields and which of them identify a booking stay.
    if (bookings.length > 0 && draft.fields !== undefined && fieldChange(current.fields, draft.fields).shape) return { kind: "fields_locked" };
    const affected = strandedBookings(bookings, planOf(current, draft, slots));
    if (affected.some((b) => !confirmed.has(b.id)) || attempt >= MAX_ATTEMPTS) return { kind: "bookings_affected", affected: affected.map(toRef) };
    if (attempt === 0) await hooks.afterRead?.();
    try {
      return await writeEdit(db, current, draft, slots, affected);
    } catch (e) {
      if (!isGuardFailure(e)) throw e;
      const fresh = await loadEventBySlug(db, event.slug);
      if (!fresh) return { kind: "not_found" };
      if (touchesLayout && fresh.configRev !== expectedRev) return { kind: "layout_changed" };
      current = fresh;
    }
  }
}

/** A guard failure that is only a booking having moved is retried from a fresh read; this many tries, then the list is returned. */
const MAX_ATTEMPTS = 3;

/** The batch of saveEventEdit for one read: `affected` are the confirmed bookings to remove. Throws the guard's error if the database moved on. */
async function writeEdit(
  db: D1Database, event: EventRow, draft: EventDraft, slots: TimeRange[], affected: StoredBooking[],
): Promise<EditResult> {
  // A request without `listed` (or `shareMessage`) leaves it as it is in the database now (COALESCE with null), not as it was when the event was loaded.
  const listed = draft.listed ?? event.listed;
  const starts = JSON.stringify(slots.map((s) => s.start));
  const ids = JSON.stringify(affected.map((b) => b.id));
  const outside = "slot_start_utc NOT IN (SELECT value FROM json_each(?))";
  const lanes = draft.lanes;
  const capacity = draft.capacity ?? event.capacity;
  const lanesChanged = lanes !== undefined
    && (lanes.length !== event.lanes.length || lanes.some((l, i) => l.id !== event.lanes[i].id || l.name !== event.lanes[i].name));
  const identityLimit = draft.identityLimit ?? event.identityLimit;
  const fields = draft.fields === undefined ? undefined : fieldChange(event.fields, draft.fields);
  const layoutChanged = lanesChanged || capacity !== event.capacity || identityLimit !== event.identityLimit || (fields?.matters ?? false);

  const batch: D1PreparedStatement[] = [
    guard(db, "EXISTS (SELECT 1 FROM events WHERE id = ?)", event.id),
    ...(lanes === undefined && draft.capacity === undefined && draft.fields === undefined && draft.identityLimit === undefined ? [] : [
      guard(db, "COALESCE((SELECT config_rev FROM event_layout WHERE event_id = ?), 0) = ?", event.id, draft.configRev ?? event.configRev),
    ]),
    // A booking made since the read stops a change of the number of fields or the identity fields (the whole batch writes nothing).
    ...(fields?.shape ? [guard(db, "NOT EXISTS (SELECT 1 FROM bookings WHERE event_id = ?)", event.id)] : []),
    guard(
      db,
      `NOT EXISTS (SELECT 1 FROM bookings WHERE event_id = ? AND ${outside} AND id NOT IN (SELECT value FROM json_each(?)))`,
      event.id, starts, ids,
    ),
    ...(lanes === undefined ? [] : [
      guard(
        db,
        "NOT EXISTS (SELECT 1 FROM bookings WHERE event_id = ? AND lane_id NOT IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?)))",
        event.id, JSON.stringify(lanes.flatMap((l) => (l.id === undefined ? [] : [l.id]))), ids,
      ),
    ]),
    // Every booking to be removed must still be where it was read: one that has moved is a different clash (the read is repeated).
    // One that is already gone is fine, so a retried save finds nothing left to remove.
    guard(
      db,
      `NOT EXISTS (SELECT 1 FROM bookings b JOIN json_each(?) j ON b.id = json_extract(j.value, '$[0]') WHERE b.event_id = ?
         AND (b.lane_id <> json_extract(j.value, '$[1]') OR b.slot_start_utc <> json_extract(j.value, '$[2]') OR b.place <> json_extract(j.value, '$[3]')))`,
      JSON.stringify(affected.map((b) => [b.id, b.lane.id, b.slotStart, b.place])), event.id,
    ),
    db.prepare(
      `UPDATE events SET name = ?, start_utc = ?, end_utc = ?, session_minutes = ?, gap_minutes = ?, cost_pence = ?,
         venue_postcode = ?, details = ?, share_message = COALESCE(?, share_message), listed = COALESCE(?, listed) WHERE id = ?`,
    ).bind(draft.name, draft.startUtc, draft.endUtc, draft.sessionMinutes, draft.gapMinutes, draft.costPence,
      draft.venuePostcode, draft.details, draft.shareMessage ?? null, draft.listed === undefined ? null : draft.listed ? 1 : 0, event.id),
    db.prepare("DELETE FROM breaks WHERE event_id = ?").bind(event.id),
    ...draft.breaks.map((b) =>
      db.prepare("INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (?, ?, ?, ?)").bind(event.id, b.startUtc, b.endUtc, b.label)),
    // The fields are replaced as a whole (one batch), so two labels swapped never meet the unique label index half-way.
    ...(draft.fields === undefined || !fields?.any ? [] : [
      db.prepare("DELETE FROM event_fields WHERE event_id = ?").bind(event.id),
      ...withPositions(draft.fields).map((f) =>
        db.prepare("INSERT INTO event_fields (event_id, position, label, required, max_length, in_identity) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(event.id, f.position, f.label, f.required ? 1 : 0, f.maxLength, f.identity ? 1 : 0)),
    ]),
  ];
  const deleteAt = batch.length;
  batch.push(
    db.prepare(
      "DELETE FROM bookings WHERE event_id = ? AND id IN (SELECT value FROM json_each(?)) RETURNING id, slot_start_utc, lane_id, value_1, value_2, value_3, value_4",
    ).bind(event.id, ids),
  );
  if (capacity < event.capacity) {
    // No group may be over the new capacity once the confirmed bookings are gone, then every group is numbered 1, 2, ... in its old order.
    batch.push(
      guard(db, "NOT EXISTS (SELECT 1 FROM bookings WHERE event_id = ? GROUP BY lane_id, slot_start_utc HAVING COUNT(*) > ?)", event.id, capacity),
      db.prepare("UPDATE bookings SET place = place + 10000 WHERE event_id = ?").bind(event.id),
      db.prepare(
        `UPDATE bookings SET place = n.rn FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY lane_id, slot_start_utc ORDER BY place, id) AS rn FROM bookings WHERE event_id = ?
         ) AS n WHERE bookings.id = n.id`,
      ).bind(event.id),
    );
  }
  if (lanes && lanesChanged) {
    // Lanes not listed go first (the guard above saw to it that none has a booking). The rest are parked at a position above 100
    // under a name nobody can type (U+001F), so renames and reorders that swap names or positions never clash half-way.
    batch.push(
      db.prepare("DELETE FROM event_lanes WHERE event_id = ? AND id NOT IN (SELECT value FROM json_each(?))")
        .bind(event.id, JSON.stringify(lanes.flatMap((l) => (l.id === undefined ? [] : [l.id])))),
      db.prepare("UPDATE event_lanes SET position = position + 100, name = char(31) || id WHERE event_id = ?").bind(event.id),
      ...lanes.flatMap((l, i) => (l.id === undefined ? [] : [
        db.prepare("UPDATE event_lanes SET position = ?, name = ? WHERE id = ? AND event_id = ?").bind(i + 1, l.name, l.id, event.id),
      ])),
      ...lanes.flatMap((l, i) => (l.id !== undefined ? [] : [
        db.prepare("INSERT INTO event_lanes (event_id, position, name) VALUES (?, ?, ?)").bind(event.id, i + 1, l.name),
      ])),
    );
  }
  if (layoutChanged) {
    batch.push(
      db.prepare(
        `INSERT INTO event_layout (event_id, capacity, identity_limit, config_rev) VALUES (?, ?, ?, 1)
         ON CONFLICT (event_id) DO UPDATE SET capacity = excluded.capacity, identity_limit = excluded.identity_limit, config_rev = config_rev + 1`,
      ).bind(event.id, capacity, identityLimit),
    );
  }

  // Last, so it sees the batch's own deletions: whether the event still has any booking (the page locks the form's shape if so).
  batch.push(db.prepare("SELECT EXISTS (SELECT 1 FROM bookings WHERE event_id = ?) AS has").bind(event.id));
  const results = await db.batch(batch);
  const hasBookings = (results[results.length - 1].results as { has: number }[])[0].has === 1;
  const deleted = results[deleteAt].results as (ValueColumns & { id: number; slot_start_utc: string; lane_id: number })[];
  const laneName = new Map(event.lanes.map((l) => [l.id, l.name]));
  const newLanes = lanesChanged
    ? (await db.prepare("SELECT id, position, name FROM event_lanes WHERE event_id = ? ORDER BY position").bind(event.id).all<EventRow["lanes"][number]>()).results
    : event.lanes;
  return {
    kind: "saved", slotCount: slots.length, hasBookings,
    event: {
      ...event, name: draft.name, startUtc: draft.startUtc, endUtc: draft.endUtc, sessionMinutes: draft.sessionMinutes,
      gapMinutes: draft.gapMinutes, costPence: draft.costPence, venuePostcode: draft.venuePostcode, details: draft.details,
      shareMessage: draft.shareMessage ?? event.shareMessage, listed,
      breaks: draft.breaks.map((b) => ({ start: b.startUtc, end: b.endUtc, label: b.label })),
      lanes: newLanes, capacity, identityLimit, fields: draft.fields === undefined ? event.fields : withPositions(draft.fields),
      configRev: layoutChanged ? event.configRev + 1 : event.configRev,
    },
    removed: deleted.map((r) => bookingRefOf(
      { ...r, slotStart: r.slot_start_utc, lane: { id: r.lane_id, name: laneName.get(r.lane_id) ?? "" } }, event.fields,
    )).sort((a, b) => (a.slotStart < b.slotStart ? -1 : a.slotStart > b.slotStart ? 1 : a.id - b.id)),
  };
}

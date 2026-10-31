import { generateBookingToken } from "../core/slug";
import { bookingRefOf, type BookingRef, type ValueColumns } from "./admin-event-edit";
import { checkFieldValues, chooseLane, findSlot, noStore } from "./bookings";
import { guard, isGuardFailure, scheduleUnchanged } from "./db-guard";
import { loadEventBySlug, type EventRow } from "./events";
import { columnValues, duplicateMessage, identityKeyFor } from "./fields";
import { errorResponse } from "./http";
import { placeAtFreeSpot } from "./places";

/** What an admin booking action answers when it can't do what was asked: becomes the JSON error response. */
export interface Failure { status: number; code: string; message: string; extra?: object }
export type Outcome<T> = { ok: T } | Failure;

export const failureResponse = (f: Failure): Response => errorResponse(f.status, f.code, f.message, f.extra ?? {}, noStore);

const fail = (status: number, code: string, message: string, extra?: object): Failure => ({ status, code, message, extra });
const invalidInput = (fields: Record<string, string>) => fail(400, "invalid_input", "Check the highlighted fields.", { fields });
const invalidSlot = () => fail(400, "invalid_slot", "That time isn't one of this event's slots.");
const notFound = () => fail(404, "not_found", "Booking not found.");
const changed = () => fail(409, "changed", "This booking was changed by someone else. Reload the page.");
const eventChanged = () => fail(409, "event_changed", "The event was edited while you were working. Reload the page.");

/** Test seam: runs after the handler's reads and before the batch, where another request could change things. */
export interface MutationHooks { afterRead?: () => Promise<void> }

type Row = ValueColumns & { id: number; slot_start_utc: string; lane_id: number };
const COLUMNS = "id, slot_start_utc, lane_id, value_1, value_2, value_3, value_4";
const ref = (r: Row, event: Pick<EventRow, "lanes" | "fields">): BookingRef =>
  bookingRefOf({ ...r, slotStart: r.slot_start_utc, lane: { id: r.lane_id, name: event.lanes.find((l) => l.id === r.lane_id)?.name ?? "" } }, event.fields);

/** A guard failure is either the event being edited or a booking having moved: say which. */
async function guardFailed(db: D1Database, event: EventRow): Promise<Failure> {
  const fresh = await loadEventBySlug(db, event.slug);
  const same = (e: EventRow) =>
    JSON.stringify([e.startUtc, e.endUtc, e.sessionMinutes, e.gapMinutes, e.configRev, [...new Set(e.breaks.map((b) => `${b.start}|${b.end}`))].sort()]);
  return !fresh || same(fresh) !== same(event) ? eventChanged() : changed();
}

/** Everyone who holds a place in the lane at that time, in place order, for telling the admin why a move or add was refused (admin-only, so no leak). */
const holdersOf = async (db: D1Database, eventId: number, laneId: number, slot: string) =>
  (await db.prepare(`SELECT ${COLUMNS}, identity_key FROM bookings WHERE event_id = ? AND lane_id = ? AND slot_start_utc = ? ORDER BY place`)
    .bind(eventId, laneId, slot).all<Row & { identity_key: string }>()).results;

/** The extra payload of a slot_taken refusal: `bookings`, everyone in the lane at that time. */
const takenExtra = (event: Pick<EventRow, "lanes" | "fields">, holders: (Row & { identity_key: string })[]): object => ({ bookings: holders.map((h) => ref(h, event)) });

/**
 * Adds a booking on someone's behalf: `field1` to `field4` as the event's form has them (checked as the public form is: see
 * checkFieldValue), in the lane named by `laneId` (which may be left out when the event has one lane). This
 * is an admin override: unlike the public booking it ignores the cut-off, the past-slot rule and an archived event, so an
 * organiser can fix up the day itself. The slot must still be one of the current schedule. The place is the lowest free one in
 * the lane at that time, found and taken as the public booking does (placeAtFreeSpot: the UNIQUE constraints decide a clash).
 * A full lane is a 409 slot_taken naming everyone who holds a place (admin-only, so no leak).
 */
export async function addBooking(
  db: D1Database, event: EventRow, raw: Record<string, unknown>, hooks: MutationHooks = {},
): Promise<Outcome<BookingRef>> {
  const checked = checkFieldValues(raw, event.fields);
  const laneChoice = chooseLane(event, raw.laneId);
  const fields: Record<string, string> = "errors" in checked ? checked.errors : {};
  if ("message" in laneChoice) fields.laneId = laneChoice.message;
  if (typeof raw.slot !== "string") fields.slot = "Choose a slot.";
  if (Object.keys(fields).length > 0) return invalidInput(fields);
  const { values } = checked as { values: string[] };
  const { laneId } = laneChoice as { laneId: number };
  const slot = findSlot(event, raw.slot as string);
  if (!slot) return invalidSlot();
  await hooks.afterRead?.();

  const key = identityKeyFor(event.fields, values);
  const outcome = await placeAtFreeSpot({
    db, event, laneId, slot: slot.start, identityKey: key,
    insert: async ({ place, seq }) => {
      const results = await db.batch([
        scheduleUnchanged(db, event),
        db.prepare(
          `INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, value_3, value_4, identity_key, identity_seq, token)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
        ).bind(event.id, laneId, slot.start, place, ...columnValues(values), key, seq, generateBookingToken()),
      ]);
      return (results[1].results as Row[])[0];
    },
  });
  switch (outcome.kind) {
    case "placed":
      return { ok: ref(outcome.value, event) };
    case "schedule_changed":
      return eventChanged();
    case "full": {
      const holders = await holdersOf(db, event.id, laneId, slot.start);
      if (holders.length === 0) return changed(); // whoever held it has gone again
      const own = holders.find((h) => h.identity_key === key);
      if (own) return fail(409, "duplicate_booking", duplicateMessage(event.fields), { booking: ref(own, event) });
      return fail(409, "slot_taken", "That slot is already taken.", takenExtra(event, holders));
    }
    case "identity_limit": {
      const existing = await db
        .prepare(`SELECT ${COLUMNS} FROM bookings WHERE event_id = ? AND identity_key = ? ORDER BY identity_seq LIMIT 1`)
        .bind(event.id, key).first<Row>();
      if (!existing) return changed(); // whoever caused the clash has gone again
      return fail(409, "duplicate_booking", duplicateMessage(event.fields), { booking: ref(existing, event) });
    }
    case "gave_up":
    case "settled":
      return changed();
  }
}

/** Removes the booking if it belongs to this event; a second call, or another event's id, finds nothing. */
export async function clearBooking(db: D1Database, event: EventRow, id: number): Promise<Outcome<BookingRef>> {
  const row = await db
    .prepare(`DELETE FROM bookings WHERE id = ? AND event_id = ? RETURNING ${COLUMNS}`)
    .bind(id, event.id).first<Row>();
  return row ? { ok: ref(row, event) } : notFound();
}

/**
 * Moves a booking to a free place at another time, or in another lane, or both. Admin override: the new slot may be past or
 * closed. The booking must still be where the admin saw it: `fromSlot`, and `fromLane` when sent (left out, the lane is not
 * checked). It lands in `toLane`, which is its own lane when left out, on the lowest free place there, found and taken as
 * addBooking does, so two moves into the last free place cannot both win (the loser gets slot_taken). Moving to the slot and
 * lane the booking is already in is `same_slot`; the same slot in another lane is a move.
 */
export async function moveBooking(
  db: D1Database, event: EventRow, id: number, raw: Record<string, unknown>, hooks: MutationHooks = {},
): Promise<Outcome<BookingRef>> {
  const fields: Record<string, string> = {};
  if (typeof raw.fromSlot !== "string") fields.fromSlot = "Send the slot the booking is in.";
  if (typeof raw.toSlot !== "string") fields.toSlot = "Choose a slot.";
  if (raw.fromLane !== undefined && typeof raw.fromLane !== "number") fields.fromLane = "Send the lane the booking is in.";
  if (raw.toLane !== undefined && !(typeof raw.toLane === "number" && event.lanes.some((l) => l.id === raw.toLane))) fields.toLane = "Choose a lane.";
  if (Object.keys(fields).length > 0) return invalidInput(fields);
  const { fromSlot, toSlot } = raw as { fromSlot: string; toSlot: string };
  const { fromLane, toLane } = raw as { fromLane?: number; toLane?: number };
  if (fromSlot === toSlot && toLane === undefined) return fail(400, "same_slot", "The booking is already in that slot.");
  if (!findSlot(event, toSlot)) return invalidSlot();
  const current = await db
    .prepare("SELECT lane_id, slot_start_utc FROM bookings WHERE id = ? AND event_id = ?")
    .bind(id, event.id).first<{ lane_id: number; slot_start_utc: string }>();
  if (!current) return notFound();
  if (current.slot_start_utc !== fromSlot || (fromLane !== undefined && fromLane !== current.lane_id)) return changed();
  const targetLane = toLane ?? current.lane_id;
  if (fromSlot === toSlot && targetLane === current.lane_id) return fail(400, "same_slot", "The booking is already in that slot.");
  await hooks.afterRead?.();

  const outcome = await placeAtFreeSpot({
    db, event, laneId: targetLane, slot: toSlot, identityKey: null,
    insert: async ({ place }) => {
      const results = await db.batch([
        scheduleUnchanged(db, event),
        db.prepare(`UPDATE bookings SET slot_start_utc = ?, lane_id = ?, place = ? WHERE id = ? AND event_id = ? AND slot_start_utc = ? AND lane_id = ? RETURNING ${COLUMNS}`)
          .bind(toSlot, targetLane, place, id, event.id, fromSlot, current.lane_id),
      ]);
      return (results[1].results as Row[])[0];
    },
  });
  switch (outcome.kind) {
    case "placed": {
      if (outcome.value) return { ok: ref(outcome.value, event) };
      const exists = await db.prepare("SELECT 1 AS n FROM bookings WHERE id = ? AND event_id = ?").bind(id, event.id).first();
      return exists ? changed() : notFound();
    }
    case "schedule_changed":
      return eventChanged();
    case "full": {
      const holders = await holdersOf(db, event.id, targetLane, toSlot);
      if (holders.length === 0) return changed();
      return fail(409, "slot_taken", "That slot is already taken.", takenExtra(event, holders));
    }
    case "identity_limit":
    case "gave_up":
    case "settled":
      return changed();
  }
}

/** A slot value that passes the table's shape check and is never a real slot, for the middle step of a swap. */
const PARKING_SLOT = "0001-01-01T00:00:00Z";

/** One side of a swap as it ended up: its id, time and lane (the lane may have changed too). */
type SwappedRef = { id: number; slotStart: string; lane: { id: number; name: string } };

/** One side of the request: the booking's id and slot, and the lane it was in when the admin saw it (optional: left out, the lane is not checked). */
function swapSide(value: unknown): { id: number; slot: string; lane?: number } | null {
  const v = value as { id?: unknown; slot?: unknown; lane?: unknown } | null;
  if (typeof v !== "object" || v === null) return null;
  if (!(typeof v.id === "number" && Number.isSafeInteger(v.id) && v.id > 0 && typeof v.slot === "string")) return null;
  if (v.lane === undefined) return { id: v.id, slot: v.slot };
  return typeof v.lane === "number" && Number.isSafeInteger(v.lane) && v.lane > 0 ? { id: v.id, slot: v.slot, lane: v.lane } : null;
}

/**
 * Swaps the places of two bookings of this event: each takes the other's lane, time and place (they may be in different lanes). Each
 * side is `{ id, slot }` as the admin saw it, with the booking's `lane` too when the caller sends it (left out, the lane is not checked, as
 * before lanes existed): a booking that has left that lane is `changed`, like one that has left its slot. SQLite checks UNIQUE
 * after every row, so the swap goes through a parking slot inside one batch: guards first (both bookings still where
 * the admin saw them, the parking slot unused, the schedule unchanged), then A to parking, B to A's place, A to B's
 * place, then a last guard that both ended up where intended. Any failure rolls the whole batch back, so no booking
 * is ever left on the parking slot. The people stay with their bookings, so the identity index is untouched.
 */
export async function swapBookings(
  db: D1Database, event: EventRow, raw: Record<string, unknown>, hooks: MutationHooks = {},
): Promise<Outcome<{ a: SwappedRef; b: SwappedRef }>> {
  const a = swapSide(raw.a);
  const b = swapSide(raw.b);
  if (!a || !b) {
    return invalidInput({ ...(a ? {} : { a: "Send the id and slot of the first booking." }), ...(b ? {} : { b: "Send the id and slot of the second booking." }) });
  }
  if (a.id === b.id) return fail(400, "same_booking", "Choose two different bookings.");
  const { results } = await db
    .prepare("SELECT id, slot_start_utc, lane_id, place FROM bookings WHERE event_id = ? AND id IN (SELECT value FROM json_each(?))")
    .bind(event.id, JSON.stringify([a.id, b.id])).all<{ id: number; slot_start_utc: string; lane_id: number; place: number }>();
  if (results.length !== 2) return notFound();
  const at = new Map(results.map((r) => [r.id, r]));
  const [rowA, rowB] = [at.get(a.id)!, at.get(b.id)!];
  if (rowA.slot_start_utc !== a.slot || rowB.slot_start_utc !== b.slot) return changed();
  if ((a.lane !== undefined && a.lane !== rowA.lane_id) || (b.lane !== undefined && b.lane !== rowB.lane_id)) return changed();
  // Both must end up on real slots: swapping an orphan with a booked slot would orphan the other booking.
  if (!findSlot(event, a.slot) || !findSlot(event, b.slot)) return invalidSlot();
  await hooks.afterRead?.();

  const where = "(id = ? AND slot_start_utc = ? AND lane_id = ? AND place = ?)";
  const bothAt = `(SELECT COUNT(*) FROM bookings WHERE event_id = ? AND (${where} OR ${where})) = 2`;
  const move = (id: number, from: { slot_start_utc: string; lane_id: number; place: number }, to: { slot_start_utc: string; lane_id: number; place: number }) =>
    db.prepare(`UPDATE bookings SET slot_start_utc = ?, lane_id = ?, place = ? WHERE id = ? AND event_id = ? AND slot_start_utc = ? RETURNING id, slot_start_utc, lane_id`)
      .bind(to.slot_start_utc, to.lane_id, to.place, id, event.id, from.slot_start_utc);
  const parking = { slot_start_utc: PARKING_SLOT, lane_id: rowA.lane_id, place: rowA.place };
  try {
    const out = await db.batch([
      scheduleUnchanged(db, event),
      guard(db, bothAt, event.id, a.id, a.slot, a.lane ?? rowA.lane_id, rowA.place, b.id, b.slot, b.lane ?? rowB.lane_id, rowB.place),
      guard(db, "NOT EXISTS (SELECT 1 FROM bookings WHERE event_id = ? AND slot_start_utc = ?)", event.id, PARKING_SLOT),
      move(a.id, rowA, parking),
      move(b.id, rowB, rowA),
      move(a.id, parking, rowB),
      guard(db, bothAt, event.id, a.id, b.slot, rowB.lane_id, rowB.place, b.id, a.slot, rowA.lane_id, rowA.place),
    ]);
    const swapped = (r: { id: number; slot_start_utc: string; lane_id: number }): SwappedRef =>
      ({ id: r.id, slotStart: r.slot_start_utc, lane: { id: r.lane_id, name: event.lanes.find((l) => l.id === r.lane_id)?.name ?? "" } });
    const aRow = (out[5].results as { id: number; slot_start_utc: string; lane_id: number }[])[0];
    const bRow = (out[4].results as { id: number; slot_start_utc: string; lane_id: number }[])[0];
    return { ok: { a: swapped(aRow), b: swapped(bRow) } };
  } catch (e) {
    if (!isGuardFailure(e)) throw e;
    return guardFailed(db, event);
  }
}

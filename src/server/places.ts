import { isGuardFailure } from "./db-guard";
import type { EventRow } from "./events";

/** The place (1 up) and identity number (1 up) a new booking is about to try. */
export interface Spot { place: number; seq: number }

export type SpotOutcome<T, S> =
  | { kind: "placed"; value: T }
  /** The caller's `settled` check found the request already answered (an idempotent replay). */
  | { kind: "settled"; value: S }
  /** No place is free in the lane at that time; `sameIdentityHolds` says whether the requester's own identity holds one of them. */
  | { kind: "full"; sameIdentityHolds: boolean }
  | { kind: "identity_limit" }
  /** The guard in the insert's batch failed: the event was edited after the caller read it, and nothing was written. */
  | { kind: "schedule_changed" }
  /** Every attempt lost to another request; the caller treats it like a full slot. */
  | { kind: "gave_up" };

export const isUniqueFailure = (e: unknown): boolean => e instanceof Error && e.message.includes("UNIQUE constraint failed");

/** The lowest number from 1 to `max` that is not in `used`, or null if they are all used. */
function lowestFree(used: ReadonlySet<number>, max: number): number | null {
  for (let n = 1; n <= max; n++) if (!used.has(n)) return n;
  return null;
}

/**
 * Finds a free place (and, for a booking with an identity, a free identity number) and tries `insert` with it, until it
 * works or it is clear why it can't. The database is the only arbiter: what is read here is a hint and nothing is
 * ever counted and then inserted on the strength of the count. `insert` writes with the given spot and throws on
 * failure; when it fails on a UNIQUE constraint (another request took the place or the identity number first, or the
 * idempotency key was used) the hint is read again and the next free spot is tried, at most capacity + identity limit + 2
 * times. `identityKey` null means there is no identity to number (a move keeps the booking's own). `settled` runs after
 * every UNIQUE failure and before a refusal, and returns an answer that ends the request (the idempotency replay).
 *
 * A refusal is worked out from the hint only when it names no free place (full) or no free number (identity_limit),
 * and "full" is checked first: a full lane is reported as full whatever the identity's state, which is what lets the
 * caller keep "no oracle for who has booked" (a request for a full slot never reveals that its identity has booked).
 */
export async function placeAtFreeSpot<T, S>(o: {
  db: D1Database;
  event: Pick<EventRow, "id" | "capacity" | "identityLimit">;
  laneId: number;
  slot: string;
  identityKey: string | null;
  insert: (spot: Spot) => Promise<T>;
  settled?: () => Promise<S | null>;
}): Promise<SpotOutcome<T, S>> {
  const { db, event } = o;
  const attempts = event.capacity + (o.identityKey === null ? 0 : event.identityLimit) + 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [holders, numbers] = await db.batch([
      db.prepare("SELECT place, identity_key FROM bookings WHERE event_id = ? AND lane_id = ? AND slot_start_utc = ?").bind(event.id, o.laneId, o.slot),
      db.prepare("SELECT identity_seq FROM bookings WHERE event_id = ? AND identity_key = ?").bind(event.id, o.identityKey ?? ""),
    ]);
    const held = holders.results as { place: number; identity_key: string }[];
    const place = lowestFree(new Set(held.map((h) => h.place)), event.capacity);
    // The identity's held numbers can sit above a limit the admin has since lowered, so the limit is a count of what it holds, not
    // only the range of numbers to choose from: below the limit there is always a free number from 1 to the limit.
    const heldNumbers = (numbers.results as { identity_seq: number }[]).map((n) => n.identity_seq);
    const seq = o.identityKey === null ? 1 : heldNumbers.length >= event.identityLimit ? null : lowestFree(new Set(heldNumbers), event.identityLimit);
    if (place === null || seq === null) {
      const prior = await o.settled?.();
      if (prior) return { kind: "settled", value: prior };
      return place === null
        ? { kind: "full", sameIdentityHolds: o.identityKey !== null && held.some((h) => h.identity_key === o.identityKey) }
        : { kind: "identity_limit" };
    }
    try {
      return { kind: "placed", value: await o.insert({ place, seq }) };
    } catch (e) {
      if (isGuardFailure(e)) return { kind: "schedule_changed" };
      if (!isUniqueFailure(e)) throw e;
      const prior = await o.settled?.();
      if (prior) return { kind: "settled", value: prior };
    }
  }
  return { kind: "gave_up" };
}

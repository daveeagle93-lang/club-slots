import { buildBookingIcs, uidSource } from "../core/ics";
import { isValidToken } from "../core/slug";
import { findSlot } from "./bookings";
import type { EventRow } from "./events";
import { shownValues } from "./fields";
import { loadSettings } from "./settings";

/**
 * Stable per booking identity within an event (not per slot or token), so if an admin moves the
 * slot, calendars treat it as the same entry instead of duplicating it. A moved booking keeps its
 * UID but SEQUENCE and DTSTAMP stay fixed (0 and created_at), so calendar clients may ignore the
 * update; revisit when the admin move feature adds a per-booking revision. `identityKey` is the stored
 * one (the keys of the identity fields joined with U+001F) and `seq` the booking's number within it; see uidSource.
 */
export async function bookingUid(slug: string, identityKey: string, seq = 1): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uidSource(slug, identityKey, seq)));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 32)}@slot-booker`;
}

export const bookingIcsUrl = (slug: string, token: string): string => `/api/events/${slug}/bookings/${token}/ics`;

/**
 * The .ics for the booking with this token, or null if there is none (or its slot is no longer
 * scheduled). The token is 128 random bits, so it cannot be guessed, and the caller must give every
 * miss the same response, so a miss reveals nothing about who has booked.
 */
export async function loadBookingIcs(db: D1Database, event: EventRow, token: string): Promise<string | null> {
  if (!isValidToken(token)) return null;
  const booking = await db
    .prepare(
      `SELECT b.slot_start_utc, b.value_1, b.value_2, b.value_3, b.value_4, b.identity_key, b.identity_seq, b.created_at, l.name AS lane_name
       FROM bookings b JOIN event_lanes l ON l.id = b.lane_id WHERE b.event_id = ? AND b.token = ?`,
    )
    .bind(event.id, token)
    .first<{ slot_start_utc: string; value_1: string; value_2: string; value_3: string; value_4: string; identity_key: string; identity_seq: number; created_at: string; lane_name: string }>();
  if (!booking) return null;
  const range = findSlot(event, booking.slot_start_utc);
  if (!range) return null;
  const { clubName } = await loadSettings(db);
  return buildBookingIcs({
    uid: await bookingUid(event.slug, booking.identity_key, booking.identity_seq),
    dtstamp: booking.created_at,
    slot: range,
    fields: shownValues(event.fields, [booking.value_1, booking.value_2, booking.value_3, booking.value_4]),
    eventName: event.name,
    venuePostcode: event.venuePostcode,
    costPence: event.costPence,
    details: event.details,
    clubName,
    laneName: booking.lane_name,
  });
}

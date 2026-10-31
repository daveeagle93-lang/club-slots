import {
  bookableSlots, createBooking, declaresOversizeBody, findByIdempotencyKey, findSlot, noStore, payloadTooLarge, readJsonObject,
  validateBookingInput, type BookingInput, type BookingResult, type CreateResult,
} from "../../../../server/bookings";
import { bookingCutoffOffsetMinutes } from "../../../../server/config";
import type { RouteHandler } from "../../../../server/env";
import { bookingWindow, eventSummary, isSlotBookable, loadEventBySlug, type EventRow } from "../../../../server/events";
import { duplicateMessage } from "../../../../server/fields";
import { errorResponse, json } from "../../../../server/http";
import { bookingIcsUrl } from "../../../../server/ics";

export const onRequestPost: RouteHandler<"slug"> = async ({ request, env, params }) => {
  // Before any lookup, so oversized requests cost no database work.
  if (declaresOversizeBody(request)) return payloadTooLarge();
  const event = await loadEventBySlug(env.DB, String(params.slug));
  if (!event) return errorResponse(404, "not_found", "Event not found", {}, noStore);

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const input = validateBookingInput(body, event);
  if ("fields" in input) {
    return errorResponse(400, "invalid_input", "Check the highlighted fields.", { fields: input.fields }, noStore);
  }

  const failed = (e: unknown) => {
    console.error("createBooking failed:", e instanceof Error ? e.message : String(e));
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
  };
  let result: BookingResult | null;
  // Before the archived and cut-off checks, so a retry after a dropped response still gets its booking.
  try {
    result = await findByIdempotencyKey(env.DB, event, input);
  } catch (e) {
    return failed(e);
  }
  // The event as the answer should describe it: replaced by the reloaded one if an edit raced the insert.
  let current = event;
  if (!result) {
    // Everything that depends on the event, so a retry after an edit re-checks it all against the fresh event.
    const book = async (ev: EventRow, wanted: BookingInput): Promise<Response | CreateResult> => {
      if (ev.archived) return errorResponse(410, "event_archived", "This event is closed to bookings.", {}, noStore);
      const now = new Date();
      const window = bookingWindow(ev, bookingCutoffOffsetMinutes(env.BOOKING_CUTOFF_OFFSET_MINUTES), now);
      if (!window.open) {
        return errorResponse(410, "bookings_closed", "Bookings for this event are now closed.", {}, noStore);
      }
      const slot = findSlot(ev, wanted.slot);
      if (!slot) return errorResponse(400, "invalid_slot", "That time isn't one of this event's slots.", {}, noStore);
      if (!isSlotBookable(slot.start, window, now)) {
        return errorResponse(
          409, "slot_started", "That session has already started.",
          { freeSlots: await bookableSlots(env.DB, ev, now) }, noStore,
        );
      }
      return createBooking(env.DB, ev, slot, wanted, now);
    };
    try {
      let outcome = await book(event, input);
      if (!(outcome instanceof Response) && outcome.kind === "schedule_changed") {
        // Edited between our read and the insert (nothing was written): look once more, and retry once if the slot survived.
        const fresh = await loadEventBySlug(env.DB, event.slug);
        if (!fresh) return errorResponse(404, "not_found", "Event not found", {}, noStore);
        current = fresh;
        // The values were checked against the form as it was: the edit may have changed the fields (how many, which are required,
        // how long) or the lanes, so they are checked again against the fresh event, never booked on the strength of the first check.
        const again = validateBookingInput(body, fresh);
        if ("fields" in again) return errorResponse(400, "invalid_input", "Check the highlighted fields.", { fields: again.fields }, noStore);
        outcome = await book(fresh, again);
      }
      if (outcome instanceof Response) return outcome;
      if (outcome.kind === "schedule_changed") {
        return errorResponse(409, "event_changed", "The event was just changed. Reload the page and try again.", {}, noStore);
      }
      result = outcome;
    } catch (e) {
      return failed(e);
    }
  }
  switch (result.kind) {
    case "created":
    case "replayed":
      return json({
        booking: result.booking,
        event: eventSummary(current),
        icsUrl: bookingIcsUrl(event.slug, result.token),
      }, 201, result.kind === "replayed" ? { ...noStore, "Idempotent-Replayed": "true" } : noStore);
    case "idempotency_key_reuse": {
      const message = "An earlier attempt from this page was already saved, so this change wasn't applied. To change a booking, contact the organiser.";
      const { original } = result;
      return errorResponse(422, "idempotency_key_reuse", message, original ? {
        booking: original.booking,
        event: eventSummary(current),
        icsUrl: bookingIcsUrl(event.slug, original.token),
      } : {}, noStore);
    }
    case "duplicate_booking":
      return errorResponse(409, "duplicate_booking", duplicateMessage(current.fields), {}, noStore);
    case "slot_taken":
      return errorResponse(409, "slot_taken", "That slot's just gone.", { freeSlots: result.freeSlots }, noStore);
  }
};

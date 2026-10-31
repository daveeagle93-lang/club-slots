import { bookingCutoffOffsetMinutes, privacyNotice } from "../../../../server/config";
import type { RouteHandler } from "../../../../server/env";
import { bookingWindow, computeSlotViews, eventSummary, loadEventBySlug } from "../../../../server/events";
import { errorResponse, json } from "../../../../server/http";

export const onRequestGet: RouteHandler<"slug"> = async ({ env, params }) => {
  const event = await loadEventBySlug(env.DB, String(params.slug));
  if (!event) return errorResponse(404, "not_found", "Event not found");
  const now = new Date();
  const slots = event.archived ? [] : await computeSlotViews(env.DB, event, now);
  return json(
    {
      event: eventSummary(event),
      slots,
      bookings: bookingWindow(event, bookingCutoffOffsetMinutes(env.BOOKING_CUTOFF_OFFSET_MINUTES), now),
      privacyNotice: privacyNotice(env.PRIVACY_NOTICE, event.fields.map((f) => f.label)),
    },
    200,
    { "Cache-Control": "no-store" },
  );
};

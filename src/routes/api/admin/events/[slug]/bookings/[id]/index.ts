import { refuseUnlessAdmin } from "../../../../../../../server/admin-context";
import { clearBooking, failureResponse } from "../../../../../../../server/admin-bookings";
import { editFailed, eventNotFound } from "../../../../../../../server/admin-event-edit";
import { noStore, readJsonObject } from "../../../../../../../server/bookings";
import type { RouteHandler } from "../../../../../../../server/env";
import { loadEventBySlug } from "../../../../../../../server/events";
import { errorResponse, json } from "../../../../../../../server/http";

/**
 * Clears a booking. The body must be `{"confirm": true}`: the server refuses anything else (a missing or
 * unreadable body, `false`, the string "true") so the confirmation is not only in the page. The booking
 * must belong to this event; a second clear, or an id from another event, is 404 and changes nothing.
 */
export const onRequestDelete: RouteHandler<"slug" | "id"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    const body = await readJsonObject(request);
    if (body instanceof Response || body.confirm !== true) {
      return errorResponse(400, "confirmation_required", "Confirm that you want to clear this booking.", {}, noStore);
    }
    const id = /^[1-9]\d{0,14}$/.test(String(params.id)) ? Number(params.id) : 0;
    const result = await clearBooking(env.DB, event, id);
    return "ok" in result ? json({ removed: result.ok }, 200, noStore) : failureResponse(result);
  } catch (e) {
    return editFailed("clearBooking", e);
  }
};

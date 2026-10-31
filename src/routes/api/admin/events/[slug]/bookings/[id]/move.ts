import { refuseUnlessAdmin } from "../../../../../../../server/admin-context";
import { failureResponse, moveBooking } from "../../../../../../../server/admin-bookings";
import { editFailed, eventNotFound } from "../../../../../../../server/admin-event-edit";
import { noStore, readJsonObject } from "../../../../../../../server/bookings";
import type { RouteHandler } from "../../../../../../../server/env";
import { loadEventBySlug } from "../../../../../../../server/events";
import { json } from "../../../../../../../server/http";

/** Moves a booking from `fromSlot` (where the admin saw it) to the free slot `toSlot`. */
export const onRequestPost: RouteHandler<"slug" | "id"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const id = /^[1-9]\d{0,14}$/.test(String(params.id)) ? Number(params.id) : 0;
    const result = await moveBooking(env.DB, event, id, body);
    return "ok" in result ? json({ booking: result.ok }, 200, noStore) : failureResponse(result);
  } catch (e) {
    return editFailed("moveBooking", e);
  }
};

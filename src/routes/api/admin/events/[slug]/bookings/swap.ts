import { refuseUnlessAdmin } from "../../../../../../server/admin-context";
import { failureResponse, swapBookings } from "../../../../../../server/admin-bookings";
import { editFailed, eventNotFound } from "../../../../../../server/admin-event-edit";
import { noStore, readJsonObject } from "../../../../../../server/bookings";
import type { RouteHandler } from "../../../../../../server/env";
import { loadEventBySlug } from "../../../../../../server/events";
import { json } from "../../../../../../server/http";

/** Swaps the places of two bookings, given as the ids and slots (and optionally lanes) the admin saw: see swapBookings. */
export const onRequestPost: RouteHandler<"slug"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const result = await swapBookings(env.DB, event, body);
    return "ok" in result ? json(result.ok, 200, noStore) : failureResponse(result);
  } catch (e) {
    return editFailed("swapBookings", e);
  }
};

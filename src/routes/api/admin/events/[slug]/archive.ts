import { refuseUnlessAdmin } from "../../../../../server/admin-context";
import { editFailed, eventNotFound } from "../../../../../server/admin-event-edit";
import { setArchived } from "../../../../../server/admin-event-lifecycle";
import { invalidInput } from "../../../../../server/admin-events";
import { noStore, readJsonObject } from "../../../../../server/bookings";
import type { RouteHandler } from "../../../../../server/env";
import { json } from "../../../../../server/http";

/**
 * Hides the event from the admin's main lists (archived: true) or brings it back (false). Nothing is deleted:
 * bookings stay, and the public page shows the event as closed to bookings while it is archived.
 */
export const onRequestPost: RouteHandler<"slug"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    if (typeof body.archived !== "boolean") return invalidInput({ archived: "Send archived as true or false." });
    const result = await setArchived(env.DB, String(params.slug), body.archived);
    return result ? json(result, 200, noStore) : eventNotFound();
  } catch (e) {
    return editFailed("setArchived", e);
  }
};

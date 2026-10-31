import { refuseUnlessAdmin } from "../../../../../server/admin-context";
import { editFailed, eventNotFound, loadBookings, planOf, strandedBookings, toRef } from "../../../../../server/admin-event-edit";
import { placeCountOf, previewSchedule, readEventDraft } from "../../../../../server/admin-events";
import { noStore } from "../../../../../server/bookings";
import type { RouteHandler } from "../../../../../server/env";
import { loadEventBySlug } from "../../../../../server/events";
import { json } from "../../../../../server/http";

/**
 * The stateless preview plus `affected`: this event's bookings the draft would strand (their time leaves the schedule, their
 * lane is removed, or they are over a lowered capacity) and `placeCount` for the lanes and capacity it would have (the
 * event's own where the draft leaves them out). Read-only. The date may be in the past: an event that has started can still be corrected.
 */
export const onRequestPost: RouteHandler<"slug"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    const draft = await readEventDraft(
      request, false, { laneIds: event.lanes.map((l) => l.id), capacity: event.capacity },
      { laneNames: event.lanes.map((l) => l.name), fieldLabels: event.fields.map((f) => f.label) },
    );
    if (draft instanceof Response) return draft;
    const preview = previewSchedule(draft);
    const affected = strandedBookings(await loadBookings(env.DB, event), planOf(event, draft, preview.slots)).map(toRef);
    const placeCount = placeCountOf(preview.slots.length, draft.lanes?.length ?? event.lanes.length, draft.capacity ?? event.capacity);
    return json({ ...preview, placeCount, affected }, 200, noStore);
  } catch (e) {
    return editFailed("editPreview", e);
  }
};

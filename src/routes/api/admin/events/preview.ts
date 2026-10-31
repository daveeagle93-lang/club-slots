import { placeCountOf, previewSchedule, readEventDraft } from "../../../../server/admin-events";
import { refuseUnlessAdmin } from "../../../../server/admin-context";
import { noStore } from "../../../../server/bookings";
import type { RouteHandler } from "../../../../server/env";
import { json } from "../../../../server/http";

/** Stateless: runs the real schedule engine on the draft and stores nothing; `placeCount` counts its lanes and capacity (one of each if left out). No database access. */
export const onRequestPost: RouteHandler = async ({ request, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const draft = await readEventDraft(request, false);
  if (draft instanceof Response) return draft;
  const preview = previewSchedule(draft);
  return json({ ...preview, placeCount: placeCountOf(preview.slots.length, draft.lanes?.length ?? 1, draft.capacity ?? 1) }, 200, noStore);
};

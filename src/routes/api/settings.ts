import { noStore } from "../../server/bookings";
import type { RouteHandler } from "../../server/env";
import { errorResponse, json } from "../../server/http";
import { loadPublicSettings } from "../../server/settings";

/** What public pages need to show the club's name, logo and privacy contact; see loadPublicSettings. */
export const onRequestGet: RouteHandler = async ({ env }) => {
  try {
    return json(await loadPublicSettings(env.DB), 200, noStore);
  } catch (e) {
    // Only the message is logged: an error object can carry SQL text and bound values.
    console.error("loadPublicSettings failed:", e instanceof Error ? e.message : String(e));
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
  }
};

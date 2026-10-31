import { serveIcon } from "../../../server/icons";
import type { RouteHandler } from "../../../server/env";
import { noStore } from "../../../server/bookings";
import { errorResponse } from "../../../server/http";
import { parseIconSize } from "../../../server/settings";

/** The app icon at 32, 180 or 512 px: the one made from the club's logo, or the bundled default. See serveIcon. */
export const onRequest: RouteHandler<"size"> = ({ request, env, params }) => {
  const size = parseIconSize(String(params.size ?? ""));
  if (size === null) return errorResponse(404, "not_found", "There is no icon of that size.", {}, noStore);
  return serveIcon(request, env, size);
};

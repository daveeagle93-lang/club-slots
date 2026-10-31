import { refuseUnlessAdmin } from "../../../../server/admin-context";
import { editFailed } from "../../../../server/admin-event-edit";
import { invalidInput, readEventBody } from "../../../../server/admin-events";
import { noStore } from "../../../../server/bookings";
import type { RouteHandler } from "../../../../server/env";
import { json } from "../../../../server/http";
import { loadAdminSettings, loadSettings, parseSettingsInput, saveSettings } from "../../../../server/settings";

export const onRequestGet: RouteHandler = async ({ env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    return json(await loadAdminSettings(env.DB), 200, noStore);
  } catch (e) {
    return editFailed("loadAdminSettings", e);
  }
};

/** Replaces the club name, privacy contact and website together; all three must be sent. */
export const onRequestPut: RouteHandler = async ({ request, env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const body = await readEventBody(request);
  if (body instanceof Response) return body;
  try {
    const parsed = parseSettingsInput(body, await loadSettings(env.DB));
    if ("fields" in parsed) return invalidInput(parsed.fields);
    await saveSettings(env.DB, parsed.settings);
    return json(await loadAdminSettings(env.DB), 200, noStore);
  } catch (e) {
    return editFailed("saveSettings", e);
  }
};

import { refuseUnlessAdmin } from "../../../../server/admin-context";
import { editFailed } from "../../../../server/admin-event-edit";
import { invalidInput, readEventBody } from "../../../../server/admin-events";
import { createTemplate, loadTemplates, MAX_TEMPLATES, parseTemplateDraft } from "../../../../server/admin-templates";
import { noStore } from "../../../../server/bookings";
import type { RouteHandler } from "../../../../server/env";
import { errorResponse, json } from "../../../../server/http";

export const onRequestGet: RouteHandler = async ({ env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    return json({ templates: await loadTemplates(env.DB) }, 200, noStore);
  } catch (e) {
    return editFailed("loadTemplates", e);
  }
};

/** Creates a template (at most 20). The first one, or one made while none is the default, becomes the default. */
export const onRequestPost: RouteHandler = async ({ request, env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const body = await readEventBody(request);
  if (body instanceof Response) return body;
  const parsed = parseTemplateDraft(body);
  if ("fields" in parsed) return invalidInput(parsed.fields);
  try {
    const result = await createTemplate(env.DB, parsed.draft);
    switch (result.kind) {
      case "saved":
        return json({ template: result.template }, 201, noStore);
      case "limit":
        return errorResponse(422, "template_limit", `You can have at most ${MAX_TEMPLATES} templates. Delete one to add another.`, {}, noStore);
      case "duplicate_name":
        return invalidInput({ name: "There is already a template with that name." });
      default:
        throw new Error(`Unexpected result ${result.kind}`);
    }
  } catch (e) {
    return editFailed("createTemplate", e);
  }
};

import { refuseUnlessAdmin } from "../../../../../server/admin-context";
import { editFailed } from "../../../../../server/admin-event-edit";
import { invalidInput, readEventBody } from "../../../../../server/admin-events";
import { deleteTemplate, loadTemplates, parseTemplateDraft, templateId, updateTemplate } from "../../../../../server/admin-templates";
import { noStore } from "../../../../../server/bookings";
import type { RouteHandler } from "../../../../../server/env";
import { errorResponse, json } from "../../../../../server/http";

const templateNotFound = (): Response => errorResponse(404, "not_found", "Template not found", {}, noStore);

export const onRequestGet: RouteHandler<"id"> = async ({ env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const id = templateId(params.id);
  if (id === null) return templateNotFound();
  try {
    const [template] = await loadTemplates(env.DB, id);
    return template ? json({ template }, 200, noStore) : templateNotFound();
  } catch (e) {
    return editFailed("loadTemplates", e);
  }
};

/**
 * Replaces the template's fields and breaks. `isDefault: true` makes it the only default; `isDefault: false` on the default is
 * refused (choose another template as the default instead); missing `isDefault` or `shareMessage` leaves them as they are.
 * Events made from the template are not touched: they hold copies.
 */
export const onRequestPut: RouteHandler<"id"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const id = templateId(params.id);
  if (id === null) return templateNotFound();
  const body = await readEventBody(request);
  if (body instanceof Response) return body;
  try {
    // The stored template, so a request that sends only the lanes (or only the capacity) is checked against the other as it is stored.
    const [stored] = await loadTemplates(env.DB, id);
    const parsed = parseTemplateDraft(body, stored);
    if ("fields" in parsed) return invalidInput(parsed.fields);
    const result = await updateTemplate(env.DB, id, parsed.draft);
    switch (result.kind) {
      case "saved":
        return json({ template: result.template }, 200, noStore);
      case "not_found":
        return templateNotFound();
      case "duplicate_name":
        return invalidInput({ name: "There is already a template with that name." });
      case "needs_default":
        return invalidInput({ isDefault: "Choose another template as the default instead." });
      default:
        throw new Error(`Unexpected result ${result.kind}`);
    }
  } catch (e) {
    return editFailed("updateTemplate", e);
  }
};

/** Deletes the template (and, if it was the default, makes the oldest remaining one the default). Events are not touched. */
export const onRequestDelete: RouteHandler<"id"> = async ({ env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const id = templateId(params.id);
  if (id === null) return templateNotFound();
  try {
    const deleted = await deleteTemplate(env.DB, id);
    return deleted ? json({ deleted }, 200, noStore) : templateNotFound();
  } catch (e) {
    return editFailed("deleteTemplate", e);
  }
};

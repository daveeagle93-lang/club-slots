import { inspectImage, type ImageRejection } from "../../../../core/image";
import { refuseUnlessAdmin } from "../../../../server/admin-context";
import { editFailed } from "../../../../server/admin-event-edit";
import { invalidInput } from "../../../../server/admin-events";
import { noStore, readJsonObject } from "../../../../server/bookings";
import type { RouteHandler } from "../../../../server/env";
import { errorResponse, json } from "../../../../server/http";
import { adminLogo, decodeBase64, deleteLogo, MAX_LOGO_BASE64, saveLogo } from "../../../../server/settings";

// The base64 of a logo at the size cap, plus the JSON around it, with room to spare. A bigger body is
// refused without being read in full.
const MAX_BODY_BYTES = 300_000;

const tooLarge = (): Response =>
  errorResponse(413, "too_large", "That image is too large. Use one of 200 KB or less.", {}, noStore);

const REFUSAL: Record<Exclude<ImageRejection, "too_large">, string> = {
  empty: "That file is empty.",
  unsupported_type: "Use a PNG, JPEG or WebP image. SVG isn't allowed.",
  corrupt: "That image file looks damaged, or has extra data after the image. Save it again as a PNG, JPEG or WebP and try again.",
  dimensions: "The image must be between 1 and 512 pixels wide and tall.",
};

/**
 * Replaces the logo. The body is JSON, `{ "data": "<base64>" }`, so the admin CSRF checks stay as they are.
 * The type comes from the bytes (see inspectImage); nothing the client says about the file is used.
 */
export const onRequestPut: RouteHandler = async ({ request, env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) return tooLarge();
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (body instanceof Response) return body.status === 413 ? tooLarge() : body;
  if (typeof body.data !== "string") return invalidInput({ data: "Choose an image to upload." });
  if (body.data.length > MAX_LOGO_BASE64) return tooLarge();
  const bytes = decodeBase64(body.data);
  if (!bytes) return invalidInput({ data: "The image wasn't sent as standard base64. Reload the page and try again." });

  const image = inspectImage(bytes);
  if (!image.ok) {
    if (image.reason === "too_large") return tooLarge();
    return errorResponse(422, "invalid_image", REFUSAL[image.reason], { reason: image.reason }, noStore);
  }
  try {
    return json({ logo: adminLogo(await saveLogo(env.DB, bytes, image)) }, 200, noStore);
  } catch (e) {
    return editFailed("saveLogo", e);
  }
};

/** Removes the logo; there being none already is not an error. */
export const onRequestDelete: RouteHandler = async ({ env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    await deleteLogo(env.DB);
    return json({ logo: null }, 200, noStore);
  } catch (e) {
    return editFailed("deleteLogo", e);
  }
};

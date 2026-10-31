import { inspectImage } from "../../../../../core/image";
import { refuseUnlessAdmin } from "../../../../../server/admin-context";
import { editFailed } from "../../../../../server/admin-event-edit";
import { invalidInput } from "../../../../../server/admin-events";
import { noStore, readJsonObject } from "../../../../../server/bookings";
import type { RouteHandler } from "../../../../../server/env";
import { errorResponse, json } from "../../../../../server/http";
import { decodeBase64, DEFAULT_MARK_SOURCE, loadLogoInfo, loadTheme, MAX_ICON_BYTES, parseIconSize, saveIcon } from "../../../../../server/settings";

// What the base64 of a PNG at the size's cap needs, plus the JSON around it with room to spare.
const base64Cap = (bytes: number): number => Math.ceil(bytes / 3) * 4;
const JSON_ROOM = 1024;

const tooLarge = (): Response => errorResponse(413, "too_large", "That icon is too large.", {}, noStore);
const stale = (code: "stale_theme" | "stale_logo", message: string): Response => errorResponse(409, code, message, {}, noStore);

const COLOUR = /^#[0-9a-f]{6}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Stores one app icon (32, 180 or 512 px), drawn by the browser from the logo on the theme's main colour. One icon
 * per request on purpose: each request gets its own CPU budget. The body is JSON, `{ data: <base64 PNG>, background,
 * logoSha256 }`, so the admin CSRF checks apply unchanged. The bytes must be a still PNG exactly as wide and tall as
 * the size in the URL; nothing the client says about the file is used. `background` must be the current main colour
 * and `logoSha256` the current logo (DEFAULT_MARK_SOURCE while there is no logo, for the icon drawn from the default
 * mark), so an icon from an out-of-date theme or logo is refused rather than stored.
 */
export const onRequestPut: RouteHandler<"size"> = async ({ request, env, params, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const size = parseIconSize(String(params.size ?? ""));
  if (size === null) return errorResponse(404, "not_found", "There is no icon of that size.", {}, noStore);
  const maxBase64 = base64Cap(MAX_ICON_BYTES[size]);
  const maxBody = maxBase64 + JSON_ROOM;
  if (Number(request.headers.get("Content-Length")) > maxBody) return tooLarge();
  const body = await readJsonObject(request, maxBody);
  if (body instanceof Response) return body.status === 413 ? tooLarge() : body;

  const fields: Record<string, string> = {};
  if (typeof body.data !== "string") fields.data = "Send the icon as a base64 PNG.";
  if (typeof body.background !== "string" || !COLOUR.test(body.background)) fields.background = "Send the background as a lower-case #rrggbb colour.";
  if (typeof body.logoSha256 !== "string" || !DIGEST.test(body.logoSha256)) fields.logoSha256 = "Send the logo's SHA-256 as 64 lower-case hex characters.";
  if (Object.keys(fields).length > 0) return invalidInput(fields);
  const { data: base64, background, logoSha256 } = body as { data: string; background: string; logoSha256: string };
  if (base64.length > maxBase64) return tooLarge();

  try {
    // The cheap reads come first, so an out-of-date request costs no decoding.
    if (background !== (await loadTheme(env.DB)).primary) {
      return stale("stale_theme", "The main colour has changed since that icon was drawn. Reload the page and try again.");
    }
    if (((await loadLogoInfo(env.DB))?.sha256 ?? DEFAULT_MARK_SOURCE) !== logoSha256) {
      return stale("stale_logo", "The logo has changed since that icon was drawn. Reload the page and try again.");
    }
    const bytes = decodeBase64(base64);
    if (!bytes) return invalidInput({ data: "The icon wasn't sent as standard base64. Reload the page and try again." });
    if (bytes.length > MAX_ICON_BYTES[size]) return tooLarge();
    const image = inspectImage(bytes);
    if (!image.ok) {
      if (image.reason === "too_large") return tooLarge();
      return errorResponse(422, "invalid_image", "That icon isn't a usable PNG.", { reason: image.reason }, noStore);
    }
    if (image.type !== "image/png") {
      return errorResponse(422, "invalid_image", "App icons must be PNG images.", { reason: "unsupported_type" }, noStore);
    }
    if (image.width !== size || image.height !== size) {
      return errorResponse(422, "invalid_image", `That icon must be exactly ${size} by ${size} pixels.`, { reason: "dimensions" }, noStore);
    }
    // The same conditions again inside the write, so a colour or logo change after the reads above can't slip an icon in.
    const sha256 = await saveIcon(env.DB, size, bytes, { background, logoSha256 });
    if (sha256 === null) {
      // Which one changed: read again, colour first as above. (A change back in between still reports the logo.)
      if (background !== (await loadTheme(env.DB)).primary) {
        return stale("stale_theme", "The main colour has changed since that icon was drawn. Reload the page and try again.");
      }
      return stale("stale_logo", "The logo has changed since that icon was drawn. Reload the page and try again.");
    }
    return json({ icon: { size, sha256, bytes: bytes.length, background, logoSha256 } }, 200, noStore);
  } catch (e) {
    return editFailed("saveIcon", e);
  }
};

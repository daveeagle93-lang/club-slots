import { noStore } from "./bookings";
import type { AppEnv } from "./env";
import { apiHeaders, errorResponse } from "./http";
import { hex, loadIcon, loadIconInfo, type IconInfo, type IconSize } from "./settings";

/** True if an If-None-Match header lists the tag (weak or strong) or is `*`. */
const matches = (header: string, etag: string): boolean =>
  header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*");

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The headers of an icon response. The pages link the icons without a version (`?v=`), so the lifetime is short,
 * and a stored icon is revalidated by its digest. The type is the constant PNG, never anything from the request.
 */
const iconHeaders = (sha256: string, bytes: number, cache: string): Headers =>
  new Headers({
    ...apiHeaders,
    "Content-Type": "image/png",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Length": String(bytes),
    ETag: `"${sha256}"`,
    "Cache-Control": cache,
  });

/** The bundled default icon (public/icons/default-<size>.png) through the static-asset binding, or null if it can't be had as a PNG. */
async function defaultIcon(request: Request, env: AppEnv, size: IconSize): Promise<Uint8Array | null> {
  try {
    const res = await env.ASSETS?.fetch(new Request(new URL(`/icons/default-${size}.png`, request.url)));
    if (!res || !res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The asset service could answer an unknown path with a page instead of a 404, so check what came back.
    return PNG_SIGNATURE.every((b, i) => bytes[i] === b) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Answers a GET or HEAD for one icon size: the stored PNG if there is one, otherwise the bundled default. It never
 * answers 404 for a real size, because a missing favicon is a console error on every page and a stored icon only
 * exists once a logo has been uploaded and the settings page has drawn it. A database failure also gets the
 * default (not cached), rather than an error. A conditional request and a HEAD are answered from the row's
 * metadata, without reading the image.
 */
export async function serveIcon(request: Request, env: AppEnv, size: IconSize): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", "Method not allowed.", {}, { ...noStore, Allow: "GET, HEAD" });
  }
  const head = request.method === "HEAD";
  const condition = request.headers.get("If-None-Match");
  let cache = "public, max-age=300";
  try {
    let info: IconInfo | null = null;
    let data: Uint8Array | null = null;
    if (condition !== null || head) info = await loadIconInfo(env.DB, size);
    else {
      const stored = await loadIcon(env.DB, size);
      info = stored?.info ?? null;
      data = stored?.data ?? null;
    }
    if (info) {
      const headers = iconHeaders(info.sha256, info.bytes, cache);
      if (condition !== null && matches(condition, `"${info.sha256}"`)) {
        headers.delete("Content-Length");
        return new Response(null, { status: 304, headers });
      }
      if (head) return new Response(null, { headers });
      if (data !== null) return new Response(data, { headers });
      // A conditional GET that didn't match reads the image now. The icon may have been replaced since the
      // metadata read, so the tag and length come from this read, which is where the bytes come from.
      const stored = await loadIcon(env.DB, size);
      if (stored) return new Response(stored.data, { headers: iconHeaders(stored.info.sha256, stored.info.bytes, cache) });
    }
  } catch (e) {
    console.error("serveIcon failed:", e instanceof Error ? e.message : String(e));
    cache = "no-store";
  }
  const bytes = await defaultIcon(request, env, size);
  if (!bytes) {
    console.error(`The default ${size}px icon could not be read from the static assets.`);
    return errorResponse(503, "icon_unavailable", "The icon isn't available right now.", {}, noStore);
  }
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const headers = iconHeaders(sha256, bytes.length, cache);
  if (condition !== null && matches(condition, `"${sha256}"`)) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(head ? null : bytes, { headers });
}

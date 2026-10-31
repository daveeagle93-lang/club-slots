import { noStore } from "../../server/bookings";
import type { RouteHandler } from "../../server/env";
import { apiHeaders, errorResponse } from "../../server/http";
import { loadLogo, loadLogoInfo, logoVersion } from "../../server/settings";

/** True if an If-None-Match header lists the tag (weak or strong) or is `*`. */
const matches = (header: string, etag: string): boolean =>
  header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*");

/** The `v` parameter only chooses the cache lifetime and is never echoed: the URL changes with the image, so the current one can be kept for a year. */
const headersFor = (request: Request, sha256: string): Headers =>
  new Headers({
    ...apiHeaders,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    ETag: `"${sha256}"`,
    "Cache-Control": new URL(request.url).searchParams.get("v") === logoVersion(sha256)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300",
  });

/**
 * The club logo, from the database. Only the stored, allow-listed type is served (never what the uploader
 * claimed), with headers that stop a browser sniffing it into anything else or running it as a page.
 */
export const onRequest: RouteHandler = async ({ request, env }) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", "Method not allowed.", {}, { ...noStore, Allow: "GET, HEAD" });
  }
  const condition = request.headers.get("If-None-Match");
  // No logo is cached briefly too: pages ask on every load, and a new upload is picked up within minutes.
  const notFound = () => errorResponse(404, "not_found", "There is no logo.", {}, { "Cache-Control": "public, max-age=300" });
  const typed = (info: { sha256: string; contentType: string; bytes: number }): Headers => {
    const headers = headersFor(request, info.sha256);
    headers.set("Content-Type", info.contentType);
    headers.set("Content-Length", String(info.bytes));
    return headers;
  };
  if (condition !== null || request.method === "HEAD") {
    // A revalidation or a HEAD is answered from the row's metadata, without reading the image.
    const info = await loadLogoInfo(env.DB);
    if (!info) return notFound();
    if (condition !== null && matches(condition, `"${info.sha256}"`)) return new Response(null, { status: 304, headers: headersFor(request, info.sha256) });
    if (request.method === "HEAD") return new Response(null, { headers: typed(info) });
  }
  const logo = await loadLogo(env.DB);
  if (!logo) return notFound();
  return new Response(logo.data, { headers: typed(logo.info) });
};

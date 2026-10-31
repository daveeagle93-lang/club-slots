import { DEFAULT_THEME, themeCss } from "../../../public/theme.js";
import { noStore } from "../../server/bookings";
import type { RouteHandler } from "../../server/env";
import { apiHeaders, errorResponse } from "../../server/http";
import { hex, loadTheme } from "../../server/settings";

/** True if an If-None-Match header lists the tag (weak or strong) or is `*`. */
const matches = (header: string, etag: string): boolean =>
  header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*");

const headers = (): Headers => new Headers({ ...apiHeaders, "Content-Type": "text/css; charset=utf-8" });

/**
 * The club's colour variables as a stylesheet. The body comes only from themeCss, which accepts nothing but
 * validated hex colours, and the query string (the admin page adds ?v= to bust caches) is never read. Every page
 * loads this, so a database failure answers the default colours rather than breaking the page.
 */
export const onRequest: RouteHandler = async ({ request, env }) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", "Method not allowed.", {}, { ...noStore, Allow: "GET, HEAD" });
  }
  let css: string;
  try {
    css = themeCss(await loadTheme(env.DB));
  } catch (e) {
    console.error("loadTheme failed:", e instanceof Error ? e.message : String(e));
    const h = headers();
    h.set("Cache-Control", "no-store");
    return new Response(request.method === "HEAD" ? null : themeCss(DEFAULT_THEME), { headers: h });
  }
  const etag = `"${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(css)))}"`;
  const h = headers();
  // A minute is the longest a saved colour change can lag. The admin page adds ?v= after saving, so it sees its own change at once.
  h.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  h.set("ETag", etag);
  const condition = request.headers.get("If-None-Match");
  if (condition !== null && matches(condition, etag)) return new Response(null, { status: 304, headers: h });
  return new Response(request.method === "HEAD" ? null : css, { headers: h });
};

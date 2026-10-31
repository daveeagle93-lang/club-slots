import { DEFAULT_CLUB } from "../../../public/branding.js";
import { DEFAULT_THEME } from "../../../public/theme.js";
import { noStore } from "../../server/bookings";
import type { RouteHandler } from "../../server/env";
import { apiHeaders, errorResponse } from "../../server/http";
import { loadSettings, loadTheme } from "../../server/settings";

const SHORT_NAME_CLUSTERS = 12;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The web app manifest: a name, a start page, and the app icons from /api/icon. Built only with JSON.stringify
 * from the club name and a validated colour, so nothing the admin typed can break out of the JSON. The icons are
 * not declared maskable: they have a small margin, not the large safe zone a maskable icon needs.
 * `?for=admin` (exactly) makes the app open the admin pages; any other query gives the public start page.
 */
const manifest = (clubName: string, primary: string, startUrl: string): string => {
  const name = clubName || DEFAULT_CLUB;
  return JSON.stringify({
    name,
    // User-perceived characters, so a flag or an accented letter is never cut in half.
    short_name: [...graphemes.segment(name)].slice(0, SHORT_NAME_CLUSTERS).map((g) => g.segment).join(""),
    start_url: startUrl,
    scope: "/",
    display: "standalone",
    theme_color: primary,
    background_color: "#ffffff",
    icons: [
      { src: "/api/icon/180", sizes: "180x180", type: "image/png" },
      { src: "/api/icon/512", sizes: "512x512", type: "image/png" },
    ],
  });
};

export const onRequest: RouteHandler = async ({ request, env }) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed", "Method not allowed.", {}, { ...noStore, Allow: "GET, HEAD" });
  }
  const startUrl = new URL(request.url).search === "?for=admin" ? "/admin/" : "/";
  // Five minutes, like the icons it points at: pages ask on every load and a changed name or colour can wait.
  const headers = new Headers({ ...apiHeaders, "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=300" });
  let body: string;
  try {
    const [settings, theme] = await Promise.all([loadSettings(env.DB), loadTheme(env.DB)]);
    body = manifest(settings.clubName, theme.primary, startUrl);
  } catch (e) {
    // A manifest that fails is an error in every page's console; the defaults are served, and not cached.
    console.error("manifest failed:", e instanceof Error ? e.message : String(e));
    headers.set("Cache-Control", "no-store");
    body = manifest("", DEFAULT_THEME.primary, startUrl);
  }
  return new Response(request.method === "HEAD" ? null : body, { headers });
};

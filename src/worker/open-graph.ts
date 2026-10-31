import { formatPounds } from "../core/format";
import { utcToLondon } from "../core/london";
import { eventSummary, loadEventBySlug } from "../server/events";
import { loadPublicSettings, type PublicSettings } from "../server/settings";
import { DEFAULT_CLUB, pageTitle } from "../../public/branding.js";

/**
 * Link previews (WhatsApp and the like) read the first HTML they are served and run no scripts, so the title and Open Graph
 * tags for "/" and "/e/<slug>" are written into the static page here. Only what GET /api/events/<slug> and /api/settings
 * already say publicly is used: the event's name, date, venue postcode and cost, and the club name. Never the details text,
 * ids, breaks, bookings, the listed flag or the privacy contact.
 *
 * An unknown, invalid or archived slug gets the generic tags, and the page is byte-identical for all of them (the og:url is
 * the site's front page, not the requested path), so the preview leaks nothing about which slugs exist beyond that API.
 *
 * The page is edited as text, not with HTMLRewriter: that is only in workerd, and the tests run in Node. The two places it
 * edits (the one <title>, and </head>) are checked, and a page that lacks either is served unchanged.
 */

export interface Tags {
  /** The <title>: what public/branding.js will set document.title to, so there is no flash when it runs. */
  title: string;
  ogTitle: string;
  description: string;
  siteName: string | null;
  /** Absolute. */
  url: string;
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat 13 Jun 2026": the London date of an instant, whatever the host's time zone. */
export function formatLondonDate(iso: string): string {
  const [year, month, day] = utcToLondon(iso).date.split("-").map(Number);
  return `${DAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${day} ${MONTHS[month - 1]} ${year}`;
}

const generalDescription = (club: string | null): string =>
  club ? `Book a slot at ${club}'s upcoming events.` : "Book a slot at upcoming events.";

function landingTags(settings: PublicSettings | null, origin: string): Tags {
  const club = settings?.clubName ?? null;
  return { title: pageTitle(null, club), ogTitle: club ?? DEFAULT_CLUB, description: generalDescription(club), siteName: club, url: `${origin}/` };
}

/** The event page with nothing known about the event: what the page shows until its script finds the event (or "not found"). */
function genericEventTags(settings: PublicSettings | null, origin: string): Tags {
  return { ...landingTags(settings, origin), title: pageTitle("Book a slot", settings?.clubName ?? null) };
}

function eventTags(event: ReturnType<typeof eventSummary>, settings: PublicSettings, origin: string): Tags {
  const club = settings.clubName;
  return {
    title: pageTitle(event.name, club),
    ogTitle: `${event.name} · ${formatLondonDate(event.startUtc)}`,
    description: [club, event.venuePostcode, formatPounds(event.costPence)].filter(Boolean).join(" · "),
    siteName: club,
    url: `${origin}/e/${event.slug}`, // the stored slug, not the request path: an encoded spelling is not echoed
  };
}

/** The tags for a page. Never throws: if the database can't be read the generic tags are used and only the message is logged (an error object can carry SQL and bound values). */
export async function loadTags(db: D1Database | undefined, slug: string | null, origin: string): Promise<Tags> {
  try {
    const [event, settings] = await Promise.all([slug === null ? null : loadEventBySlug(db!, slug), loadPublicSettings(db!)]);
    if (slug === null) return landingTags(settings, origin);
    if (event && !event.archived) return eventTags(eventSummary(event), settings, origin);
    return genericEventTags(settings, origin);
  } catch (e) {
    console.error("Open Graph tags unavailable, using the generic ones:", e instanceof Error ? e.message : "unknown error");
    return slug === null ? landingTags(null, origin) : genericEventTags(null, origin);
  }
}

const TITLE = /<title>[^<]*<\/title>/g;
const HEAD_END = "</head>";

/** The page with its <title> replaced and the Open Graph tags added at the end of <head>, or null if the page is not shaped as expected. Every value is escaped. */
export function injectTags(html: string, tags: Tags, origin: string): string | null {
  if (html.split(HEAD_END).length !== 2 || (html.match(TITLE)?.length ?? 0) !== 1) return null;
  const meta = (attribute: "property" | "name", key: string, value: string) => `<meta ${attribute}="${key}" content="${escapeHtml(value)}" />`;
  const lines = [
    meta("property", "og:type", "website"),
    ...(tags.siteName ? [meta("property", "og:site_name", tags.siteName)] : []),
    meta("property", "og:title", tags.ogTitle),
    meta("property", "og:description", tags.description),
    meta("property", "og:url", tags.url),
    meta("property", "og:image", `${origin}/api/icon/512`),
    meta("property", "og:image:type", "image/png"),
    meta("property", "og:image:width", "512"),
    meta("property", "og:image:height", "512"),
    meta("name", "twitter:card", "summary"),
  ];
  // Function replacements: a string would have its $& and $1 read as patterns.
  return html
    .replace(TITLE, () => `<title>${escapeHtml(tags.title)}</title>`)
    .replace(HEAD_END, () => `  ${lines.join("\n    ")}\n  ${HEAD_END}`);
}

/**
 * A static page with its tags injected. The asset is asked for without the visitor's conditional or range headers (its ETag
 * and a 304 are for the file, not for this body, which changes with the database), and the answer carries no ETag. A HEAD
 * request gets the headers only, without reading the database. An asset answer that is not a 200 is passed on as it is.
 */
export async function serveWithTags(fetcher: Fetcher, db: D1Database | undefined, request: Request, assetPath: string, slug: string | null): Promise<Response> {
  const { origin } = new URL(request.url);
  const headers = new Headers();
  for (const name of ["Accept", "Accept-Language"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const head = request.method === "HEAD";
  const [asset, tags] = await Promise.all([
    fetcher.fetch(new Request(new URL(assetPath, request.url), { method: head ? "HEAD" : "GET", headers })),
    head ? null : loadTags(db, slug, origin),
  ]);
  if (!asset.ok) return asset;
  const responseHeaders = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" };
  if (tags === null) return new Response(null, { status: 200, headers: responseHeaders });
  const html = await asset.text();
  return new Response(injectTags(html, tags, origin) ?? html, { status: 200, headers: responseHeaders });
}

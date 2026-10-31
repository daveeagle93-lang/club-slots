// Club branding shared by every page: the header band with the logo and club name, the page title and the
// website footer. All text goes through textContent / setAttribute; nothing here ever parses HTML.

export const DEFAULT_CLUB = "Slot booker";

/**
 * Exactly the shape the server builds (logoUrl in src/server/settings.ts). A looser "starts with one slash" test
 * lets "/\t/evil.example" through, because URL parsers strip tabs and newlines and read it as "//evil.example".
 */
export const isLogoUrl = (url) => typeof url === "string" && /^\/api\/logo\?v=[0-9a-f]{16}$/.test(url);

const NONE = { clubName: null, website: null, privacyContact: null, logo: null };

const text = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);
const dimension = (v) => (Number.isInteger(v) && v > 0 && v <= 10000 ? v : null);

/** Keeps only well-formed parts of the response, so a surprise from the server can't reach the page. */
function clean(data) {
  const c = data?.privacyContact;
  const l = data?.logo;
  return {
    clubName: text(data?.clubName),
    website: text(data?.website),
    privacyContact: text(c?.email) ? { name: typeof c.name === "string" ? c.name : "", email: c.email } : null,
    logo: isLogoUrl(l?.url) && dimension(l.width) && dimension(l.height)
      ? { url: l.url, width: l.width, height: l.height }
      : null,
  };
}

/**
 * The public settings. Never throws: a network, HTTP or JSON failure gives the all-null defaults with
 * `loaded: false`, so a caller can tell "nothing set" from "couldn't ask" (the privacy-contact warning needs to).
 */
export async function loadSettings(fetch) {
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return { ...NONE, loaded: false };
    return { ...clean(await res.json()), loaded: true };
  } catch {
    return { ...NONE, loaded: false };
  }
}

/** The club name where one must be shown. */
export const clubOrDefault = (settings) => settings?.clubName ?? DEFAULT_CLUB;

/** "<page> – <club>", or just the page when no club name is set; the club alone (or the default) with no page. */
export function pageTitle(page, clubName) {
  if (!page) return clubName ?? DEFAULT_CLUB;
  return clubName ? `${page} – ${clubName}` : page;
}

/** The website as an https URL, or null: the setting is checked again here rather than trusted. */
export function safeWebsite(website) {
  try {
    const url = new URL(website);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function el(document, tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

/**
 * Adds the header band at the start of <body> (above the admin navigation and <main>), sets the title, and adds the website footer when there is one.
 * `home` is where the club name links to; `pageTitle` may be null for the club name alone. Call once per page.
 */
export function applyBranding(document, settings, { pageTitle: page, home }) {
  const s = settings ?? NONE;
  const header = el(document, "header", { class: "site-header" });
  // Empty alt: the club name sits right next to the logo, so a screen reader would only repeat it.
  if (s.logo) {
    header.append(el(document, "img", {
      class: "site-logo", src: s.logo.url, width: String(s.logo.width), height: String(s.logo.height), alt: "",
    }));
  }
  header.append(el(document, "a", { href: home }, clubOrDefault(s)));
  document.body.prepend(header);

  document.title = pageTitle(page, s.clubName);

  const site = s.website ? safeWebsite(s.website) : null;
  if (site) {
    document.body.append(el(document, "footer", { class: "site-footer" },
      el(document, "a", { href: site.href, target: "_blank", rel: "noopener noreferrer" }, site.hostname)));
  }
}

/**
 * Brands a page once its settings (a promise or a value) arrive, and resolves to them. Never rejects, so a page
 * can wait on it without a failed settings request ever stopping the page.
 */
export async function brandPage(document, settings, options) {
  let s = null;
  try {
    s = await settings;
    applyBranding(document, s, options);
  } catch {
    s = null;
  }
  return s;
}

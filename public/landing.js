import { brandPage, loadSettings } from "./branding.js";
import { formatDate, formatTimeRange, isBookingPath } from "./lib.js";

/**
 * Wires the landing page into `#app`: the events open for booking. `settings` is the branding promise (see
 * branding.js), which adds the header band with the club name; without it the page has no band. Resolves once the
 * first load has settled.
 */
export async function init({ document, fetch, settings = null }) {
  const root = document.getElementById("app");
  const branded = settings ? brandPage(document, settings, { pageTitle: null, home: "/" }) : Promise.resolve(null);

  // All text goes through textContent; nothing here ever parses HTML.
  const h = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    node.append(...children);
    return node;
  };
  const show = (...nodes) => root.replaceChildren(...nodes);

  // Only events with a slug the booking page accepts, and times that can be shown, become links.
  const usable = (e) => typeof e?.slug === "string" && isBookingPath(`/e/${e.slug}`) && typeof e.name === "string"
    && Number.isFinite(Date.parse(e.startUtc)) && Number.isFinite(Date.parse(e.endUtc));

  async function fetchEvents() {
    try {
      const res = await fetch("/api/events", { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      return Array.isArray(data?.events) ? data.events.filter(usable) : null;
    } catch {
      return null;
    }
  }

  async function load() {
    show(h("p", { class: "message", role: "status" }, "Loading…"));
    // The header band already carries the club name and logo, so the heading says what the page is for.
    const [, events] = await Promise.all([branded, fetchEvents()]);
    const heading = h("h1", {}, "Upcoming events");
    if (!events) {
      const retry = h("button", { type: "button", class: "button" }, "Retry");
      retry.addEventListener("click", load);
      return show(heading, h("div", { class: "message", role: "alert" },
        h("p", {}, "We couldn't load the events. Check your connection and try again."), retry));
    }
    if (events.length === 0) {
      return show(heading, h("p", { class: "message", role: "status" }, "No events are open for booking right now."));
    }
    show(heading, h("ul", { class: "event-links" }, ...events.map((e) =>
      h("li", {}, h("a", { class: "event-link", href: `/e/${e.slug}` },
        h("span", { class: "event-link-name" }, e.name),
        h("span", { class: "event-link-when" }, `${formatDate(e.startUtc)}, ${formatTimeRange(e.startUtc, e.endUtc)}`))))));
  }

  return load();
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  const fetchPage = (...args) => fetch(...args);
  init({ document, fetch: fetchPage, settings: loadSettings(fetchPage) });
}

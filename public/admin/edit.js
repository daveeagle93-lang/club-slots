import { brandPage, loadSettings } from "../branding.js";
import { isBookingPath } from "../lib.js";
import { createApi, makeH, writeClipboard } from "./api.js";
import { bookingLine, mountEventForm } from "./event-form.js";

const SLUG = /^[A-Za-z0-9_-]{16,64}$/;

/** Wires the edit-event page (`/admin/edit?slug=...`) into `#app`. Resolves once the first load has settled. */
export async function init({ document, fetch, navigate, clipboard, location }) {
  const root = document.getElementById("app");
  const api = createApi({ fetch, navigate });
  const h = makeH(document);

  const show = (...nodes) => root.replaceChildren(...nodes);
  const back = () => h("a", { class: "button", href: "/admin/" }, "Back to events");
  const notFound = () => show(h("div", { class: "message", role: "alert" },
    h("p", {}, "We couldn't find that event. It may have been removed, or the link may be wrong."), back()));
  const failure = (retry) => {
    const button = h("button", { type: "button", class: "button" }, "Retry");
    button.addEventListener("click", retry);
    show(h("div", { class: "message", role: "alert" }, h("p", {}, "We couldn't load the event. Check your connection and try again."), button));
  };

  try {
    if (!(await api.loadSession())) return;
  } catch {
    show(h("div", { class: "message", role: "alert" },
      h("p", {}, "We couldn't check that you're signed in. Check your connection and reload the page.")));
    return;
  }

  const slug = new URLSearchParams(location.search).get("slug") ?? "";
  if (!SLUG.test(slug)) return notFound();

  // The labels of the fields that identify a booking, as the event had them when this page loaded it: the bookings the server lists
  // carry the labels they had before the save, which may rename a field.
  let identityLabels = null;

  async function load() {
    show(h("p", { class: "message", role: "status" }, "Loading the event…"));
    let res;
    try {
      res = await api.request("GET", `/api/admin/events/${encodeURIComponent(slug)}`);
    } catch {
      return failure(load);
    }
    if (res.status === 401) return;
    if (res.status === 404) return notFound();
    if (res.status !== 200 || !res.data?.event) return failure(load);
    identityLabels = Array.isArray(res.data.event.fields) ? new Set(res.data.event.fields.filter((f) => f.identity).map((f) => f.label)) : null;
    mountEventForm({
      document, root, api, h, mode: "edit", slug, initial: res.data.event,
      done: ({ data, confirmed }) => showSaved(data, confirmed),
      reload: load,
    });
  }

  /**
   * `confirmed` is the list the admin was shown and agreed to. It is merged with what the server says it
   * removed, because a retry of a save whose response was lost finds nothing left to remove and answers
   * `removed: []`: the people still need telling, so the list must not depend on the last response alone.
   * But a confirmed booking the server did not remove may instead have been moved elsewhere meanwhile, so
   * the event is fetched again and anyone who still has a booking is left off the list.
   */
  async function showSaved({ event, removed }, confirmed) {
    const gone = new Set((removed ?? []).map((b) => b.id));
    let fallback = confirmed.filter((b) => !gone.has(b.id));
    let notice = "";
    if (fallback.length > 0) {
      let res = null;
      try { res = await api.request("GET", `/api/admin/events/${encodeURIComponent(slug)}`); } catch { /* reported below */ }
      if (res?.status === 200 && Array.isArray(res.data?.slots) && Array.isArray(res.data?.orphans)) {
        const present = new Set([
          ...res.data.slots.flatMap((s) => (s.places ?? []).flatMap((p) => p.bookings.map((x) => x.id))),
          ...res.data.orphans.map((o) => o.id),
        ]);
        fallback = fallback.filter((b) => !present.has(b.id));
      } else {
        fallback = [];
        notice = "Couldn't check who still has a booking; check the schedule.";
      }
    }
    const byId = new Map([...fallback, ...(removed ?? [])].map((b) => [b.id, b]));
    const bookings = [...byId.values()].sort((a, b) => (a.slotStart < b.slotStart ? -1 : a.slotStart > b.slotStart ? 1 : a.id - b.id));
    const heading = h("h1", { tabindex: "-1" }, "Saved.");
    const children = [heading, h("p", { class: "event-name" }, event.name)];
    if (notice) children.push(h("p", { class: "note", role: "alert" }, notice));
    if (bookings.length > 0) {
      const copyStatus = h("p", { class: "copy-status", "aria-live": "polite" });
      const block = h("textarea", { id: "rebook-text", readonly: true, rows: String(Math.min(bookings.length + 1, 12)) });
      // Pasted into a club chat: who each booking is for (the identity fields) and nothing else, not a phone number or notes.
      block.value = bookings.map((b) => `Please rebook: ${bookingLine(b, identityLabels)}`).join("\n");
      const copy = h("button", { type: "button", class: "button" }, "Copy list");
      let timer;
      copy.addEventListener("click", async () => {
        clearTimeout(timer);
        if (await writeClipboard(clipboard, block.value)) {
          copyStatus.textContent = "Copied";
          timer = setTimeout(() => { copyStatus.textContent = ""; }, 2000);
        } else {
          block.focus();
          block.select();
          copyStatus.textContent = "Couldn't copy automatically. Copy the selected text manually.";
        }
      });
      children.push(h("section", { class: "removed" },
        h("h2", {}, "Removed bookings: tell these people to rebook"),
        h("div", { class: "field" }, h("label", { for: "rebook-text" }, "Message"), block),
        h("div", { class: "actions" }, copy), copyStatus));
    }
    const links = [back()];
    if (isBookingPath(`/e/${event.slug}`)) links.push(h("a", { class: "button", href: `/e/${event.slug}` }, "Open the booking page"));
    children.push(h("div", { class: "actions" }, ...links));
    show(h("section", { class: "created" }, ...children));
    heading.focus();
  }

  return load();
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  brandPage(document, loadSettings((...args) => fetch(...args)), { pageTitle: document.title, home: "/admin/" });
  init({
    document, location, clipboard: navigator.clipboard,
    fetch: (...args) => fetch(...args),
    navigate: (url) => location.assign(url),
  });
}

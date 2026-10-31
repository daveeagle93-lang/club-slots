import { brandPage, loadSettings } from "../branding.js";
import { formatDate, formatTimeRange, isBookingPath } from "../lib.js";
import { buildShareMessage, pickShareTemplate } from "../share-message.js";
import { createApi, makeH, writeClipboard } from "./api.js";
import { shareControls } from "./share.js";

const OFFLINE = "We couldn't reach the server. Check your connection and try again.";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const eventUrl = (slug) => `/api/admin/events/${encodeURIComponent(slug)}`;
const linkable = (slug) => isBookingPath(`/e/${slug}`);

/**
 * Wires the events page into `#app`: Upcoming events, and collapsed Past and Archived sections, with archive,
 * permanent delete (typed event name) and a bulk clear-out of Past (typed DELETE). The server enforces both
 * confirmations; the page only makes them hard to do by accident. Event names are user input: text nodes only.
 * Upcoming events have a Share control (past and archived events' links are closed, so they have none); `settings`
 * is the branding promise (see branding.js), whose club name heads the shared message once it has loaded.
 * Resolves once the first load has settled.
 */
export async function init({ document, fetch, navigate, clipboard, location, navigator = undefined, settings = null }) {
  const root = document.getElementById("app");
  const api = createApi({ fetch, navigate });
  const h = makeH(document);

  // Not awaited: the list must not wait for the settings. They are long settled by the time Share is tapped.
  let clubName = "";
  settings?.then((s) => { if (s?.loaded) clubName = s.clubName ?? ""; }, () => {});

  const show = (...nodes) => root.replaceChildren(...nodes);
  let session = null;
  let data = { events: [], past: [], archived: [], pastHasMore: false, archivedHasMore: false, defaultShareMessage: "" };
  const selected = new Set(); // slugs ticked in Past
  const expanded = { past: false, archived: false };
  let busy = false;
  let panel = null; // the open confirmation: { kind: "delete" | "bulk", node }
  let syncPanel = null;
  let ids = 0;
  // One live region for every result; it outlives re-renders so screen readers hear each change.
  const live = h("p", { class: "list-status", "aria-live": "polite", tabindex: "-1" });
  const say = (text) => { live.textContent = text; };
  const status = (text) => show(h("p", { class: "message", role: "status" }, text));
  const failure = (text) => {
    const retry = h("button", { type: "button", class: "button" }, "Retry");
    retry.addEventListener("click", load);
    show(h("div", { class: "message", role: "alert" }, h("p", {}, text), retry));
  };

  async function load() {
    status("Loading events…");
    let res;
    try {
      session = await api.loadSession();
      if (!session) return;
      res = await api.request("GET", "/api/admin/events");
    } catch {
      return failure("We couldn't load your events. Check your connection and try again.");
    }
    if (res.status === 401) return;
    if (res.status !== 200 || !Array.isArray(res.data?.events)) {
      return failure("We couldn't load your events. Try again.");
    }
    data = normalise(res.data);
    render();
  }

  const normalise = (d) => ({
    events: d.events,
    past: Array.isArray(d.past) ? d.past : [],
    archived: Array.isArray(d.archived) ? d.archived : [],
    pastHasMore: d.pastHasMore === true,
    archivedHasMore: d.archivedHasMore === true,
    defaultShareMessage: typeof d.defaultShareMessage === "string" ? d.defaultShareMessage : "",
  });

  function setBusy(on) {
    busy = on;
    for (const el of root.querySelectorAll("button, input")) el.disabled = on;
    if (!on) syncControls();
  }

  /** Re-applies the disabled state that depends on more than "busy": the open panel and the selection. */
  function syncControls() {
    const bulkOpen = panel?.kind === "bulk";
    for (const el of root.querySelectorAll("[data-select]")) el.disabled = bulkOpen;
    const bulk = root.querySelector("[data-bulk]");
    if (bulk) {
      bulk.textContent = `Delete selected (${selected.size})`;
      bulk.disabled = selected.size === 0 || bulkOpen;
    }
    syncPanel?.();
  }

  function closePanel() {
    panel?.node.remove();
    panel = null;
    syncPanel = null;
    syncControls();
  }

  /**
   * One request at a time. `done(data)` gives what to announce on success, after which the list is fetched
   * again; `rejected(res)` may handle a refusal inline (and return true); `error(text)` shows any other failure
   * where the action was started, and the button is enabled again so it can be retried.
   */
  async function perform(method, url, body, { done, rejected, error = say }) {
    if (busy) return;
    setBusy(true);
    let res;
    try {
      res = await api.request(method, url, body);
    } catch {
      setBusy(false);
      return error(OFFLINE);
    }
    if (res.status === 401) { setBusy(false); return; }
    if (res.status >= 200 && res.status < 300) return refresh(done(res.data));
    setBusy(false);
    if (rejected?.(res)) return;
    if (res.status === 404) return refresh("That event no longer exists. The list has been refreshed.");
    error(res.data?.error?.message ?? "Something went wrong. Try again.");
  }

  async function refresh(message) {
    setBusy(true);
    let res = null;
    try { res = await api.request("GET", "/api/admin/events"); } catch { /* reported below */ }
    if (res?.status === 401) { setBusy(false); return; }
    panel = null;
    syncPanel = null;
    if (res?.status === 200 && Array.isArray(res.data?.events)) {
      data = normalise(res.data);
      for (const slug of [...selected]) if (!data.past.some((e) => e.slug === slug)) selected.delete(slug);
      busy = false;
      render();
      say(message);
      live.focus();
    } else {
      render();
      busy = false;
      say(`${message} We couldn't refresh the list, so reload the page to see it.`);
    }
  }

  function render() {
    const signOutError = h("p", { class: "form-error", role: "alert" });
    const signOut = h("button", { type: "button", class: "button" }, "Sign out");
    signOut.addEventListener("click", async () => {
      signOut.disabled = true;
      signOutError.textContent = "";
      try {
        await api.logout();
      } catch {
        signOutError.textContent = "We couldn't sign you out. Try again.";
      }
      signOut.disabled = false;
    });
    show(
      h("header", { class: "admin-bar" },
        h("p", { class: "signed-in" }, "Signed in as ", h("strong", {}, session.identity)),
        signOut),
      signOutError,
      h("h1", {}, "Upcoming events"),
      h("a", { class: "button primary big", href: "/admin/new" }, "Create event"),
      live,
      data.events.length === 0
        ? h("p", { class: "message", role: "status" }, "No upcoming events yet.")
        : h("ul", { class: "event-list" }, ...data.events.map(card)),
      pastSection(),
      archivedSection());
    syncControls();
  }

  function section(key, title, hasMore, ...content) {
    const details = h("details", { class: "older-section", open: expanded[key] },
      h("summary", {}, `${title} (${data[key].length}${hasMore ? "+" : ""})`), ...content);
    details.addEventListener("toggle", () => { expanded[key] = details.open; });
    return details;
  }

  const moreNote = (title) => h("p", { class: "note" },
    `…and more. Only the 100 most recent ${title} events are shown; delete or archive some to see the rest.`);

  function pastSection() {
    const list = data.past;
    if (list.length === 0) return section("past", "Past", false, h("p", { class: "message" }, "No past events."));
    const all = h("input", { type: "checkbox", "data-select": true });
    all.checked = selected.size === list.length;
    all.addEventListener("change", () => {
      if (all.checked) for (const e of list) selected.add(e.slug); else selected.clear();
      for (const box of root.querySelectorAll("[data-pick]")) box.checked = all.checked;
      syncControls();
    });
    const bulk = h("button", { type: "button", class: "button danger", "data-bulk": true }, "Delete selected (0)");
    bulk.addEventListener("click", () => {
      if (busy || selected.size === 0) return;
      closePanel();
      const node = bulkPanel(list.filter((e) => selected.has(e.slug)));
      bar.after(node);
      panel = { kind: "bulk", node };
      syncControls();
      node.querySelector("[data-autofocus]").focus();
    });
    const bar = h("div", { class: "bulk-bar" }, h("label", { class: "select-all" }, all, " Select all"), bulk);
    return section("past", "Past", data.pastHasMore, bar,
      h("ul", { class: "event-list" }, ...list.map((e) => olderRow(e, "past"))),
      ...(data.pastHasMore ? [moreNote("past")] : []));
  }

  function archivedSection() {
    const list = data.archived;
    if (list.length === 0) return section("archived", "Archived", false, h("p", { class: "message" }, "No archived events."));
    return section("archived", "Archived", data.archivedHasMore,
      h("ul", { class: "event-list" }, ...list.map((e) => olderRow(e, "archived"))),
      ...(data.archivedHasMore ? [moreNote("archived")] : []));
  }

  function olderRow(ev, kind) {
    const li = h("li", { class: "event-card older" });
    const heading = h("h3", {}, ev.name);
    if (kind === "past" && linkable(ev.slug)) {
      const box = h("input", { type: "checkbox", "aria-label": `Select ${ev.name}`, "data-select": true, "data-pick": true });
      box.checked = selected.has(ev.slug);
      box.addEventListener("change", () => {
        if (box.checked) selected.add(ev.slug); else selected.delete(ev.slug);
        const all = root.querySelector(".select-all input");
        if (all) all.checked = selected.size === data.past.length;
        syncControls();
      });
      li.append(h("div", { class: "pick-row" }, h("label", { class: "pick" }, box), heading));
    } else {
      li.append(heading);
    }
    li.append(
      h("p", { class: "when" }, `${formatDate(ev.startUtc)}, ${formatTimeRange(ev.startUtc, ev.endUtc)}`),
      h("p", { class: "booked" }, plural(ev.bookedCount, "booking")));
    if (linkable(ev.slug)) {
      const buttons = kind === "past"
        ? [h("a", { class: "button", href: `/admin/schedule?slug=${encodeURIComponent(ev.slug)}` }, "Schedule"), archiveButton(ev, true)]
        : [archiveButton(ev, false)];
      li.append(h("div", { class: "manage" }, ...buttons, deleteButton(ev, li)));
    }
    return li;
  }

  function archiveButton(ev, archived) {
    const label = archived ? "Archive" : "Unarchive";
    const button = h("button", { type: "button", class: "button", "aria-label": `${label} ${ev.name}` }, label);
    button.addEventListener("click", () => perform("POST", `${eventUrl(ev.slug)}/archive`, { archived }, {
      done: () => `${archived ? "Archived" : "Unarchived"} ${ev.name}.`,
      error: (text) => say(`We couldn't ${label.toLowerCase()} ${ev.name}. ${text}`),
    }));
    return button;
  }

  function deleteButton(ev, host) {
    const button = h("button", { type: "button", class: "button", "aria-label": `Delete ${ev.name}` }, "Delete…");
    button.addEventListener("click", () => {
      if (busy) return;
      closePanel();
      const node = deletePanel(ev, () => { closePanel(); button.focus(); });
      host.append(node);
      panel = { kind: "delete", node };
      syncControls();
      node.querySelector("[data-autofocus]").focus();
    });
    return button;
  }

  /** The typed-name confirmation for one event. The button stays disabled until the trimmed text matches exactly. */
  function deletePanel(ev, cancel) {
    const id = `confirm-${++ids}`;
    const input = h("input", { id, type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-describedby": `${id}-hint`, "data-autofocus": true });
    const error = h("p", { class: "form-error", role: "alert" });
    const confirmButton = h("button", { type: "button", class: "button danger" }, "Delete event");
    const cancelButton = h("button", { type: "button", class: "button" }, "Cancel");
    cancelButton.addEventListener("click", () => { if (!busy) cancel(); });
    syncPanel = () => { confirmButton.disabled = busy || input.value.trim() !== ev.name; };
    input.addEventListener("input", () => { error.textContent = ""; syncPanel(); });
    confirmButton.addEventListener("click", () => {
      if (busy || input.value.trim() !== ev.name) return;
      error.textContent = "";
      perform("DELETE", eventUrl(ev.slug), { confirmName: input.value.trim() }, {
        done: (d) => `Deleted ${d.deleted.name} and ${plural(d.deleted.bookings, "booking")}.`,
        rejected: (res) => {
          if (res.status !== 400 || res.data?.error?.code !== "confirmation_mismatch") return false;
          error.textContent = res.data.error.message;
          input.focus();
          return true;
        },
        error: (text) => { error.textContent = text; },
      });
    });
    syncPanel();
    return h("div", { class: "confirm", role: "group", "aria-label": `Delete ${ev.name}` },
      h("p", {}, "This permanently deletes ", h("strong", { class: "name-exact" }, ev.name), ` and its ${plural(ev.bookedCount, "booking")}. This can't be undone.`),
      error,
      h("div", { class: "field" }, h("label", { for: id }, "Type the event name to confirm"), input,
        h("p", { class: "note", id: `${id}-hint` }, "Type it exactly as shown, including capital letters and spaces.")),
      h("div", { class: "actions" }, confirmButton, cancelButton));
  }

  /** The typed-DELETE confirmation for the ticked past events: names, the total of bookings, then the request. */
  function bulkPanel(chosen) {
    const id = `confirm-${++ids}`;
    const total = chosen.reduce((sum, e) => sum + e.bookedCount, 0);
    const names = new Map(chosen.map((e) => [e.slug, e.name]));
    const input = h("input", { id, type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "data-autofocus": true });
    const error = h("p", { class: "form-error", role: "alert" });
    const confirmButton = h("button", { type: "button", class: "button danger" }, "Delete events");
    const cancelButton = h("button", { type: "button", class: "button" }, "Cancel");
    cancelButton.addEventListener("click", () => {
      if (busy) return;
      closePanel();
      root.querySelector("[data-bulk]")?.focus();
    });
    syncPanel = () => { confirmButton.disabled = busy || input.value.trim() !== "DELETE"; };
    input.addEventListener("input", () => { error.textContent = ""; syncPanel(); });
    confirmButton.addEventListener("click", () => {
      if (busy || input.value.trim() !== "DELETE") return;
      error.textContent = "";
      perform("POST", "/api/admin/events/clear-past", { slugs: [...names.keys()], confirm: "DELETE" }, {
        done: (d) => {
          const skipped = Array.isArray(d.skipped) ? d.skipped : [];
          const why = { not_past: "it hasn't ended", not_found: "it no longer exists" };
          const left = skipped.map((s) => `${names.get(s.slug) ?? s.slug} (${why[s.reason] ?? "skipped"})`);
          return `Deleted ${plural(d.deletedEvents, "event")} and ${plural(d.deletedBookings, "booking")}.${left.length > 0 ? ` Not deleted: ${left.join(", ")}.` : ""}`;
        },
        error: (text) => { error.textContent = text; },
      });
    });
    syncPanel();
    return h("div", { class: "confirm", role: "group", "aria-label": "Delete the selected events" },
      h("p", {}, `This permanently deletes ${plural(chosen.length, "event")} and ${plural(total, "booking")} in total. This can't be undone.`),
      h("ul", { class: "confirm-list" }, ...chosen.map((e) => h("li", {}, h("span", { class: "name-exact" }, e.name)))),
      error,
      h("div", { class: "field" }, h("label", { for: id }, "Type DELETE to confirm"), input),
      h("div", { class: "actions" }, confirmButton, cancelButton));
  }

  function card(ev) {
    const children = [
      h("h2", {}, ev.name),
      h("p", { class: "when" }, `${formatDate(ev.startUtc)}, ${formatTimeRange(ev.startUtc, ev.endUtc)}`),
      h("p", { class: "booked" }, ev.placeCount !== undefined && ev.placeCount !== ev.slotCount
        ? `${ev.bookedCount} of ${ev.placeCount} places booked` : `${ev.bookedCount} of ${ev.slotCount} slots booked`),
      h("p", {}, h("span", { class: ev.bookings?.open ? "badge open" : "badge closed" },
        ev.bookings?.open ? "Bookings open" : "Bookings closed"),
      ...(ev.full ? [" ", h("span", { class: "badge full" }, "Full")] : []),
      ...(ev.listed === false ? [" ", h("span", { class: "badge closed" }, "Not listed")] : [])),
    ];
    // Only events with a sound booking path get any links, as before.
    const edit = h("a", { class: "button", href: `/admin/edit?slug=${encodeURIComponent(ev.slug)}` }, "Edit");
    const schedule = h("a", { class: "button", href: `/admin/schedule?slug=${encodeURIComponent(ev.slug)}` }, "Schedule");
    const li = h("li", { class: "event-card" }, ...children);
    if (isBookingPath(ev.path)) {
      li.append(...actions(location.origin + ev.path, ev.path, edit, schedule), share(ev),
        h("div", { class: "manage" }, archiveButton(ev, true), deleteButton(ev, li)));
    }
    return li;
  }

  /** Built from the event as it is now, each time it is tapped; the card is rebuilt from fresh data after every refresh. */
  const share = (ev) => shareControls({
    h, navigator, clipboard, label: ev.name, copyLink: false, // the card has its own "Copy booking link"
    getLink: () => location.origin + ev.path,
    getMessage: () => buildShareMessage({
      event: ev, clubName, link: location.origin + ev.path, template: pickShareTemplate(ev, data.defaultShareMessage),
    }),
  });

  function actions(url, path, edit, schedule) {
    const copyStatus = h("p", { class: "copy-status", "aria-live": "polite" });
    const fallback = h("div", { class: "field", hidden: true });
    const copy = h("button", { type: "button", class: "button primary" }, "Copy booking link");
    let timer;
    copy.addEventListener("click", async () => {
      clearTimeout(timer);
      if (await writeClipboard(clipboard, url)) {
        fallback.hidden = true;
        copyStatus.textContent = "Copied";
        timer = setTimeout(() => { copyStatus.textContent = ""; }, 2000);
        return;
      }
      const input = h("input", { type: "text", readonly: true, "aria-label": "Booking link" });
      input.value = url;
      fallback.replaceChildren(input);
      fallback.hidden = false;
      input.focus();
      input.select();
      copyStatus.textContent = "Couldn't copy automatically. Copy the link below manually.";
    });
    return [
      h("div", { class: "actions" }, copy, h("a", { class: "button", href: path }, "Open"), edit, schedule),
      copyStatus,
      fallback,
    ];
  }

  return load();
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  const settings = loadSettings((...args) => fetch(...args));
  brandPage(document, settings, { pageTitle: document.title, home: "/admin/" });
  init({
    document, location, navigator, clipboard: navigator.clipboard, settings,
    fetch: (...args) => fetch(...args),
    navigate: (url) => location.assign(url),
  });
}

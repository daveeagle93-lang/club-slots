import { brandPage, loadSettings, pageTitle } from "./branding.js";
import {
  copyText, formatDate, formatPounds, formatTime, formatTimeRange, mapsUrl, newIdempotencyKey, privacyParagraphs,
  placesLeftText, slotsLeftText, slugFromPathname,
} from "./lib.js";

const GENERIC_ERROR = "Something went wrong. Please try again.";
const CLOSED = "Bookings for this event are closed.";
const EVENT_CHANGED = "The event was just changed. The times below are up to date; choose again.";
const SAVED_EARLIER = "We'd already saved a booking from this page, so we haven't changed it. Here it is. To change it, contact the organiser.";

/**
 * Wires the booking page into `#app`. `settings` is the branding promise (see branding.js); without it the page
 * has no branding, no privacy contact and no admin warning. The form waits at most `settingsTimeoutMs` for it;
 * settings that arrive later are patched in. Resolves once the first load has settled.
 */
export function init({ document, fetch, location, clipboard, settings = null, settingsTimeoutMs = 2000 }) {
  const root = document.getElementById("app");
  const slug = slugFromPathname(location.pathname);
  let event = null;
  let slots = [];
  let selected = null;
  let selectedLane = null; // the chosen lane's id, or null when the page doesn't ask for one
  let submitting = false;
  let privacyText = "";
  // One key per page load, sent with every submit so a retry can't book twice. The confirmation has no
  // way back to the form, so a second booking means a reload, and so a new key.
  const idempotencyKey = newIdempotencyKey();
  let view = null; // element refs for the booking view
  let club = null; // the settings once they arrive; null while unknown or unavailable
  let banner = null; // the admin-only warning, kept across re-renders
  const branded = settings ? brandPage(document, settings, { pageTitle: "Book a slot", home: "/" }) : Promise.resolve(null);
  let timedOut = false;

  // The branding promise, or null if it takes longer than the timeout: /api/settings is a nicety, and a slow one
  // must not hold up the booking form.
  function settingsInTime() {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve(null); }, settingsTimeoutMs);
    });
    return Promise.race([branded, timeout]).finally(() => clearTimeout(timer));
  }

  // Settings that arrive after we gave up waiting. brandPage has already added the header band by now; this fixes
  // the title it just overwrote and adds the contact, without re-rendering the form the visitor may be typing in.
  branded.then((s) => {
    if (!timedOut) return;
    club = s;
    if (event) document.title = pageTitle(event.name, s?.clubName);
    if (s?.privacyContact) view?.privacy?.append(contactLine(s.privacyContact));
  });

  // All text goes through textContent; nothing here ever parses HTML.
  const h = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  };
  const show = (...nodes) => root.replaceChildren(...(banner ? [banner] : []), ...nodes);
  const reduceMotion = () => document.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const scrollTo = (el) => el.scrollIntoView?.({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
  const mapsLink = (postcode) =>
    h("a", { href: mapsUrl(postcode), target: "_blank", rel: "noopener noreferrer" }, postcode);

  function showMessage(text, withRetry = false) {
    view = null;
    show(h("div", { class: "message", role: "status" },
      h("p", {}, text),
      ...(withRetry ? [h("button", { type: "button", class: "button" }, "Retry")] : [])));
    if (withRetry) root.querySelector("button").addEventListener("click", load);
  }

  function eventHeader(ev) {
    const row = (label, ...value) => [h("dt", {}, label), h("dd", {}, ...value)];
    return h("header", { class: "event" },
      h("h1", {}, ev.name),
      h("dl", { class: "facts" },
        ...row("Date", formatDate(ev.startUtc)),
        ...row("Time", formatTimeRange(ev.startUtc, ev.endUtc)),
        ...row("Venue", mapsLink(ev.venuePostcode)),
        ...row("Cost", formatPounds(ev.costPence))),
      ...(ev.details ? [h("p", { class: "details" }, ev.details)] : []));
  }

  /**
   * Tells a signed-in admin, and nobody else, that no privacy contact is set. A single probe of the session
   * endpoint: anything but a 200 with the session's JSON (an `identity` string) shows nothing, so a 401, a
   * redirect, a network error, a cross-origin Access redirect that the CSP blocks, or a 200 page of HTML from
   * somewhere in front of the site does not count. If the settings didn't load, or are late, we don't know, so
   * we don't warn.
   */
  async function warnAdmin() {
    const s = await settingsInTime();
    if (!s?.loaded || s.privacyContact) return;
    try {
      const res = await fetch("/api/admin/session", { credentials: "same-origin", cache: "no-store" });
      if (res.status !== 200 || res.redirected) return;
      const session = await res.json();
      if (typeof session?.identity !== "string" || session.identity === "") return;
    } catch {
      return;
    }
    banner = h("div", { class: "notice", role: "status" },
      "Admin notice (the people booking can't see this): no privacy contact is set, so bookers aren't told who to "
      + "contact about their details. Set one in ", h("a", { href: "/admin/settings" }, "Settings"), ".");
    root.prepend(banner);
  }

  const contactLine = ({ name, email }) => h("p", {},
    "Questions about your details, or want them deleted? Contact ", ...(name ? [`${name}, `] : []),
    // Encoded so nothing in the address can add a header or body to the mailto URL; "@" stays readable.
    h("a", { href: `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}` }, email), ".");

  async function fetchEvent() {
    try {
      const res = await fetch(`/api/events/${slug}`, { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      return { status: res.status, data };
    } catch {
      return null;
    }
  }

  // Taken slots are hidden; slots that have already started stay visible but disabled.
  const shown = (list) => list.filter((s) => s.status === "free" || s.status === "past");
  // How the page offers places. Plain (one unnamed lane, one place per time) is exactly the v1.0 page: no lane is
  // sent. Anything else counts places; two or more lanes get a card per time with a button for each lane.
  function layout() {
    const lanes = event.lanes ?? [];
    const capacity = event.capacity ?? 1;
    const multi = lanes.length > 1;
    return { lanes, capacity, multi, plain: !multi && capacity === 1 && !lanes[0]?.name };
  }
  const freeIn = (slot, laneId) => slot.places?.find((p) => p.laneId === laneId)?.free ?? 1;
  const totalFree = (slot) => slot.places ? slot.places.reduce((n, p) => n + p.free, 0) : 1;
  const isClosed = (data) => data.event.archived || data.bookings?.open === false;

  async function load() {
    if (!slug) return showMessage("We couldn't find that event. Check the link you were sent.");
    showMessage("Loading…");
    const r = await fetchEvent();
    if (r?.status === 404) return showMessage("We couldn't find that event. Check the link you were sent.");
    if (!r?.data) return showMessage("We couldn't load this event. Check your connection and try again.", true);
    event = r.data.event;
    slots = shown(r.data.slots);
    privacyText = r.data.privacyNotice ?? "";
    selected = null;
    selectedLane = null;
    club = await settingsInTime();
    document.title = pageTitle(event.name, club?.clubName);
    if (isClosed(r.data)) showClosed();
    else showBooking();
  }

  function showClosed() {
    view = null;
    show(eventHeader(event), h("div", { class: "message", role: "status" }, h("h2", {}, "Bookings closed"), h("p", {}, CLOSED)));
  }

  /** The booking form for the event's fields as they are now (hidden until a time is chosen), with its parts. */
  function buildForm() {
    // One input for each field of the event's booking form, in order. Ids and names come from the field's position, and the
    // keyboard's enter key says "next" until the last field, where it says "done".
    const fields = (event.fields ?? []).map((f, i, all) => ({
      position: f.position,
      name: f.label,
      input: h("input", {
        id: `field-${f.position}`, name: `field${f.position}`, type: "text", required: f.required, maxlength: String(f.maxLength),
        autocapitalize: "words", autocomplete: "off", enterkeyhint: i === all.length - 1 ? "done" : "next",
        "aria-describedby": `field-${f.position}-error`,
      }),
      error: h("p", { id: `field-${f.position}-error`, class: "field-error", role: "alert" }),
      label: f.required ? f.label : `${f.label} (optional)`,
    }));
    const formError = h("div", { class: "form-error", role: "alert" });
    const heading = h("h2", { tabindex: "-1" });
    const submit = h("button", { type: "submit", class: "button primary" });
    const progress = h("p", { class: "progress", "aria-live": "polite" });
    const privacy = privacyParagraphs(privacyText).map((p) => h("p", {}, p));
    if (club?.privacyContact) privacy.push(contactLine(club.privacyContact));
    const privacySection = privacy.length > 0
      ? h("section", { class: "privacy", "aria-labelledby": "privacy-heading" }, h("h3", { id: "privacy-heading" }, "Privacy"), ...privacy)
      : null;
    const form = h("form", { id: "booking-form", hidden: true },
      heading,
      formError,
      ...fields.map((f) => h("div", { class: "field" }, h("label", { for: f.input.id }, f.label), f.input, f.error)),
      ...(privacySection ? [privacySection] : []),
      submit,
      progress);
    form.addEventListener("submit", onSubmit);
    return { privacy: privacySection, form, heading, submit, progress, formError, fields };
  }

  function showBooking() {
    const notice = h("div", { id: "notice", class: "notice", role: "alert", tabindex: "-1", hidden: true });
    const slotsLeft = h("p", { class: "slots-left" });
    const grid = h("ul", { class: "slot-grid" });
    const built = buildForm();
    view = { ...built, notice, slotsLeft, grid };
    show(
      eventHeader(event),
      h("section", { class: "slots", "aria-labelledby": "slots-heading" },
        h("h2", { id: "slots-heading" }, "Pick a time"), slotsLeft, notice, grid),
      built.form);
    renderSlots();
  }

  /** What a booker sees of the form: the fields' positions, labels, required flags and longest values. */
  const formKey = (ev) => JSON.stringify((ev.fields ?? []).map((f) => [f.position, f.label, f.required, f.maxLength]));

  /** Swaps in a form for the event's fields as they are now, keeping what was typed in a field that is still the same (same place, same label). */
  function rebuildForm() {
    const typed = new Map(view.fields.map((f) => [`${f.position}|${f.name}`, f.input.value]));
    const built = buildForm();
    for (const f of built.fields) f.input.value = typed.get(`${f.position}|${f.name}`) ?? "";
    view.form.replaceWith(built.form);
    Object.assign(view, built);
  }

  function setNotice(text) {
    view.notice.textContent = text;
    view.notice.hidden = !text;
  }

  function renderSlots() {
    const { lanes, capacity, multi, plain } = layout();
    const open = slots.filter((s) => s.status === "free");
    view.slotsLeft.textContent = plain ? slotsLeftText(open.length) : placesLeftText(open.reduce((n, s) => n + totalFree(s), 0));
    view.grid.className = multi ? "slot-grid groups" : "slot-grid";
    view.grid.replaceChildren(...slots.map((s) => (multi ? groupItem(s, lanes) : slotItem(s, lanes[0], capacity, plain))));
  }

  const pastButton = (s, time) => h("button", { type: "button", class: "slot past", disabled: true, "aria-label": `${time} slot, started` },
    h("span", { class: "slot-time" }, time), h("span", { class: "slot-note" }, "Started"));

  // One time, one button: the time grid of v1.0, with the places left beside the time when a time has more than one.
  function slotItem(s, lane, capacity, plain) {
    const time = formatTime(s.start);
    if (s.status === "past") return h("li", {}, pastButton(s, time));
    const left = freeIn(s, lane?.id);
    const counted = capacity > 1;
    const button = h("button", {
      type: "button", class: counted ? "slot has-note" : "slot", "aria-pressed": String(s.start === selected),
      "aria-label": counted ? `Book ${time} slot, ${placesLeftText(left)}` : `Book ${time} slot`,
    }, ...(counted ? [h("span", { class: "slot-time" }, time), h("span", { class: "slot-note" }, `${left} left`)] : [time]));
    button.dataset.start = s.start;
    if (!plain && lane) button.dataset.lane = String(lane.id);
    button.addEventListener("click", () => select(s, plain ? null : lane));
    return h("li", {}, button);
  }

  // One card per time, with a button for each lane. A full lane stays in the card, disabled.
  function groupItem(s, lanes) {
    const time = formatTime(s.start);
    if (s.status === "past") return h("li", { class: "slot-group past" }, h("div", { role: "group", "aria-label": time }, pastButton(s, time)));
    const buttons = lanes.map((lane) => {
      const left = freeIn(s, lane.id);
      const button = h("button", {
        type: "button", class: "slot lane", disabled: left < 1,
        "aria-pressed": String(s.start === selected && lane.id === selectedLane),
        "aria-label": left < 1 ? `${time}, ${lane.name}, full` : `Book ${time}, ${lane.name}, ${placesLeftText(left)}`,
      }, h("span", { class: "lane-name" }, lane.name), h("span", { class: "slot-note" }, left < 1 ? "Full" : `${left} left`));
      button.dataset.start = s.start;
      button.dataset.lane = String(lane.id);
      if (left > 0) button.addEventListener("click", () => select(s, lane));
      return button;
    });
    // The list item stays a list item; the labelled group is inside it.
    return h("li", { class: "slot-group" },
      h("div", { role: "group", "aria-label": time }, h("h3", { class: "slot-group-time" }, time), h("div", { class: "lane-grid" }, ...buttons)));
  }

  function select(slot, lane) {
    selected = slot.start;
    selectedLane = lane ? lane.id : null;
    setNotice("");
    clearErrors();
    for (const b of view.grid.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.start === selected && (b.dataset.lane ?? null) === (selectedLane === null ? null : String(selectedLane))));
    }
    const time = formatTime(slot.start);
    view.heading.textContent = `Booking ${time}${lane?.name ? ` · ${lane.name}` : ""}`;
    view.submit.textContent = `Confirm booking for ${time}${lane?.name ? `, ${lane.name}` : ""}`;
    view.form.hidden = false;
    scrollTo(view.form);
  }

  function deselect() {
    selected = null;
    selectedLane = null;
    view.form.hidden = true;
  }

  function clearErrors() {
    view.formError.textContent = "";
    for (const { input, error } of view.fields) {
      error.textContent = "";
      input.removeAttribute("aria-invalid");
    }
  }

  function fieldError(input, error, message) {
    error.textContent = message;
    input.setAttribute("aria-invalid", "true");
  }

  function setBusy(busy) {
    submitting = busy;
    view.submit.disabled = busy;
    view.form.setAttribute("aria-busy", String(busy));
    view.progress.textContent = busy ? "Confirming your booking…" : "";
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting || selected === null) return;
    clearErrors();
    setBusy(true);
    let res;
    let data = null;
    try {
      res = await fetch(`/api/events/${slug}/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot: selected, ...(selectedLane === null ? {} : { laneId: selectedLane }), ...Object.fromEntries(view.fields.map((f) => [`field${f.position}`, f.input.value])), idempotencyKey }),
      });
      data = await res.json().catch(() => null);
    } catch {
      setBusy(false);
      view.formError.textContent = GENERIC_ERROR;
      return;
    }
    setBusy(false);
    const code = data?.error?.code;
    if (res.status === 201 && data?.booking) return showConfirmation(data);
    if (res.status === 409 && (code === "slot_taken" || code === "slot_started")) {
      // The payload only lists free slots, so show it at once (in case the refetch fails), then refetch for the
      // full current view, which also keeps the slots that have started.
      slots = shown((data.freeSlots ?? []).map((s) => ({ ...s, status: "free" })));
      deselect();
      renderSlots();
      setNotice(code === "slot_started" ? "That session has already started." : "That slot's just gone.");
      await refresh();
      view?.notice.focus();
    } else if (res.status === 409 && code === "duplicate_booking") {
      view.formError.textContent = data.error.message;
    } else if (res.status === 400 && code === "invalid_input") {
      const f = data.fields ?? {};
      // An error for a lane the page doesn't offer, or only for fields it has no input for (nothing could be highlighted), means the
      // event changed under the booker.
      const unplaced = Object.keys(f).some((k) => /^field\d+$/.test(k) && !view.fields.some((x) => `field${x.position}` === k));
      if (f.laneId || (unplaced && !view.fields.some((x) => f[`field${x.position}`]))) {
        deselect();
        setNotice(EVENT_CHANGED);
        await refresh();
        view?.notice.focus();
        return;
      }
      let fieldErrors = 0;
      for (const { position, input, error } of view.fields) {
        if (!f[`field${position}`]) continue;
        fieldError(input, error, f[`field${position}`]);
        fieldErrors++;
      }
      if (f.slot || fieldErrors === 0) {
        view.formError.textContent = f.slot ?? f.idempotencyKey ?? data.error.message;
      }
    } else if (res.status === 400 && code === "invalid_slot") {
      deselect();
      setNotice("That slot isn't available any more.");
      await refresh();
    } else if (res.status === 409 && code === "event_changed") {
      deselect();
      setNotice(EVENT_CHANGED);
      await refresh();
      view?.notice.focus();
    } else if (res.status === 422 && code === "idempotency_key_reuse") {
      // With a booking: the page's own earlier attempt was saved, so show that rather than the edit.
      if (data.booking) showConfirmation(data, SAVED_EARLIER);
      else view.formError.textContent = data.error.message;
    } else if (res.status === 410) {
      showClosed();
    } else {
      view.formError.textContent = GENERIC_ERROR;
    }
  }

  /**
   * Re-reads the event: the slot list and lanes, leaving any notice and typed values in place. If its booking form has other fields now, the
   * form is rebuilt for them (keeping what was typed where the field is the same), nothing is selected, and the notice says the event changed.
   */
  async function refresh() {
    const r = await fetchEvent();
    if (!r?.data) return;
    const formChanged = formKey(r.data.event) !== formKey(event);
    event = r.data.event;
    if (isClosed(r.data)) return showClosed();
    slots = shown(r.data.slots);
    if (view && formChanged) {
      privacyText = r.data.privacyNotice ?? privacyText;
      rebuildForm();
      deselect();
      setNotice(EVENT_CHANGED);
    }
    if (view) renderSlots();
  }

  function showConfirmation({ booking, event: ev = event, icsUrl }, noticeText) {
    view = null;
    const when = `${formatDate(booking.slot.start)}, ${formatTimeRange(booking.slot.start, booking.slot.end)}`;
    const row = (label, ...value) => [h("dt", {}, label), h("dd", {}, ...value)];
    const heading = h("h1", { tabindex: "-1" }, "You're booked in");
    const copyStatus = h("p", { class: "copy-status", "aria-live": "polite" });
    const copyButton = h("button", { type: "button", class: "button" }, "Copy booking");
    let timer;
    copyButton.addEventListener("click", async () => {
      const ok = await copyToClipboard(copyText(ev, booking));
      copyStatus.textContent = ok ? "Copied" : "Couldn't copy. Take a screenshot instead.";
      clearTimeout(timer);
      timer = setTimeout(() => { copyStatus.textContent = ""; }, 2000);
    });
    show(...(noticeText ? [h("p", { class: "notice", role: "status" }, noticeText)] : []), h("section", { class: "confirmation" },
      heading,
      h("p", { class: "event-name" }, ev.name),
      h("dl", { class: "facts" },
        ...row("When", when),
        ...booking.fields.flatMap((f) => row(f.label, f.value)),
        ...(booking.lane?.name ? row("Lane", booking.lane.name) : []),
        ...row("Venue", mapsLink(ev.venuePostcode)),
        ...row("Cost", formatPounds(ev.costPence))),
      ...(ev.details ? [h("p", { class: "details" }, ev.details)] : []),
      h("div", { class: "actions" },
        copyButton,
        h("a", { class: "button primary", href: icsUrl }, "Add to calendar")),
      copyStatus,
      h("p", { class: "keep" },
        "Keep this: take a screenshot or copy the details, as there's no way to look your booking up again. "
        + "Bookings can't be changed online, so contact the organiser to move or cancel.")));
    heading.focus();
  }

  async function copyToClipboard(text) {
    try {
      if (clipboard?.writeText) {
        await clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to the legacy path */ }
    const area = h("textarea", { class: "clipboard-buffer", readonly: true, tabindex: "-1", "aria-hidden": "true" });
    area.value = text;
    document.body.append(area);
    area.select();
    area.setSelectionRange?.(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* unsupported */ }
    area.remove();
    return ok;
  }

  return Promise.all([load(), warnAdmin()]).then(() => {});
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  const fetchPage = (...args) => fetch(...args);
  init({
    document, location, clipboard: navigator.clipboard,
    fetch: fetchPage, settings: loadSettings(fetchPage),
  });
}

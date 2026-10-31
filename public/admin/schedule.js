import { brandPage, loadSettings } from "../branding.js";
import { formatDate, formatTime, isBookingPath } from "../lib.js";
import { buildShareMessage, pickShareTemplate } from "../share-message.js";
import { createApi, makeH, writeClipboard } from "./api.js";
import { shareControls } from "./share.js";

const SLUG = /^[A-Za-z0-9_-]{16,64}$/;
const CHANGED = "That changed while you were working. The schedule has been refreshed.";
const OFFLINE = "We couldn't reach the server. Check your connection and try again.";

/**
 * Wires the schedule page (`/admin/schedule?slug=...`) into `#app`: every slot and break in order with the
 * actions to add, move, swap and clear bookings. After every action the event is fetched again and drawn
 * afresh, so the page never shows what the server doesn't have. Names are user input: text nodes only.
 * A Share control sits under the date unless the event is archived or over (their links are closed). `settings` is the branding promise (see
 * branding.js), whose club name heads the shared message once it has loaded.
 * Resolves once the first load has settled.
 */
export async function init({ document, fetch, navigate, clipboard, location, navigator = undefined, settings = null }) {
  const root = document.getElementById("app");
  const api = createApi({ fetch, navigate });
  const h = makeH(document);

  // Not awaited: the page must not wait for the settings. They are long settled by the time Share is tapped.
  let clubName = "";
  settings?.then((s) => { if (s?.loaded) clubName = s.clubName ?? ""; }, () => {});

  const show = (...nodes) => root.replaceChildren(...nodes);
  const back = () => h("a", { class: "button", href: "/admin/" }, "Back to events");
  const notFound = () => show(h("div", { class: "message", role: "alert" },
    h("p", {}, "We couldn't find that event. It may have been removed, or the link may be wrong."), back()));
  const failure = (retry) => {
    const button = h("button", { type: "button", class: "button" }, "Retry");
    button.addEventListener("click", retry);
    show(h("div", { class: "message", role: "alert" }, h("p", {}, "We couldn't load the schedule. Check your connection and try again."), button));
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
  const base = `/api/admin/events/${encodeURIComponent(slug)}`;

  let detail = null;
  let panel = null; // the open action: { kind: "clear" | "move" | "swap" | "add", key }
  let busy = false;
  // One live region for every result; it outlives re-renders so screen readers hear each change.
  const status = h("p", { class: "copy-status sched-status", "aria-live": "polite", tabindex: "-1" });
  const say = (text) => { status.textContent = text; };

  /** A booking's values are its non-empty field values in the form's order: "Rex (Sam Smith)", or just "Sam" when the form has one field. */
  const first = (b) => b.fields[0]?.value ?? "";
  const person = (b) => {
    const rest = b.fields.slice(1).map((f) => f.value);
    return rest.length > 0 ? `${first(b)} (${rest.join(", ")})` : first(b);
  };
  /** "Rex and Sam Smith", from the values of the fields that identify a booking, for "... already have a booking". */
  const identityText = (b, fields) => {
    const names = new Set(fields.filter((f) => f.identity).map((f) => f.label));
    const values = b.fields.filter((f) => names.has(f.label)).map((f) => f.value);
    const all = values.length > 0 ? values : b.fields.map((f) => f.value);
    return { text: all.length > 1 ? `${all.slice(0, -1).join(", ")} and ${all.at(-1)}` : all[0], many: all.length > 1 };
  };
  /** One lane with one place per time is the v1.0 page (a named lane is only named in each row); anything else lists each time's places. */
  const isPlain = (event) => (event.lanes?.length ?? 1) === 1 && (event.capacity ?? 1) === 1;
  const orphanTime = (iso) => `${formatDate(iso)}, ${formatTime(iso)}`;
  const takenText = (b) => `That slot is already taken by ${person(b)}.`;
  /** "10:30", or "10:30 · Ring 2" when the lane has a name. */
  const where = (time, lane) => (lane ? `${time} · ${lane}` : time);
  const fullText = (time, lane) => `${lane ? `${lane} at ${time}` : time} is full.`;

  function setBusy(on) {
    busy = on;
    for (const el of root.querySelectorAll("button, select, input")) el.disabled = on;
  }

  /**
   * One request at a time. `done(data)` says what to announce and where focus goes on success; `rejected(res)`
   * may handle a refusal inline (and return true). A change made by someone else (including an edit that
   * removed the slot: `invalid_slot`), or a slot that has just been taken, refreshes the page instead, so
   * what is shown is what the server has. A slot_taken answer names its one holder on the plain page (one lane, one place); a full lane
   * on any other page says `full`.
   */
  async function perform(method, url, body, { done, rejected, full }) {
    if (busy) return;
    setBusy(true);
    let res;
    try {
      res = await api.request(method, url, body);
    } catch {
      setBusy(false);
      say(OFFLINE);
      return;
    }
    if (res.status === 401) { setBusy(false); return; }
    const code = res.data?.error?.code;
    if (res.status >= 200 && res.status < 300) return refresh(done(res.data));
    setBusy(false); // before an inline refusal can move focus: a disabled control can't take it
    if (rejected?.(res, code)) return;
    if (res.status === 404 || (res.status === 400 && code === "invalid_slot") || (res.status === 409 && (code === "changed" || code === "event_changed"))) {
      return refresh({ message: CHANGED, focus: "status" });
    }
    if (res.status === 409 && code === "slot_taken" && res.data?.bookings?.length > 0 && isPlain(detail.event)) {
      return refresh({ message: takenText(res.data.bookings[0]), focus: "status" });
    }
    if (res.status === 409 && code === "slot_taken" && full) return refresh({ message: full, focus: "status" });
    say(res.data?.error?.message ?? "Something went wrong. Try again.");
  }

  async function refresh({ message, focus }) {
    setBusy(true);
    let res = null;
    try { res = await api.request("GET", base); } catch { /* reported below */ }
    panel = null;
    if (res?.status === 200 && Array.isArray(res.data?.slots)) {
      detail = res.data;
      busy = false;
      render(focus);
      say(message);
    } else {
      setBusy(false);
      say(`${message} We couldn't refresh the schedule, so reload the page to see it.`);
    }
  }

  async function load() {
    show(h("p", { class: "message", role: "status" }, "Loading the schedule…"));
    let res;
    try {
      res = await api.request("GET", base);
    } catch {
      return failure(load);
    }
    if (res.status === 401) return;
    if (res.status === 404) return notFound();
    if (res.status !== 200 || !Array.isArray(res.data?.slots)) return failure(load);
    detail = res.data;
    render(null);
  }

  const find = (key) => [...root.querySelectorAll("[data-key]")].find((el) => el.getAttribute("data-key") === key);

  /** `focus`: "status", { key } for a row, { key, action } for a row's button, or { panel } for the open form. */
  function render(focus) {
    const { event } = detail;
    // Anything but the plain page lists each time's places: a header row per time, then one row per booking and one per lane that
    // still has room.
    const plain = isPlain(event);
    const singleLane = plain && event.lanes?.[0]?.name ? event.lanes[0].name : "";
    const placesOf = (slot) => slot.places ?? [];
    /** The plain page's one booking at a time, or null. */
    const heldAt = (slot) => (plain ? placesOf(slot)[0]?.bookings[0] ?? null : null);
    const freeSlots = detail.slots.filter((s) => !heldAt(s));
    const bookedSlots = detail.slots.filter((s) => heldAt(s));

    const links = [h("a", { class: "button", href: `/admin/edit?slug=${encodeURIComponent(slug)}` }, "Edit event")];
    if (isBookingPath(`/e/${slug}`)) links.push(h("a", { class: "button", href: `/e/${slug}` }, "Open public page"));
    links.push(h("a", { class: "button", href: `${base}/export.csv`, download: true }, "Download CSV"));
    const fallback = h("div", { class: "field", hidden: true });
    const copy = h("button", { type: "button", class: "button primary" }, "Copy lineup");
    copy.addEventListener("click", async () => {
      if (await writeClipboard(clipboard, detail.lineup)) {
        fallback.hidden = true;
        say("Copied");
        return;
      }
      const box = h("textarea", { readonly: true, "aria-label": "Lineup", rows: String(Math.min(detail.slots.length + event.breaks.length + 3, 14)) });
      box.value = detail.lineup;
      fallback.replaceChildren(box);
      fallback.hidden = false;
      box.focus();
      box.select();
      say("Couldn't copy automatically. Copy it from here.");
    });

    // The message is built from the event as it is now, each time Share is tapped.
    const share = () => shareControls({
      h, navigator, clipboard, label: event.name,
      getLink: () => `${location.origin}/e/${slug}`,
      getMessage: () => buildShareMessage({
        event, clubName, link: `${location.origin}/e/${slug}`, template: pickShareTemplate(event, detail.defaultShareMessage),
      }),
    });

    // Slots and breaks together, in time order. A break never starts where a slot does.
    const items = [
      ...detail.slots.map((s) => ({ start: s.start, slot: s })),
      ...event.breaks.map((b) => ({ start: b.startUtc, brk: b })),
    ].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    function openers(key, kind, label, aria) {
      const button = h("button", { type: "button", class: "button", "data-action": kind, "aria-label": aria, "aria-expanded": String(panel?.kind === kind && panel.key === key) }, label);
      button.addEventListener("click", () => {
        if (busy) return;
        panel = { kind, key };
        render({ panel: true });
      });
      return button;
    }
    const cancel = (key, kind, autofocus = false) => {
      const button = h("button", { type: "button", class: "button", "data-autofocus": autofocus }, "Cancel");
      button.addEventListener("click", () => {
        if (busy) return;
        panel = null;
        render({ key, action: kind });
      });
      return button;
    };
    const panelIf = (key, build) => (panel?.key === key ? [build()] : []);

    /** `landing` is where focus goes once the booking is cleared: the row, or in the multi layout the time's header. */
    function clearPanel(b, key, when, landing = key) {
      const confirmButton = h("button", { type: "button", class: "button danger" }, "Clear booking");
      confirmButton.addEventListener("click", () => perform("DELETE", `${base}/bookings/${b.id}`, { confirm: true }, {
        done: () => ({ message: `Cleared ${person(b)} from ${when}.`, focus: { key: landing } }),
      }));
      return h("div", { class: "sched-panel confirm", role: "group", "aria-label": "Confirm clearing the booking" },
        h("h3", {}, "Clear this booking?"),
        h("p", {}, `${when}: ${person(b)}`),
        h("p", { class: "note" }, "They won't be told. You need to let them know."),
        h("div", { class: "actions" }, confirmButton, cancel(key, "clear", true)));
    }

    /** A form with one select and a submit button; `choices` are { value, text, ... } and `send` gets the one chosen. */
    function pickPanel({ key, kind, title, label, choices, submitLabel, empty, send, chooseText = "Choose a slot." }) {
      if (choices.length === 0) return h("div", { class: "sched-panel", role: "group", "aria-label": title }, h("h3", {}, title), h("p", { class: "note" }, empty), h("div", { class: "actions" }, cancel(key, kind)));
      const select = h("select", { id: `pick-${kind}`, "data-autofocus": true },
        h("option", { value: "" }, "Choose…"), ...choices.map((c) => h("option", { value: c.value }, c.text)));
      const error = h("p", { class: "field-error", role: "alert" });
      const form = h("form", { class: "sched-panel", "aria-label": title },
        h("h3", {}, title),
        h("div", { class: "field" }, h("label", { for: `pick-${kind}` }, label), select, error),
        h("div", { class: "actions" }, h("button", { type: "submit", class: "button primary" }, submitLabel), cancel(key, kind)));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (busy) return;
        if (select.value === "") {
          error.textContent = chooseText;
          select.setAttribute("aria-invalid", "true");
          select.focus();
          return;
        }
        send(choices.find((c) => c.value === select.value));
      });
      return form;
    }

    /** `from` is where the booking is now: { slot, laneId }. The v1.0 page (one lane, one place) sends no lane at all. */
    function movePanel(b, key, from, when) {
      const choices = plain
        ? freeSlots.map((s) => ({ value: s.start, toSlot: s.start, laneName: singleLane, text: where(formatTime(s.start), singleLane) }))
        : detail.slots.flatMap((s) => placesOf(s)
          .filter((p) => p.free > 0 && !(s.start === from.slot && p.laneId === from.laneId))
          .map((p) => ({ value: `${s.start}|${p.laneId}`, toSlot: s.start, toLane: p.laneId, laneName: p.laneName, text: `${where(formatTime(s.start), p.laneName)} (${p.free} left)` })));
      return pickPanel({
        key, kind: "move", title: "Move booking", label: plain ? "New slot" : "New place", submitLabel: "Move booking",
        empty: plain ? "There are no free slots to move it to." : "There are no free places to move it to.",
        chooseText: plain ? "Choose a slot." : "Choose a time and lane.",
        choices,
        send: (c) => perform("POST", `${base}/bookings/${b.id}/move`,
          plain ? { fromSlot: from.slot, toSlot: c.toSlot } : { fromSlot: from.slot, fromLane: from.laneId, toSlot: c.toSlot, toLane: c.toLane }, {
            done: () => ({ message: `Moved ${person(b)} from ${when} to ${where(formatTime(c.toSlot), c.laneName)}.`, focus: { key: c.toSlot } }),
            full: fullText(formatTime(c.toSlot), c.laneName),
          }),
      });
    }

    function swapPanel(b, key, fromSlot, when, fromLane) {
      const others = plain
        ? bookedSlots.filter((s) => s.start !== fromSlot).map((s) => ({ value: s.start, slot: s.start, laneName: singleLane, booking: heldAt(s) }))
        : detail.slots.flatMap((s) => placesOf(s).flatMap((p) => p.bookings.filter((x) => x.id !== b.id)
          .map((x) => ({ value: String(x.id), slot: s.start, lane: p.laneId, laneName: p.laneName, booking: x }))));
      return pickPanel({
        key, kind: "swap", title: "Swap bookings", label: "Swap with", submitLabel: "Swap bookings", empty: "There's no other booking to swap with.",
        choices: others.map((o) => ({ ...o, text: `${where(formatTime(o.slot), o.laneName)}: ${person(o.booking)}` })),
        // Each side says which lane the admin saw it in, so a booking that has moved lane meanwhile is refused (409 changed); the v1.0 page sends none.
        send: (o) => perform("POST", `${base}/bookings/swap`, plain
          ? { a: { id: b.id, slot: fromSlot }, b: { id: o.booking.id, slot: o.slot } }
          : { a: { id: b.id, slot: fromSlot, lane: fromLane }, b: { id: o.booking.id, slot: o.slot, lane: o.lane } }, {
          done: () => ({ message: `Swapped ${first(b)} (${when}) with ${first(o.booking)} (${where(formatTime(o.slot), o.laneName)}).`, focus: { key: o.slot } }),
        }),
      });
    }

    /** `lane` is { id, name } of the lane the booking goes in, or null on the v1.0 page, which sends no lane. */
    function addPanel(slotStart, key, lane) {
      const when = where(formatTime(slotStart), lane ? lane.name : singleLane);
      // One input for each field of the event's booking form, in order. The ids and the server's error keys come from the position.
      const inputs = event.fields.map((f, i) => ({
        key: `field${i + 1}`,
        input: h("input", {
          id: `add-field-${i + 1}`, type: "text", autocomplete: "off", maxlength: String(f.maxLength), required: f.required, "data-autofocus": i === 0,
        }),
        error: h("p", { class: "field-error", id: `add-field-${i + 1}-error` }),
        label: f.required ? f.label : `${f.label} (optional)`,
      }));
      const formError = h("p", { class: "form-error", role: "alert" });
      const mark = (x, message) => {
        x.error.textContent = message ?? "";
        if (message) { x.input.setAttribute("aria-invalid", "true"); x.input.setAttribute("aria-describedby", x.error.id); }
        else { x.input.removeAttribute("aria-invalid"); x.input.removeAttribute("aria-describedby"); }
      };
      // novalidate: the inputs say what is required, but the browser's own check must not stop an empty submit, or the server's "{Label} is required." never shows.
      const form = h("form", { class: "sched-panel", "aria-label": `Add booking at ${when}`, novalidate: true },
        h("h3", {}, `Add booking at ${when}`),
        formError,
        ...inputs.map((x) => h("div", { class: "field" }, h("label", { for: x.input.id }, x.label), x.input, x.error)),
        h("div", { class: "actions" }, h("button", { type: "submit", class: "button primary" }, "Add booking"), cancel(key, "add")));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (busy) return;
        formError.textContent = "";
        for (const x of inputs) mark(x, "");
        perform("POST", `${base}/bookings`, {
          slot: slotStart, ...(lane ? { laneId: lane.id } : {}), ...Object.fromEntries(inputs.map((x) => [x.key, x.input.value])),
        }, {
          done: (data) => ({ message: `Added ${person(data.booking)} at ${when}.`, focus: { key: slotStart } }),
          full: fullText(formatTime(slotStart), lane ? lane.name : singleLane),
          rejected: (res, code) => {
            if (res.status === 400 && code === "invalid_input") {
              const errors = res.data?.fields ?? {};
              for (const x of inputs) mark(x, errors[x.key]);
              formError.textContent = errors.slot ?? errors.laneId ?? "";
              (inputs.find((x) => errors[x.key]) ?? inputs[0]).input.focus();
              return true;
            }
            if (res.status === 409 && code === "duplicate_booking" && res.data?.booking) {
              const b = res.data.booking;
              const who = identityText(b, event.fields);
              formError.textContent = `${who.text} ${who.many ? "already have" : "already has"} a booking at ${where(formatTime(b.slotStart), b.lane?.name)}.`;
              inputs[0].input.focus();
              return true;
            }
            return false;
          },
        });
      });
      return form;
    }

    const laneSpan = (name) => (name ? [h("span", { class: "sched-lane" }, name)] : []);

    function slotRow({ start }, b) {
      const when = where(formatTime(start), singleLane);
      const time = formatTime(start);
      const buttons = b
        ? [openers(start, "move", "Move", `Move booking at ${when}`), openers(start, "swap", "Swap", `Swap booking at ${when}`), openers(start, "clear", "Clear", `Clear booking at ${when}`)]
        : [openers(start, "add", "Add booking", `Add booking at ${when}`)];
      const open = panel?.key === start
        ? [panel.kind === "clear" ? clearPanel(b, start, when) : panel.kind === "move" ? movePanel(b, start, { slot: start }, when)
          : panel.kind === "swap" ? swapPanel(b, start, start, when) : addPanel(start, start, null)]
        : [];
      return h("li", { class: b ? "sched-row booked" : "sched-row free", "data-key": start, tabindex: "-1" },
        h("div", { class: "sched-line" },
          h("span", { class: "sched-time" }, time),
          ...laneSpan(singleLane),
          h("span", { class: "sched-who" }, b ? person(b) : "Free")),
        h("div", { class: "sched-actions" }, ...buttons),
        ...open);
    }

    /** A time with several places: its header, then a row per booking and, for each lane with room, a row to add one. */
    function groupRow(slot) {
      const time = formatTime(slot.start);
      const free = placesOf(slot).reduce((n, p) => n + p.free, 0);
      const subs = placesOf(slot).flatMap((p) => {
        const when = where(time, p.laneName);
        const rows = p.bookings.map((x) => {
          const key = `b${x.id}`;
          const open = panel?.key === key
            ? [panel.kind === "clear" ? clearPanel(x, key, when, slot.start) : panel.kind === "move" ? movePanel(x, key, { slot: slot.start, laneId: p.laneId }, when)
              : swapPanel(x, key, slot.start, when, p.laneId)]
            : [];
          return h("li", { class: "sched-place booked", "data-key": key, tabindex: "-1" },
            h("div", { class: "sched-line" }, ...laneSpan(p.laneName), h("span", { class: "sched-who" }, person(x))),
            h("div", { class: "sched-actions" },
              openers(key, "move", "Move", `Move ${first(x)} at ${when}`), openers(key, "swap", "Swap", `Swap ${first(x)} at ${when}`), openers(key, "clear", "Clear", `Clear ${first(x)} at ${when}`)),
            ...open);
        });
        if (p.free > 0) {
          const key = `a${slot.start}|${p.laneId}`;
          rows.push(h("li", { class: "sched-place free", "data-key": key, tabindex: "-1" },
            h("div", { class: "sched-line" }, ...laneSpan(p.laneName), h("span", { class: "sched-who" }, `${p.free} free`)),
            h("div", { class: "sched-actions" }, openers(key, "add", "Add booking", `Add booking at ${when}`)),
            ...(panel?.key === key ? [addPanel(slot.start, key, { id: p.laneId, name: p.laneName })] : [])));
        }
        return rows;
      });
      return h("li", { class: "sched-group", "data-key": slot.start, tabindex: "-1" },
        h("div", { class: "sched-line" },
          h("span", { class: "sched-time" }, time),
          h("span", { class: "sched-who" }, free > 0 ? `${free} free` : "Full")),
        h("ul", { class: "sched-places" }, ...subs));
    }

    function breakRow(b) {
      return h("li", { class: "sched-break" },
        h("span", { class: "sched-time" }, `${b.start}–${b.end}`),
        h("span", { class: "sched-who" }, b.label === "" ? "Break" : b.label));
    }

    function orphanRow(o) {
      const key = `orphan-${o.id}`;
      const when = where(orphanTime(o.slotStart), o.lane?.name);
      const open = panel?.key === key
        ? [panel.kind === "clear" ? clearPanel(o, key, when) : movePanel(o, key, { slot: o.slotStart, laneId: o.lane?.id }, when)]
        : [];
      return h("li", { class: "sched-row booked orphan", "data-key": key, tabindex: "-1" },
        h("div", { class: "sched-line" }, h("span", { class: "sched-time" }, orphanTime(o.slotStart)), ...laneSpan(o.lane?.name), h("span", { class: "sched-who" }, person(o))),
        h("div", { class: "sched-actions" },
          openers(key, "move", "Move", `Move booking from ${when}`), openers(key, "clear", "Clear", `Clear booking from ${when}`)),
        ...open);
    }

    const children = [
      h("h1", {}, "Schedule"),
      h("p", { class: "event-name" }, event.name),
      ...(event.listed === false ? [h("p", {}, h("span", { class: "badge closed" }, "Not listed"))] : []),
      h("p", { class: "sched-date" }, formatDate(event.startUtc)),
      ...(event.archived || !(Date.parse(event.endUtc) > Date.now()) || !isBookingPath(`/e/${slug}`) ? [] : [share()]),
      h("div", { class: "actions" }, ...links, copy),
      status,
      fallback,
      h("ol", { class: "sched" }, ...items.map((i) => (i.slot ? (plain ? slotRow(i.slot, heldAt(i.slot)) : groupRow(i.slot)) : breakRow(i.brk)))),
    ];
    if (detail.orphans.length > 0) {
      children.push(h("section", { class: "sched-orphans" },
        h("h2", {}, "Not in the schedule"),
        h("p", { class: "note" }, "These bookings are on times that are no longer slots. Move them to a free slot or clear them."),
        h("ol", { class: "sched" }, ...detail.orphans.map(orphanRow))));
    }
    show(...children);

    if (focus === "status") status.focus();
    else if (focus?.panel) root.querySelector("[data-autofocus]")?.focus();
    else if (focus?.key) {
      const row = find(focus.key);
      const target = focus.action ? [...row?.querySelectorAll("[data-action]") ?? []].find((el) => el.getAttribute("data-action") === focus.action) : row;
      (target ?? status).focus(); // a cleared orphan's row is gone: fall back to the live region
    }
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

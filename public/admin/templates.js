import { brandPage, loadSettings } from "../branding.js";
import { formatPounds, penceFromPounds } from "../lib.js";
import { BUILT_IN_SHARE_TEMPLATE, buildShareMessage, PLACEHOLDERS } from "../share-message.js";
import { createApi, makeH } from "./api.js";
import { DEFAULT_FIELDS, mountFieldsCard } from "./fields-card.js";
import { poundsText } from "./event-form.js";

const URL_BASE = "/api/admin/templates";
const MAX_TEMPLATES = 20;
const OFFLINE = "We couldn't reach the server. Check your connection and try again.";
const LOAD_FAILED = "We couldn't load your templates. Check your connection and try again.";
const PREVIEW_FAILED = "The preview couldn't be built.";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MISSING = "That template no longer exists. The list has been refreshed.";
// The preview uses a fixed winter date (London time is UTC then, so the times typed in the form show as typed) and
// these examples for anything the form leaves blank.
const SAMPLE = { name: "Spring Scent Trial", day: "2027-01-16", start: "09:00", end: "16:00", costPence: 1200, postcode: "AB1 2CD" };
const TOKENS = new Set(PLACEHOLDERS.map((p) => p.token));
const wholeNumber = (text) => (/^\d+$/.test(text) ? Number(text) : null);
const MAX_LANES = 10;
const plural = (n, one, many) => (n === 1 ? one : many);
/** "3 lanes × 2 places" for a template that isn't one lane with one place (the default), else null. */
const lanesLine = (t) => {
  const lanes = t.lanes?.length ?? 1;
  const places = t.capacity ?? 1;
  return lanes === 1 && places === 1 ? null : `${lanes} ${plural(lanes, "lane", "lanes")} × ${places} ${plural(places, "place", "places")}`;
};
/** "Fields: Dog, Handler" for a template whose booking form isn't the default one, else null. */
const fieldsLine = (t) => {
  const labels = Array.isArray(t.fields) ? t.fields.map((f) => f.label) : [];
  return labels.length === 0 || (labels.length === 1 && labels[0] === DEFAULT_FIELDS[0].label) ? null : `Fields: ${labels.join(", ")}`;
};
const summaryLine = (t) => `${t.start}–${t.end}, ${t.sessionMinutes} min sessions, ${formatPounds(t.costPence)}`;

/** The `{...}` words in the message that aren't placeholders: they are shown exactly as typed. */
export const unknownPlaceholders = (message) => [...new Set((message.match(/\{[^{}\s]+\}/g) ?? []).filter((t) => !TOKENS.has(t)))];

/**
 * Wires the templates page into `#app`: the list (make default, edit, delete with an inline confirmation) and the
 * create/edit form with a live preview of the share message. Everything a template holds is user input: it only ever
 * reaches the page through text nodes, textContent or .value. `settings` is the branding promise (see branding.js); the
 * club name in the preview comes from it once it has loaded. Resolves once the first load has settled.
 */
export async function init({ document, fetch, navigate, location, settings = null }) {
  const root = document.getElementById("app");
  const api = createApi({ fetch, navigate });
  const h = makeH(document);
  const show = (...nodes) => root.replaceChildren(...nodes);

  let clubName = "";
  let onClubName = () => {};
  settings?.then((s) => { if (s?.loaded) { clubName = s.clubName ?? ""; onClubName(); } }, () => {});

  try {
    if (!(await api.loadSession())) return;
  } catch {
    show(h("div", { class: "message", role: "alert" },
      h("p", {}, "We couldn't check that you're signed in. Check your connection and reload the page.")));
    return;
  }

  let templates = [];
  let busy = false;
  let panel = null; // the open delete confirmation
  // One live region for every result; it outlives re-renders so screen readers hear each change.
  const live = h("p", { class: "list-status", "aria-live": "polite", tabindex: "-1" });
  const say = (text) => { live.textContent = text; };

  const failure = (text) => {
    const retry = h("button", { type: "button", class: "button" }, "Retry");
    retry.addEventListener("click", load);
    show(h("div", { class: "message", role: "alert" }, h("p", {}, text), retry));
  };

  /** The list from the server: the templates, or null after showing why not (a 401 has already left the page). */
  async function fetchList() {
    let res;
    try {
      res = await api.request("GET", URL_BASE);
    } catch {
      return { error: LOAD_FAILED };
    }
    if (res.status === 401) return { signedOut: true };
    if (res.status !== 200 || !Array.isArray(res.data?.templates)) return { error: "We couldn't load your templates. Try again." };
    return { templates: res.data.templates };
  }

  async function load() {
    show(h("p", { class: "message", role: "status" }, "Loading templates…"));
    const got = await fetchList();
    if (got.signedOut) return;
    if (got.error) return failure(got.error);
    templates = got.templates;
    showList();
  }

  async function refresh(message) {
    const got = await fetchList();
    if (got.signedOut) return;
    if (got.templates) templates = got.templates;
    showList();
    say(got.templates ? message : `${message} We couldn't refresh the list, so reload the page to see it.`);
    live.focus();
  }

  /** One request at a time: everything on the page is disabled while it runs, and enabled again after. */
  async function perform(task) {
    if (busy) return;
    busy = true;
    const off = [...root.querySelectorAll("button:not(:disabled)")];
    for (const b of off) b.disabled = true;
    try {
      await task();
    } finally {
      busy = false;
      for (const b of off) b.disabled = false;
    }
  }

  const reason = (res) => res.data?.error?.message ?? Object.values(res.data?.fields ?? {})[0] ?? "Something went wrong. Try again.";

  // ---- list ----
  function showList() {
    panel = null;
    onClubName = () => {};
    const full = templates.length >= MAX_TEMPLATES;
    const create = h("button", { type: "button", class: "button primary big", disabled: full, "aria-describedby": full ? "limit-note" : null }, "New template");
    create.addEventListener("click", () => showForm(null));
    show(
      h("h1", {}, "Templates"),
      h("p", { class: "note" }, "A template fills in the details, times, cost, breaks, booking form and share message when you create an event."),
      create,
      ...(full ? [h("p", { class: "note", id: "limit-note" }, `You have ${MAX_TEMPLATES} templates, which is the most there can be. Delete one to make a new one.`)] : []),
      live,
      templates.length === 0
        ? h("p", { class: "message", role: "status" }, "No templates yet. Make one to save typing the same details for each event.")
        : h("ul", { class: "event-list", "aria-label": "Templates" }, ...templates.map(card)));
  }

  function card(t) {
    const li = h("li", { class: "event-card" },
      h("h2", {}, t.name),
      ...(t.isDefault ? [h("p", {}, h("span", { class: "badge open" }, "Default"))] : []),
      h("p", { class: "when" }, summaryLine(t)),
      ...(fieldsLine(t) ? [h("p", { class: "note" }, fieldsLine(t))] : []),
      ...(lanesLine(t) ? [h("p", { class: "note" }, lanesLine(t))] : []));
    const edit = h("button", { type: "button", class: "button", "aria-label": `Edit ${t.name}` }, "Edit");
    edit.addEventListener("click", () => { if (!busy) showForm(t); });
    const remove = h("button", { type: "button", class: "button", "aria-label": `Delete ${t.name}` }, "Delete");
    remove.addEventListener("click", () => {
      if (busy) return;
      panel?.remove();
      panel = deletePanel(t, () => { panel.remove(); panel = null; remove.focus(); });
      li.append(panel);
      panel.querySelector("button").focus();
    });
    const buttons = [edit];
    if (!t.isDefault) {
      const make = h("button", { type: "button", class: "button", "aria-label": `Make ${t.name} the default` }, "Make default");
      make.addEventListener("click", () => perform(async () => {
        // The list may be older than the server's copy (another tab), so build the body from a fresh GET.
        let res;
        try {
          res = await api.request("GET", `${URL_BASE}/${t.id}`);
          if (res.status === 200 && res.data?.template) {
            res = await api.request("PUT", `${URL_BASE}/${t.id}`, { ...bodyOf(res.data.template), isDefault: true });
          } else if (res.status === 200) {
            res = { status: 500, data: null };
          }
        } catch {
          return say(OFFLINE);
        }
        if (res.status === 401) return;
        if (res.status === 200) return refresh(`${t.name} is now the default.`);
        if (res.status === 404) return refresh(MISSING);
        say(`We couldn't make ${t.name} the default. ${reason(res)}`);
      }));
      buttons.push(make);
    }
    buttons.push(remove);
    li.append(h("div", { class: "manage" }, ...buttons));
    return li;
  }

  /** What the API takes back: the template as it is stored, without its id. */
  const bodyOf = (t) => ({
    name: t.name, details: t.details, venuePostcode: t.venuePostcode, costPence: t.costPence, start: t.start, end: t.end,
    sessionMinutes: t.sessionMinutes, gapMinutes: t.gapMinutes, breaks: t.breaks, shareMessage: t.shareMessage,
    lanes: t.lanes, capacity: t.capacity, fields: t.fields, identityLimit: t.identityLimit,
  });

  function deletePanel(t, cancel) {
    const error = h("p", { class: "form-error", role: "alert" });
    const confirmButton = h("button", { type: "button", class: "button danger" }, "Delete template");
    const cancelButton = h("button", { type: "button", class: "button" }, "Cancel");
    cancelButton.addEventListener("click", () => { if (!busy) cancel(); });
    confirmButton.addEventListener("click", () => perform(async () => {
      error.textContent = "";
      let res;
      try {
        res = await api.request("DELETE", `${URL_BASE}/${t.id}`);
      } catch {
        error.textContent = OFFLINE;
        return;
      }
      if (res.status === 401) return;
      if (res.status === 200) return refresh(`Deleted ${res.data?.deleted?.name ?? t.name}. Events already made from it are not changed.`);
      if (res.status === 404) return refresh(MISSING);
      error.textContent = reason(res);
    }));
    return h("div", { class: "confirm", role: "group", "aria-label": `Delete ${t.name}` },
      h("p", {}, "Delete the template ", h("strong", { class: "name-exact" }, t.name), "? Events already made from it are not changed. This can't be undone."),
      error,
      h("div", { class: "actions" }, confirmButton, cancelButton));
  }

  // ---- form ----
  /** `t` is the template to edit, or null for a new one. */
  function showForm(t) {
    const editing = t !== null;
    const locked = editing && t.isDefault; // the default can't be unset: another template has to take over
    const targets = new Set(); // { input, error }: every place an error can show
    const target = (id, input) => {
      const error = h("p", { id: `${id}-error`, class: "field-error", role: "alert" });
      const x = { input, error };
      targets.add(x);
      return x;
    };
    const control = (tag, id, attrs = {}) => h(tag, { id, name: id, "aria-describedby": `${id}-error`, ...attrs });
    /** A labelled control with its error line, and an optional hint between them. */
    function field(key, id, label, input, hint = null) {
      const x = target(id, input);
      fields.set(key, x);
      if (hint) input.setAttribute("aria-describedby", `${id}-hint ${id}-error`);
      return h("div", { class: "field" }, h("label", { for: id }, label), input,
        ...(hint ? [h("p", { class: "note", id: `${id}-hint` }, hint)] : []), x.error);
    }
    const fields = new Map(); // server field key -> target
    const timeInput = (id) => control("input", id, { type: "time", required: true });
    const minutesInput = (id, min, max) => control("input", id, { type: "number", inputmode: "numeric", min, max, step: 1, required: true });

    const name = control("input", "tpl-name", { type: "text", maxlength: "60", autocomplete: "off", required: true });
    const defaultBox = control("input", "tpl-default", { type: "checkbox" });
    defaultBox.setAttribute("aria-describedby", "tpl-default-hint tpl-default-error");
    defaultBox.checked = locked;
    defaultBox.disabled = locked;
    const defaultTarget = target("tpl-default", defaultBox);
    fields.set("isDefault", defaultTarget);
    const details = control("textarea", "tpl-details", { rows: "4", maxlength: "2000" });
    const postcode = control("input", "tpl-postcode", { type: "text", autocapitalize: "characters", autocomplete: "off", required: true });
    const cost = control("input", "tpl-cost", { type: "text", inputmode: "decimal", autocomplete: "off", required: true });
    const start = timeInput("tpl-start");
    const end = timeInput("tpl-end");
    const session = minutesInput("tpl-session", 1, 480);
    const gap = minutesInput("tpl-gap", 0, 120);
    const share = control("textarea", "tpl-share", { rows: "6", maxlength: "1000" });
    const capacity = control("input", "tpl-capacity", { type: "number", inputmode: "numeric", min: 1, max: 50, step: 1, required: true });
    const startLanes = editing && t.lanes?.length > 0 ? t.lanes.map((l) => ({ name: l.name })) : [{ name: "" }];
    const startCapacity = editing && Number.isInteger(t.capacity) ? t.capacity : 1;
    capacity.value = String(startCapacity);
    if (editing) {
      name.value = t.name;
      details.value = t.details;
      postcode.value = t.venuePostcode;
      cost.value = poundsText(t.costPence);
      start.value = t.start;
      end.value = t.end;
      session.value = String(t.sessionMinutes);
      gap.value = String(t.gapMinutes);
      share.value = t.shareMessage;
    }

    // Breaks: the same rows as the event form (start, end, optional name; add and remove).
    const breaksError = h("p", { id: "tpl-breaks-error", class: "field-error", role: "alert", tabindex: "-1" });
    const breaksTarget = { input: null, error: breaksError };
    targets.add(breaksTarget);
    fields.set("breaks", breaksTarget);
    const breakList = h("div", { class: "breaks" });
    const addBreak = h("button", { type: "button", class: "button" }, "Add break");
    const rows = [];
    let rowSeq = 0;
    function addRow(b) {
      const n = ++rowSeq;
      const cells = { start: null, end: null, label: null };
      const mk = (which, type, attrs) => {
        const id = `tpl-break-${n}-${which}`;
        const input = h("input", { id, name: id, type, "aria-describedby": `${id}-error`, ...attrs });
        input.value = b[which];
        cells[which] = target(id, input);
        return input;
      };
      const startInput = mk("start", "time", {});
      const endInput = mk("end", "time", {});
      const labelInput = mk("label", "text", { maxlength: "40", placeholder: "Lunch", autocomplete: "off" });
      const legend = h("legend", {});
      const remove = h("button", { type: "button", class: "button remove" }, "Remove");
      const row = { startInput, endInput, labelInput, cells, legend, remove };
      const cell = (which, input, text) => h("div", { class: "field" }, h("label", { for: input.id }, text), input, cells[which].error);
      row.el = h("fieldset", { class: "break-row" }, legend,
        h("div", { class: "field-row" }, cell("start", startInput, "Start"), cell("end", endInput, "End")),
        cell("label", labelInput, "Name (optional)"), remove);
      remove.addEventListener("click", () => {
        rows.splice(rows.indexOf(row), 1);
        for (const x of Object.values(cells)) targets.delete(x);
        row.el.remove();
        numberRows();
        addBreak.focus();
      });
      rows.push(row);
      breakList.append(row.el);
      numberRows();
    }
    function numberRows() {
      rows.forEach((r, i) => {
        r.legend.textContent = `Break ${i + 1}`;
        r.remove.setAttribute("aria-label", `Remove break ${i + 1}`);
      });
    }
    addBreak.addEventListener("click", () => {
      addRow({ start: "", end: "", label: "" });
      rows.at(-1).startInput.focus();
    });
    for (const b of editing ? t.breaks : []) addRow(b);
    const usedRows = () => rows.filter((r) => r.startInput.value !== "" || r.endInput.value !== "");

    // The booking form: the same card as the event form.
    const startFields = editing && Array.isArray(t.fields) && t.fields.length > 0 ? t.fields.map(({ label, required, maxLength, identity }) => ({ label, required, maxLength, identity })) : DEFAULT_FIELDS;
    const startLimit = editing && Number.isInteger(t.identityLimit) ? t.identityLimit : 1;
    const formCard = mountFieldsCard({ h, prefix: "tpl", fields: startFields, identityLimit: startLimit });

    // Lanes: one row per lane, names only (a template's lanes have no ids, and an event made from it gets its own copy).
    const lanesError = h("p", { id: "tpl-lanes-error", class: "field-error", role: "alert", tabindex: "-1" });
    const lanesTarget = { input: null, error: lanesError };
    targets.add(lanesTarget);
    fields.set("lanes", lanesTarget);
    const laneList = h("div", { class: "lanes" });
    const addLaneButton = h("button", { type: "button", class: "button" }, "Add lane");
    const laneRows = [];
    let laneSeq = 0;
    function addLane(name) {
      const id = `tpl-lane-${++laneSeq}-name`;
      const input = h("input", { id, name: id, type: "text", maxlength: "40", autocomplete: "off", "aria-describedby": `${id}-hint ${id}-error` });
      input.value = name;
      const cell = target(id, input);
      const legend = h("legend", {});
      const label = h("label", { for: id });
      const hint = h("p", { class: "note", id: `${id}-hint` }, "Leave blank if you only have one");
      const remove = h("button", { type: "button", class: "button remove" }, "Remove");
      const row = { input, cell, legend, label, hint, remove };
      remove.addEventListener("click", () => {
        laneRows.splice(laneRows.indexOf(row), 1);
        targets.delete(cell);
        row.el.remove();
        numberLanes();
        setError(lanesTarget, "");
        updatePreview();
        addLaneButton.focus();
      });
      row.el = h("fieldset", { class: "lane-row" }, legend, h("div", { class: "field" }, label, input, hint, cell.error), remove);
      laneRows.push(row);
      laneList.append(row.el);
      numberLanes();
      return row;
    }
    /** One lane: its name is optional and there is nothing to remove. Two or more: each is named, and any can be removed. */
    function numberLanes() {
      const one = laneRows.length === 1;
      laneRows.forEach((r, i) => {
        r.legend.textContent = `Lane ${i + 1}`;
        r.legend.className = one ? "visually-hidden" : "";
        r.label.textContent = one ? "Lane name (optional)" : "Name";
        r.input.required = !one;
        r.hint.hidden = !one;
        r.remove.hidden = one;
        r.remove.setAttribute("aria-label", `Remove lane ${i + 1}`);
      });
      addLaneButton.disabled = laneRows.length >= MAX_LANES;
    }
    addLaneButton.addEventListener("click", () => {
      addLane("").input.focus();
      setError(lanesTarget, "");
      updatePreview();
    });
    for (const l of startLanes) addLane(l.name);

    // The share message and its live preview.
    const placeholderList = h("dl", { class: "facts" },
      ...PLACEHOLDERS.flatMap((p) => [h("dt", {}, p.token), h("dd", {}, p.meaning)]));
    const previewText = h("pre", { class: "share-preview", id: "tpl-preview" });
    const blankNote = h("p", { class: "note", id: "tpl-preview-note" });
    const unknownNote = h("p", { class: "note", id: "tpl-unknown", "aria-live": "polite" });

    const blankMessage = "This template's share message is blank, so the preview shows the built-in message. An event with no message of its own is shared with the default template's message, or this built-in one when that is blank too.";
    function updatePreview() {
      const blank = share.value.trim() === "";
      const message = blank ? BUILT_IN_SHARE_TEMPLATE : share.value;
      const priced = penceFromPounds(cost.value);
      const time = (input, fallback) => (TIME.test(input.value) ? input.value : fallback);
      try {
        previewText.textContent = buildShareMessage({
          event: {
            name: SAMPLE.name,
            startUtc: `${SAMPLE.day}T${time(start, SAMPLE.start)}:00Z`,
            endUtc: `${SAMPLE.day}T${time(end, SAMPLE.end)}:00Z`,
            costPence: "pence" in priced ? priced.pence : SAMPLE.costPence,
            venuePostcode: postcode.value.trim() || SAMPLE.postcode,
            details: details.value.trim(),
            lanes: laneRows.map((r) => ({ name: r.input.value })),
          },
          clubName,
          link: `${location.origin}/e/example`,
          template: message,
        });
      } catch {
        previewText.textContent = PREVIEW_FAILED;
      }
      blankNote.textContent = blank ? blankMessage : "";
      const unknown = unknownPlaceholders(message);
      unknownNote.textContent = unknown.length > 0 ? `These will appear as typed: ${unknown.join(", ")}` : "";
    }
    onClubName = updatePreview;

    const summary = h("p", { class: "form-error", role: "alert", tabindex: "-1" });
    const save = h("button", { type: "submit", class: "button primary" }, editing ? "Save changes" : "Create template");
    const back = h("a", { class: "back", href: "/admin/templates" }, "Back to templates");
    const heading = h("h1", { tabindex: "-1" }, editing ? "Edit template" : "New template");

    const form = h("form", { id: "template-form", novalidate: true },
      summary,
      field("name", "tpl-name", "Template name", name),
      h("div", { class: "field" },
        h("label", { class: "select-all", for: "tpl-default" }, defaultBox, "Use as the default for new events"),
        h("p", { class: "note", id: "tpl-default-hint" }, locked
          ? "To change the default, make another template the default"
          : "The default template fills in each new event automatically, and its share message is used for events with none of their own."),
        defaultTarget.error),
      field("details", "tpl-details", "Details (optional)", details),
      field("venuePostcode", "tpl-postcode", "Venue postcode", postcode),
      field("costPence", "tpl-cost", "Cost (£)", cost),
      h("div", { class: "field-row" }, field("start", "tpl-start", "Start time", start), field("end", "tpl-end", "End time", end)),
      h("div", { class: "field-row" },
        field("sessionMinutes", "tpl-session", "Session length (minutes)", session),
        field("gapMinutes", "tpl-gap", "Gap between sessions (minutes)", gap)),
      h("fieldset", { class: "breaks-group" }, h("legend", {}, "Breaks (optional)"), breakList, breaksError, addBreak),
      formCard.el,
      h("fieldset", { class: "breaks-group lanes-group" },
        h("legend", {}, "Lanes"),
        h("p", { class: "note" }, "Lanes run side by side at the same time, such as separate rings. Most events have just one."),
        laneList, lanesError, addLaneButton,
        field("capacity", "tpl-capacity", "Places per lane per time", capacity,
          "How many bookings each lane takes at the same time. Leave it at 1 for one booking per time.")),
      field("shareMessage", "tpl-share", "Share message (optional)", share,
        "Used when you share an event made from this template. Leave it blank to use the built-in message."),
      h("p", { class: "note" }, "Placeholders are filled in when an event is shared:"),
      placeholderList,
      h("p", { class: "note" },
        "A placeholder that isn't in this list is left exactly as you typed it. If you leave out {link}, the booking link is added as the last line."),
      h("section", { class: "share-preview-box", "aria-labelledby": "tpl-preview-heading" },
        h("h3", { id: "tpl-preview-heading" }, "Preview"),
        h("p", { class: "note" }, "A sample event called Spring Scent Trial, built from this form. Anything left blank above shows an example."),
        previewText, blankNote, unknownNote),
      save);

    function setError(x, message) {
      x.error.textContent = message;
      if (!x.input) return;
      if (message) x.input.setAttribute("aria-invalid", "true");
      else x.input.removeAttribute("aria-invalid");
    }
    const clearErrors = () => { summary.textContent = ""; for (const x of targets) setError(x, ""); formCard.showErrors({}, []); };
    // First in page order: the first field marked invalid, else the booking form's, breaks' or lanes' message, else the summary.
    const focusFirstError = () => (form.querySelector("[aria-invalid='true']")
      ?? (formCard.listError.textContent ? formCard.listError : breaksError.textContent ? breaksError : lanesError.textContent ? lanesError : summary)).focus();

    form.addEventListener("input", (e) => {
      const x = [...targets].find((y) => y.input === e.target);
      if (x) setError(x, "");
      updatePreview();
    });

    let saving = false;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (saving) return;
      clearErrors();
      const priced = penceFromPounds(cost.value);
      if ("error" in priced) {
        setError(fields.get("costPence"), priced.error);
        return focusFirstError();
      }
      const used = usedRows();
      // Only what differs from the template as it was (a new one: one unnamed lane, one place): left out, the server keeps it.
      const lanes = laneRows.map((r) => ({ name: r.input.value.trim() }));
      const places = wholeNumber(capacity.value.trim());
      const card = formCard.read();
      const body = {
        name: name.value.trim(), details: details.value.trim(), venuePostcode: postcode.value.trim(), costPence: priced.pence,
        start: start.value, end: end.value, sessionMinutes: wholeNumber(session.value.trim()), gapMinutes: wholeNumber(gap.value.trim()),
        breaks: used.map((r) => ({ start: r.startInput.value, end: r.endInput.value, label: r.labelInput.value })),
        shareMessage: share.value.trim(),
        ...(JSON.stringify(lanes) === JSON.stringify(startLanes) ? {} : { lanes }),
        ...(places === startCapacity ? {} : { capacity: places }),
        ...(editing && JSON.stringify(card.fields) === JSON.stringify(startFields) ? {} : { fields: card.fields }),
        ...(editing && card.identityLimit === startLimit ? {} : { identityLimit: card.identityLimit }),
        ...(locked ? {} : { isDefault: defaultBox.checked }),
      };
      saving = true;
      save.disabled = true;
      form.setAttribute("aria-busy", "true");
      let res = null;
      try {
        res = await api.request(editing ? "PUT" : "POST", editing ? `${URL_BASE}/${t.id}` : URL_BASE, body);
      } catch { /* reported below */ }
      saving = false;
      save.disabled = false;
      form.removeAttribute("aria-busy");
      if (res?.status === 401) return;
      if ((res?.status === 200 || res?.status === 201) && res.data?.template) {
        return refresh(`${editing ? "Saved" : "Created"} ${res.data.template.name}.`);
      }
      if (res?.status === 400 && res.data?.fields) {
        const unplaced = [];
        const cardErrors = {};
        for (const [key, message] of Object.entries(res.data.fields)) {
          if (key === "fields" || key === "identityLimit" || key.startsWith("fields.")) { cardErrors[key] = message; continue; }
          const m = /^breaks\.(\d+)\.(start|end|label)$/.exec(key);
          const lane = /^lanes\.(\d+)\.name$/.exec(key);
          const x = m ? used[Number(m[1])]?.cells[m[2]] : lane ? laneRows[Number(lane[1])]?.cell
            : key.startsWith("breaks.") ? breaksTarget : key.startsWith("lanes.") ? lanesTarget : fields.get(key);
          if (x) setError(x, message);
          else unplaced.push(message);
        }
        formCard.showErrors(cardErrors, card.keys);
        if (unplaced.length > 0 || (Object.keys(cardErrors).length === 0 && ![...targets].some((x) => x.error.textContent))) {
          summary.textContent = unplaced.join(" ") || res.data.error?.message || "We couldn't save the template. Try again.";
        }
        return focusFirstError();
      }
      summary.textContent = !res ? OFFLINE
        : res.status === 404 ? "This template no longer exists. Go back to the list to see what is left."
        : res.data?.error?.message ?? "We couldn't save the template. Try again.";
      summary.focus();
    });

    back.addEventListener("click", (e) => {
      e.preventDefault();
      showList();
    });
    show(back, heading, form);
    updatePreview();
    heading.focus();
  }

  return load();
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  const settings = loadSettings((...args) => fetch(...args));
  brandPage(document, settings, { pageTitle: document.title, home: "/admin/" });
  init({
    document, location, settings,
    fetch: (...args) => fetch(...args),
    navigate: (url) => location.assign(url),
  });
}

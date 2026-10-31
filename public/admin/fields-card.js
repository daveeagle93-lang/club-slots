// The "Booking form" card of the event form and the template form: one to four fields, each with a label, a required flag, a
// longest value and whether it identifies a booking, and how many bookings one identity may hold. It keeps its own errors:
// the page hands it the server's error keys (`fields`, `fields.N.label`, `.required`, `.maxLength`, `.identity`, `identityLimit`).

export const MAX_FIELDS = 4;
const MAX_LABEL = 40;
const MAX_LENGTH = 80;
const MAX_LIMIT = 20;
/** What a new event or template has: one required field, "Name", that identifies the booking. */
export const DEFAULT_FIELDS = [{ label: "Name", required: true, maxLength: MAX_LENGTH, identity: true }];

const INTRO = "What people fill in when they book: one to four fields. The first field is always required, and so is every field that identifies a booking.";
const LIMIT_NOTE = "1 means each can only book once. The most you can allow is 20.";
export const LOCKED_NOTE = "Bookings exist, so you can't add or remove fields or change which ones identify a booking. You can still rename them and change the other settings.";
const wholeNumber = (text) => (/^\d+$/.test(text) ? Number(text) : null);
const KEY = /^fields\.(\d+)(?:\.(label|required|maxLength|identity))?$/;

/**
 * `prefix` keeps the element ids apart from the rest of the page. `onChange()` is called when the person changes anything in the
 * card (not when the page sets it). Returns the card's element and its controls: `read()`, `set()`, `lock()`,
 * `showErrors()`, `showMessage()` and `focusFirstError()`.
 */
export function mountFieldsCard({ h, prefix, fields = DEFAULT_FIELDS, identityLimit = 1, locked = false, onChange = () => {} }) {
  const rows = []; // { key, el, legend, labelInput, requiredBox, requiredHint, maxInput, identityBox, remove }
  const targets = new Map(); // error key -> { input (or null), error }
  let nextKey = 1;

  const target = (key, id, input) => {
    const error = h("p", { id: `${id}-error`, class: "field-error", role: "alert" });
    targets.set(key, { input, error });
    return error;
  };

  const listError = h("p", { id: `${prefix}-fields-error`, class: "field-error", role: "alert", tabindex: "-1" });
  targets.set("fields", { input: null, error: listError });
  const lockedNote = h("p", { class: "note", id: `${prefix}-fields-locked`, hidden: true }, LOCKED_NOTE);
  const list = h("div", { class: "fields-list" });
  const add = h("button", { type: "button", class: "button" }, "Add field");

  const limitInput = h("input", {
    id: `${prefix}-identity-limit`, name: `${prefix}-identity-limit`, type: "number", inputmode: "numeric", min: 1, max: MAX_LIMIT, step: 1, required: true,
    "aria-describedby": `${prefix}-identity-limit-hint ${prefix}-identity-limit-error`,
  });
  limitInput.value = String(identityLimit);
  const limitLabel = h("label", { for: limitInput.id });
  const limitError = target("identityLimit", limitInput.id, limitInput);

  function addRow(draft) {
    const key = nextKey++;
    const id = (what) => `${prefix}-field-${key}-${what}`;
    const labelInput = h("input", { id: id("label"), name: id("label"), type: "text", maxlength: String(MAX_LABEL), autocomplete: "off", "aria-describedby": `${id("label")}-error` });
    labelInput.value = draft.label;
    const requiredBox = h("input", { id: id("required"), name: id("required"), type: "checkbox", "aria-describedby": `${id("required")}-hint ${id("required")}-error` });
    requiredBox.checked = draft.required;
    const maxInput = h("input", {
      id: id("max"), name: id("max"), type: "number", inputmode: "numeric", min: 1, max: MAX_LENGTH, step: 1, "aria-describedby": `${id("max")}-error`,
    });
    maxInput.value = String(draft.maxLength);
    const identityBox = h("input", { id: id("identity"), name: id("identity"), type: "checkbox", "aria-describedby": `${id("identity")}-error` });
    identityBox.checked = draft.identity;
    const requiredHint = h("p", { class: "note", id: `${id("required")}-hint`, hidden: true });
    const errors = {
      label: target(`fields.${key}.label`, id("label"), labelInput), required: target(`fields.${key}.required`, id("required"), requiredBox),
      maxLength: target(`fields.${key}.maxLength`, id("max"), maxInput), identity: target(`fields.${key}.identity`, id("identity"), identityBox),
    };
    const legend = h("legend", {});
    const remove = h("button", { type: "button", class: "button remove" }, "Remove");
    const row = { key, legend, labelInput, requiredBox, requiredHint, maxInput, identityBox, remove };
    remove.addEventListener("click", () => {
      rows.splice(rows.indexOf(row), 1);
      for (const what of ["label", "required", "maxLength", "identity"]) targets.delete(`fields.${key}.${what}`);
      row.el.remove();
      clearList();
      refresh();
      add.focus();
      onChange();
    });
    row.el = h("fieldset", { class: "field-def" }, legend,
      h("div", { class: "field" }, h("label", { for: id("label") }, "Label"), labelInput, errors.label),
      h("div", { class: "field-row" },
        h("div", { class: "field" }, h("label", { class: "select-all", for: id("required") }, requiredBox, "Required"), requiredHint, errors.required),
        h("div", { class: "field" }, h("label", { class: "select-all", for: id("identity") }, identityBox, "Identifies a booking"), errors.identity)),
      h("div", { class: "field" }, h("label", { for: id("max") }, "Max length"), maxInput, errors.maxLength),
      remove);
    rows.push(row);
    list.append(row.el);
    return row;
  }

  function clearList() {
    listError.textContent = "";
  }

  /** The numbering, what the shape rules force, what the lock disables and the identity limit's question. */
  function refresh() {
    rows.forEach((r, i) => {
      r.legend.textContent = `Field ${i + 1}`;
      const identity = r.identityBox.checked;
      const forced = i === 0 || identity;
      if (forced) r.requiredBox.checked = true;
      r.requiredBox.disabled = forced;
      r.requiredHint.textContent = forced ? (identity ? "Always required: it identifies a booking." : "The first field is always required.") : "";
      r.requiredHint.hidden = !forced;
      r.identityBox.disabled = locked;
      r.remove.hidden = rows.length === 1;
      r.remove.disabled = locked;
      r.remove.setAttribute("aria-label", `Remove field ${i + 1}`);
    });
    add.disabled = locked || rows.length >= MAX_FIELDS;
    lockedNote.hidden = !locked;
    const names = rows.flatMap((r, i) => (r.identityBox.checked ? [r.labelInput.value.trim() || `field ${i + 1}`] : []));
    limitLabel.textContent = `How many bookings can one ${names.length > 0 ? names.join(" + ") : "identity"} make?`;
  }

  function setRows(drafts) {
    for (const r of [...rows]) {
      for (const what of ["label", "required", "maxLength", "identity"]) targets.delete(`fields.${r.key}.${what}`);
      r.el.remove();
    }
    rows.length = 0;
    for (const d of drafts) addRow(d);
  }

  const handle = (e) => {
    const x = [...targets.values()].find((t) => t.input === e.target);
    if (x) showText(x, "");
    clearList();
    refresh();
    onChange();
  };

  add.addEventListener("click", () => {
    const row = addRow({ label: "", required: false, maxLength: MAX_LENGTH, identity: false });
    clearList();
    refresh();
    row.labelInput.focus();
    onChange();
  });

  for (const d of fields) addRow(d);
  refresh();

  const el = h("fieldset", { class: "breaks-group fields-group" },
    h("legend", {}, "Booking form"),
    h("p", { class: "note" }, INTRO),
    lockedNote, list, listError, add,
    h("div", { class: "field" }, limitLabel, limitInput, h("p", { class: "note", id: `${prefix}-identity-limit-hint` }, LIMIT_NOTE), limitError));
  el.addEventListener("input", handle);
  el.addEventListener("change", handle);

  function showText(x, message) {
    x.error.textContent = message;
    if (!x.input) return;
    if (message) x.input.setAttribute("aria-invalid", "true");
    else x.input.removeAttribute("aria-invalid");
  }

  return {
    el,
    /** The message about the card as a whole (the list of fields): its element, to focus. */
    listError,
    /** The card as a request would carry it. `keys` are the rows' keys in order, to hand back to showErrors with the answer. */
    read: () => ({
      keys: rows.map((r) => r.key),
      fields: rows.map((r) => ({
        label: r.labelInput.value.trim(), required: r.requiredBox.checked, maxLength: wholeNumber(r.maxInput.value.trim()), identity: r.identityBox.checked,
      })),
      identityLimit: wholeNumber(limitInput.value.trim()),
    }),
    /** Replaces the fields and the identity limit (a template was chosen); any errors go. */
    set(next, limit) {
      setRows(next);
      limitInput.value = String(limit);
      for (const t of targets.values()) showText(t, "");
      refresh();
    },
    lock(on) {
      locked = on;
      refresh();
    },
    /** Shows the server's field errors (by key, rows numbered as in `read().keys`): each next to its control, else at the card. */
    showErrors(errors, keys) {
      const texts = new Map();
      for (const [key, message] of Object.entries(errors)) {
        const m = KEY.exec(key);
        const rowKey = m ? keys[Number(m[1])] : undefined;
        const t = key === "identityLimit" ? targets.get(key) : m?.[2] && rowKey !== undefined ? targets.get(`fields.${rowKey}.${m[2]}`) : targets.get("fields");
        const x = t ?? targets.get("fields");
        texts.set(x, [...(texts.get(x) ?? []), message]);
      }
      for (const t of targets.values()) showText(t, (texts.get(t) ?? []).join(" "));
    },
    /** A message about the card as a whole (the server refused the shape because bookings exist). */
    showMessage(text) {
      showText(targets.get("fields"), text);
    },
    focusFirstError() {
      [...el.querySelectorAll("[aria-invalid='true'], .field-error")].find((x) => x.getAttribute("aria-invalid") === "true" || x.textContent !== "")?.focus();
    },
  };
}

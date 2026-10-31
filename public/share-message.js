// The one builder for the message an admin shares about an event (Share, Copy message, the post-create page).
// Pure: no DOM, no network.
//
// The result is PLAIN TEXT built from user input (event name, details, club name). It must only ever reach the
// page through textContent or .value, navigator.share, the clipboard or encodeURIComponent: never innerHTML or
// insertAdjacentHTML.

import { formatDate, formatPounds, formatTime } from "./lib.js";

export const BUILT_IN_SHARE_TEMPLATE = "{club}\n{event}\n{date}, {start}–{end}\nVenue: {postcode}\nCost: {cost}\nBook your slot:\n{link}";

/** Every placeholder a template may use, with what it stands for. The template editor shows this list. */
export const PLACEHOLDERS = [
  { token: "{event}", meaning: "The event name" },
  { token: "{date}", meaning: "The date, for example Saturday 13 June 2026" },
  { token: "{start}", meaning: "The start time, for example 09:00" },
  { token: "{end}", meaning: "The end time, for example 16:00" },
  { token: "{cost}", meaning: "The cost, for example £12.00, or Free" },
  { token: "{postcode}", meaning: "The venue postcode" },
  { token: "{details}", meaning: "The event's details text" },
  { token: "{lanes}", meaning: "The lane names, separated by commas (blank when the event has one unnamed lane)" },
  { token: "{club}", meaning: "Your club name" },
  { token: "{link}", meaning: "The booking link" },
];

/** The event's own message, else the default template's, else the built-in one. */
export const pickShareTemplate = (event, defaultShareMessage) =>
  event.shareMessage || defaultShareMessage || BUILT_IN_SHARE_TEMPLATE;

/**
 * Fills the `{name}` placeholders of `template` from `values` in a single pass: a value is inserted literally and
 * never expanded again. Placeholders that aren't in `values` (`{foo}`, `{Event}`) are left exactly as typed. A line
 * with a known placeholder that renders to only whitespace is dropped; other lines are kept as typed.
 */
export function renderShareTemplate(template, values) {
  const lines = [];
  for (const line of String(template).replace(/\r\n/g, "\n").split("\n")) {
    let known = false;
    const rendered = line.replace(/\{([a-z]+)\}/g, (whole, name) => {
      if (!Object.hasOwn(values, name)) return whole;
      known = true;
      return String(values[name] ?? "");
    });
    if (known && rendered.trim() === "") continue;
    lines.push(rendered);
  }
  return lines.join("\n");
}

/** The longest message buildShareMessage returns, in UTF-16 code units (what String#length counts). */
export const MAX_SHARE_MESSAGE_LENGTH = 4000;

// Values are cleaned before they are substituted: a stored name or details can still hold characters the server
// only learned to refuse later (for example U+202E, which reverses the text after it), and an edit may keep them.
// \p{Cf} includes U+200D (zero width joiner), so a joined emoji such as a family is shown as its separate emoji: accepted.
// Other emoji (and U+FE0F, which is not Cf) are untouched. The template text itself is not cleaned: the server validates it.
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/gu;
const CONTROLS = /[\p{Cc}]/gu;
const CONTROLS_EXCEPT_NEWLINE = /[^\P{Cc}\n]/gu;
const multiLine = (value) => String(value ?? "").replace(CONTROLS_EXCEPT_NEWLINE, "").replace(INVISIBLE, "");
const oneLine = (value) => String(value ?? "").replace(/\r/g, "").replace(/\n/g, " ").replace(CONTROLS, "").replace(INVISIBLE, "");
// The link is built by the page, so only control characters (including line breaks) can be wrong in it.
const linkText = (value) => String(value ?? "").replace(CONTROLS, "");

/** The first `limit` code units of `value`, without ending on the first half of a surrogate pair. */
const clip = (value, limit) => {
  const last = value.charCodeAt(limit - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
};

/**
 * `event` has name, startUtc, endUtc, costPence, venuePostcode and details, and may have `lanes` (a list of `{ name }`, as the
 * admin API gives them: `{lanes}` is their names joined with ", ", blank for one unnamed lane or when there are none);
 * `template` is the text to render
 * (see pickShareTemplate). Without a {link} in the template, the link goes on its own final line. The result is at
 * most MAX_SHARE_MESSAGE_LENGTH code units (a wa.me link made from it stays a sane length): a longer message is cut at
 * a code point and "…" is added. When the link is the last line (no {link} in the template) only the text before it is
 * cut and the link is kept; when {link} is in the template the whole message is cut, wherever the link is.
 */
export function buildShareMessage({ event, clubName = "", link, template }) {
  const cleanLink = linkText(link);
  const body = renderShareTemplate(template, {
    event: oneLine(event.name),
    date: formatDate(event.startUtc),
    start: formatTime(event.startUtc),
    end: formatTime(event.endUtc),
    cost: formatPounds(event.costPence),
    postcode: oneLine(event.venuePostcode),
    details: multiLine(event.details),
    lanes: (event.lanes ?? []).map((l) => oneLine(l.name)).filter((name) => name !== "").join(", "),
    club: oneLine(clubName),
    link: cleanLink,
  }).trimEnd();
  const linked = /\{link\}/.test(String(template));
  const message = linked ? body : body === "" ? cleanLink : `${body}\n${cleanLink}`;
  if (message.length <= MAX_SHARE_MESSAGE_LENGTH) return message;
  const room = MAX_SHARE_MESSAGE_LENGTH - cleanLink.length - 2; // the line break and the "…"
  if (linked || room < 0) return `${clip(message, MAX_SHARE_MESSAGE_LENGTH - 1)}…`;
  return `${clip(body, room)}…\n${cleanLink}`;
}

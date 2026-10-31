import { identityKey } from "../core/identity";
import { londonToUtc, LondonTimeError, utcToLondon } from "../core/london";
import { DEFAULT_NEAR_MISS_MINUTES, generateSchedule, type TimeRange } from "../core/schedule";
import { generateSlug } from "../core/slug";
import { IDEMPOTENCY_KEY, INVISIBLE, invisibleMessage, LINE_SEPARATORS, noStore, readJsonObject } from "./bookings";
import { bookingWindow, fieldOf, layoutRepairStatements, type EventRow, type RawField } from "./events";
import { DEFAULT_FIELDS, draftsOf, LEGACY_FIELDS, MAX_FIELD_LABEL_CODE_POINTS, MAX_FIELD_LENGTH, MAX_FIELDS, MAX_IDENTITY_LIMIT, withPositions, type FieldDraft } from "./fields";
import { errorResponse } from "./http";

const MAX_NAME_CODE_POINTS = 100;
const MAX_LABEL_CODE_POINTS = 40;
const MAX_DETAILS_CODE_POINTS = 2000;
const MAX_SHARE_MESSAGE_CODE_POINTS = 1000;
const MAX_BREAKS = 20;
const MAX_SLOTS = 500;
const MAX_LANES = 10;
const MAX_LANE_NAME_CODE_POINTS = 40;
const MAX_CAPACITY = 50;
/** Time slots times lanes times places per lane: the most places one event may have. */
const MAX_PLACES = 2000;
const MAX_DAYS_AHEAD = 730;
const MAX_LIST = 100;
const MAX_BODY_BYTES = 32_768;
// Any date works to check that a time is well formed; this one is not near a clock change.
export const PROBE_DATE = "2026-01-15";

export interface EventDraft {
  name: string;
  /** London local: YYYY-MM-DD and HH:MM. */
  date: string; start: string; end: string;
  sessionMinutes: number; gapMinutes: number; costPence: number;
  venuePostcode: string; details: string;
  /** The text the Share button builds its message from; undefined when the request didn't say (create: ""; edit: unchanged). */
  shareMessage?: string;
  /** Whether the landing page lists the event; undefined when the request didn't say (create: listed; edit: unchanged). */
  listed?: boolean;
  startUtc: string; endUtc: string;
  breaks: { start: string; end: string; label: string; startUtc: string; endUtc: string }[];
  /**
   * The lanes in order; undefined when the request didn't say (create: one unnamed lane; edit: unchanged). On an edit a lane
   * with an `id` is that lane of the event (renamed or moved), one without is new, and a lane of the event that is not listed
   * is removed. A new event's and a template's lanes have no ids.
   */
  lanes?: LaneDraft[];
  /** Places per lane per time; undefined when the request didn't say (create: 1; edit: unchanged). */
  capacity?: number;
  /** The booking form's fields in order; undefined when the request didn't say (create: one required "Name" field that is the identity; edit: unchanged). */
  fields?: FieldDraft[];
  /** How many bookings one identity may hold; undefined when the request didn't say (create: 1; edit: unchanged). */
  identityLimit?: number;
  /**
   * The `config_rev` of the page the edit was made on: an edit that sends `lanes`, `capacity`, `fields` or `identityLimit` must carry
   * it (parseEventDraft refuses it otherwise) and is refused if the stored one has moved on. Undefined for a create, a template, or an
   * edit that sends none of those.
   */
  configRev?: number;
}

export interface LaneDraft { id?: number; name: string }

/** What an edit knows of the stored layout: the lane ids a request may name, and the numbers an omitted `lanes` or `capacity` keeps. */
export interface StoredLayout { laneIds: readonly number[]; capacity: number }

type Fields = Record<string, string>;

const BAD_TIME = "Enter a time as HH:MM.";
const CLOCK_MESSAGE = {
  invalid: BAD_TIME,
  nonexistent: "That time doesn't exist in London on that date (the clocks go forward).",
  ambiguous: "That time happens twice in London on that date (the clocks go back).",
};

function londonTime(date: string, value: unknown): { utc: string } | { message: string } {
  if (typeof value !== "string") return { message: BAD_TIME };
  try {
    return { utc: londonToUtc(date, value) };
  } catch (e) {
    if (!(e instanceof LondonTimeError)) throw e;
    return { message: CLOCK_MESSAGE[e.kind] };
  }
}

/**
 * The text an edit may keep without the invisible-character check: what is stored now. Rows written before that
 * check existed can hold such a character, and an admin changing only the cost must not be locked out by it.
 */
export interface StoredText { name: string; details: string; shareMessage: string; breakLabels: readonly string[] }

/** `what` is the field as the sentences name it: the event's name by default, "template name" for a template's. */
export function checkName(
  value: unknown, stored?: string, what = "event name", max = MAX_NAME_CODE_POINTS,
): { name: string } | { message: string } {
  if (typeof value !== "string") return { message: `Enter the ${what}.` };
  if (!value.isWellFormed()) return { message: `The ${what} can't contain unpaired surrogate characters.` };
  if (value !== stored && INVISIBLE.test(value)) return { message: invisibleMessage(what) };
  if (LINE_SEPARATORS.test(value)) return { message: `The ${what} can't contain line or paragraph separators.` };
  const name = value.trim();
  if (name === "") return { message: `Enter the ${what}.` };
  if ([...name].length > max) return { message: `The ${what} must be at most ${max} characters.` };
  if (/\p{Cc}/u.test(name)) return { message: `The ${what} can't contain control characters.` };
  return { name };
}

/** Lane names and field labels already stored, which an edit may keep as they are even where today's rules would refuse them (rows written before those rules). */
export interface KeptNames { laneNames: readonly string[]; fieldLabels: readonly string[] }

/**
 * A lane's name or a field's label: the rules of an event's name (checkName) and then those of a booking's values, so a name can't
 * look like another or like nothing. Default-ignorable characters (variation selectors, Hangul fillers and the like: they draw as
 * nothing, so "Ring 1" and "Ring 1" + U+FE0F would look the same) are refused outright with the invisible-character message; so are
 * private-use characters and the braille blank (U+2800); and there must be a letter or a number. `kept` are the names the event already
 * has: a value equal to one of them is only held to checkName's rules and may keep what the later ones would refuse.
 */
export function checkTitle(
  value: unknown, kept: readonly string[], what: string, max: number,
): { name: string } | { message: string } {
  const keep = typeof value === "string" && kept.includes(value);
  const checked = checkName(value, keep ? value : undefined, what, max);
  if ("message" in checked || keep) return checked;
  const { name } = checked;
  if (/\p{Default_Ignorable_Code_Point}/u.test(name)) return { message: invisibleMessage(what) };
  if (!/[\p{L}\p{N}]/u.test(name)) return { message: `The ${what} must contain at least one letter or number.` };
  if (/[\p{Co}\u2800]/u.test(name)) return { message: `The ${what} can't contain private-use or blank-looking characters. Try plain text.` };
  return checked;
}

/** A break's optional name: missing, undefined or null means unnamed (""). */
function checkLabel(value: unknown, stored: readonly string[] = []): { label: string } | { message: string } {
  if (value === undefined || value === null) return { label: "" };
  if (typeof value !== "string") return { message: "The break name must be text." };
  if (!value.isWellFormed()) return { message: "The break name can't contain unpaired surrogate characters." };
  if (!stored.includes(value) && INVISIBLE.test(value)) return { message: invisibleMessage("break name") };
  if (LINE_SEPARATORS.test(value)) return { message: "The break name can't contain line or paragraph separators." };
  const label = value.trim();
  if ([...label].length > MAX_LABEL_CODE_POINTS) return { message: `The break name must be at most ${MAX_LABEL_CODE_POINTS} characters.` };
  if (/\p{Cc}/u.test(label)) return { message: "The break name can't contain control characters." };
  return { label };
}

/**
 * Lenient on purpose: this is not UK postcode validation, so the app can be reused for venues in other
 * countries. It only keeps the value short, printable and tidy (trimmed, one space, upper case).
 */
function checkPostcode(value: unknown): { postcode: string } | { message: string } {
  const tidy = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!/^[A-Za-z0-9 ]{2,10}$/.test(tidy)) return { message: "Enter a venue postcode of 2 to 10 letters and numbers." };
  return { postcode: tidy.toUpperCase() };
}

/** Free text that may be empty and have several lines (\r\n becomes \n), kept as written: the details and the share message. */
function checkFreeText(
  value: unknown, what: string, max: number, notText: string, stored?: string,
): { text: string } | { message: string } {
  if (typeof value !== "string") return { message: notText };
  if (!value.isWellFormed()) return { message: `The ${what} can't contain unpaired surrogate characters.` };
  if (value !== stored && INVISIBLE.test(value)) return { message: invisibleMessage(what) };
  if (LINE_SEPARATORS.test(value)) return { message: `The ${what} can't contain line or paragraph separators.` };
  const text = value.replaceAll("\r\n", "\n");
  if (/(?!\n)\p{Cc}/u.test(text)) return { message: `The ${what} can't contain control characters.` };
  if ([...text].length > max) return { message: `The ${what} must be at most ${max} characters.` };
  return { text };
}

function checkDetails(value: unknown, stored?: string): { details: string } | { message: string } {
  const r = checkFreeText(value, "details", MAX_DETAILS_CODE_POINTS, "Details must be text (they can be empty).", stored);
  return "text" in r ? { details: r.text } : r;
}

/**
 * Placeholders such as {event} are not parsed or restricted here: the server stores the text as written, and the
 * browser fills the placeholders in and shows the result as plain text.
 */
function checkShareMessage(value: unknown, stored?: string): { text: string } | { message: string } {
  return checkFreeText(value, "share message", MAX_SHARE_MESSAGE_CODE_POINTS, "The share message must be text (it can be empty).", stored);
}

const checkInteger = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A lane's `id`: absent or null means a new lane; otherwise one of the stored lane ids, listed once. */
function checkLaneId(value: unknown, stored: StoredLayout | undefined, seen: Set<number>): { id?: number } | { message: string } {
  if (value === undefined || value === null) return {};
  if (!stored) return { message: "A new event's lanes don't have an id." };
  if (typeof value !== "number" || !stored.laneIds.includes(value)) return { message: "That isn't one of this event's lanes." };
  if (seen.has(value)) return { message: "That lane is listed twice." };
  seen.add(value);
  return { id: value };
}

/**
 * The lanes of a create, an edit or a template. One lane may be unnamed (the name is ""); with two or more every lane needs a
 * name (checkTitle), and names must have different identity keys (the database's index only ignores ASCII case, so this is the stricter rule).
 * Errors are keyed `lanes` (the list), `lanes.N` (an item) and `lanes.N.name` or `lanes.N.id`.
 */
function parseLanes(value: unknown, stored: StoredLayout | undefined, kept: readonly string[], fields: Fields): LaneDraft[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fields.lanes = "Lanes must be a list.";
  else if (value.length === 0) fields.lanes = "An event needs at least one lane.";
  else if (value.length > MAX_LANES) fields.lanes = `You can have at most ${MAX_LANES} lanes.`;
  else {
    const lanes: LaneDraft[] = [];
    const seenIds = new Set<number>();
    const seenNames = new Map<string, boolean>(); // by identity key: whether every lane with it so far was already stored as it is
    let ok = true;
    value.forEach((item, i) => {
      const lane = asRecord(item);
      if (!lane) {
        fields[`lanes.${i}`] = "Each lane needs a name.";
        ok = false;
        return;
      }
      const id = checkLaneId(lane.id, stored, seenIds);
      if ("message" in id) {
        fields[`lanes.${i}.id`] = id.message;
        ok = false;
      }
      const unnamed = value.length === 1 && (lane.name === undefined || lane.name === null || (typeof lane.name === "string" && lane.name.trim() === ""));
      const name = unnamed ? { name: "" } : checkTitle(lane.name, kept, "lane name", MAX_LANE_NAME_CODE_POINTS);
      if ("message" in name) {
        fields[`lanes.${i}.name`] = name.message;
        ok = false;
      } else if (name.name !== "") {
        // The same name by identity key (compatibility forms, spacing, case and ignorable characters don't make another), unless both are
        // names the event already has, which an edit may keep as they are.
        const same = identityKey(name.name);
        const stored = typeof lane.name === "string" && kept.includes(lane.name);
        if (seenNames.has(same) && !(stored && seenNames.get(same))) {
          fields[`lanes.${i}.name`] = "Two lanes can't have the same name.";
          ok = false;
        }
        seenNames.set(same, stored && (seenNames.get(same) ?? true));
      }
      if (ok) lanes.push({ ...("id" in id ? { id: id.id } : {}), name: (name as { name: string }).name });
    });
    if (ok) return lanes;
  }
  return undefined;
}

/**
 * The booking form's fields of a create, an edit or a template: one to four, each `{ label, required, maxLength, identity }`.
 * The label is text like an event name (at most 40 characters, no invisible, control or line-separating characters) with a letter or
 * a number in it (checkTitle) and has a different identity key from every other label (compatibility forms, spacing and case ignored). The first field is required, a field that
 * identifies a booking is required, and at least one field identifies a booking. Errors are keyed `fields` (the list),
 * `fields.N` (an item) and `fields.N.label`, `fields.N.required`, `fields.N.maxLength` or `fields.N.identity`, N counting from 0.
 */
function parseFields(value: unknown, kept: readonly string[], fields: Fields): FieldDraft[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fields.fields = "Fields must be a list.";
  else if (value.length === 0) fields.fields = "A booking form needs at least one field.";
  else if (value.length > MAX_FIELDS) fields.fields = `You can have at most ${MAX_FIELDS} fields.`;
  else {
    const drafts: FieldDraft[] = [];
    const seen = new Map<string, boolean>(); // as in parseLanes
    let ok = true;
    value.forEach((item, i) => {
      const f = asRecord(item);
      if (!f) {
        fields[`fields.${i}`] = "Each field needs a label.";
        ok = false;
        return;
      }
      const label = checkTitle(f.label, kept, "field label", MAX_FIELD_LABEL_CODE_POINTS);
      if ("message" in label) {
        fields[`fields.${i}.label`] = label.message;
        ok = false;
      } else {
        const same = identityKey(label.name);
        const stored = typeof f.label === "string" && kept.includes(f.label);
        if (seen.has(same) && !(stored && seen.get(same))) {
          fields[`fields.${i}.label`] = "Two fields can't have the same label.";
          ok = false;
        }
        seen.set(same, stored && (seen.get(same) ?? true));
      }
      const maxLength = checkInteger(f.maxLength, 1, MAX_FIELD_LENGTH);
      if (maxLength === null) {
        fields[`fields.${i}.maxLength`] = `Enter a whole number of characters from 1 to ${MAX_FIELD_LENGTH}.`;
        ok = false;
      }
      if (typeof f.required !== "boolean") {
        fields[`fields.${i}.required`] = "Required must be true or false.";
        ok = false;
      } else if (i === 0 && !f.required) {
        fields[`fields.${i}.required`] = "The first field must be required.";
        ok = false;
      } else if (f.identity === true && !f.required) {
        fields[`fields.${i}.required`] = "A field that identifies a booking must be required.";
        ok = false;
      }
      if (typeof f.identity !== "boolean") {
        fields[`fields.${i}.identity`] = "Identifies a booking must be true or false.";
        ok = false;
      }
      if (ok) drafts.push({ label: (label as { name: string }).name, required: f.required as boolean, maxLength: maxLength!, identity: f.identity as boolean });
    });
    if (ok && !drafts.some((f) => f.identity)) fields.fields = "At least one field must identify a booking.";
    else if (ok) return drafts;
  }
  return undefined;
}

/** How many places the event would have: its time slots, times its lanes, times the places in each. */
export const placeCountOf = (slotCount: number, laneCount: number, capacity: number): number => slotCount * laneCount * capacity;

export function parseEventDraft(
  raw: Record<string, unknown>,
  opts: {
    now: Date; requireFuture: boolean; stored?: StoredText; layout?: StoredLayout; requireConfigRev?: boolean;
    /** For a template update: the number of lanes and the capacity an omitted `lanes` or `capacity` keeps (templates' lanes have no ids, so there is no `layout`). */
    kept?: { laneCount: number; capacity: number };
    /** The lane names and field labels the event or template already has: an edit may keep them as they are even where today's rules would refuse them. */
    keep?: KeptNames;
  },
): { draft: EventDraft } | { fields: Fields } {
  const fields: Fields = {};

  const name = checkName(raw.name, opts.stored?.name);
  if ("message" in name) fields.name = name.message;

  const dateText = typeof raw.date === "string" ? raw.date : "";
  const dateOk = !("message" in londonTime(dateText, "12:00"));
  if (!dateOk) fields.date = "Enter a real date.";
  // With no usable date the times are still checked for shape, against a date with no clock change.
  const base = dateOk ? dateText : PROBE_DATE;

  const start = londonTime(base, raw.start);
  const end = londonTime(base, raw.end);
  if ("message" in start) fields.start = start.message;
  if ("message" in end) fields.end = end.message;
  const startUtc = "utc" in start ? start.utc : null;
  const endUtc = "utc" in end ? end.utc : null;
  if (startUtc && endUtc && endUtc <= startUtc) fields.end = "The end must be after the start.";
  if (dateOk && startUtc && opts.requireFuture) {
    const ahead = Date.parse(startUtc) - opts.now.getTime();
    if (ahead <= 0) fields.date = "The event must start in the future.";
    else if (ahead > MAX_DAYS_AHEAD * 86_400_000) fields.date = "That date is more than two years away. Check it.";
  }

  const sessionMinutes = checkInteger(raw.sessionMinutes, 1, 480);
  if (sessionMinutes === null) fields.sessionMinutes = "Enter a whole number of minutes from 1 to 480.";
  const gapMinutes = checkInteger(raw.gapMinutes, 0, 120);
  if (gapMinutes === null) fields.gapMinutes = "Enter a whole number of minutes from 0 to 120.";
  const costPence = checkInteger(raw.costPence, 0, 100_000);
  if (costPence === null) fields.costPence = "Enter the cost in pence as a whole number from 0 to 100000.";
  const postcode = checkPostcode(raw.venuePostcode);
  if ("message" in postcode) fields.venuePostcode = postcode.message;
  const details = checkDetails(raw.details, opts.stored?.details);
  if ("message" in details) fields.details = details.message;
  let shareMessage: string | undefined;
  if (raw.shareMessage !== undefined) {
    const message = checkShareMessage(raw.shareMessage, opts.stored?.shareMessage);
    if ("message" in message) fields.shareMessage = message.message;
    else shareMessage = message.text;
  }
  if (raw.listed !== undefined && typeof raw.listed !== "boolean") fields.listed = "Listed must be true or false.";
  const lanes = parseLanes(raw.lanes, opts.layout, opts.keep?.laneNames ?? [], fields);
  let capacity: number | undefined;
  if (raw.capacity !== undefined) {
    const c = checkInteger(raw.capacity, 1, MAX_CAPACITY);
    if (c === null) fields.capacity = `Enter a whole number of places from 1 to ${MAX_CAPACITY}.`;
    else capacity = c;
  }
  const bookingFields = parseFields(raw.fields, opts.keep?.fieldLabels ?? [], fields);
  let identityLimit: number | undefined;
  if (raw.identityLimit !== undefined) {
    const l = checkInteger(raw.identityLimit, 1, MAX_IDENTITY_LIMIT);
    if (l === null) fields.identityLimit = `Enter a whole number of bookings from 1 to ${MAX_IDENTITY_LIMIT}.`;
    else identityLimit = l;
  }
  // A save of an edit (`requireConfigRev`: not a preview, which writes nothing) that sends any of the layout's keys must say which
  // revision of it the page showed.
  let configRev: number | undefined;
  if (opts.requireConfigRev && [raw.lanes, raw.capacity, raw.fields, raw.identityLimit].some((v) => v !== undefined)) {
    const r = raw.configRev;
    if (typeof r === "number" && Number.isSafeInteger(r) && r >= 0) configRev = r;
    else fields.configRev = "Reload the page and try again.";
  }

  const breaks: EventDraft["breaks"] = [];
  if (!Array.isArray(raw.breaks)) fields.breaks = "Breaks must be a list.";
  else if (raw.breaks.length > MAX_BREAKS) fields.breaks = `You can add at most ${MAX_BREAKS} breaks.`;
  else {
    raw.breaks.forEach((item, i) => {
      const b = asRecord(item);
      if (!b) {
        fields[`breaks.${i}`] = "Each break needs a start and an end.";
        return;
      }
      const label = checkLabel(b.label, opts.stored?.breakLabels);
      if ("message" in label) fields[`breaks.${i}.label`] = label.message;
      const s = londonTime(base, b.start);
      const e = londonTime(base, b.end);
      if ("message" in s) fields[`breaks.${i}.start`] = s.message;
      if ("message" in e) fields[`breaks.${i}.end`] = e.message;
      if (!("utc" in s) || !("utc" in e) || !("label" in label)) return;
      if (e.utc <= s.utc) fields[`breaks.${i}.end`] = "The break must end after it starts.";
      else if (startUtc && s.utc < startUtc) fields[`breaks.${i}.start`] = "The break must start within the event.";
      else if (endUtc && e.utc > endUtc) fields[`breaks.${i}.end`] = "The break must end within the event.";
      breaks.push({ start: b.start as string, end: b.end as string, label: label.label, startUtc: s.utc, endUtc: e.utc });
    });
  }

  if (Object.keys(fields).length > 0) return { fields };
  const draft: EventDraft = {
    name: (name as { name: string }).name, date: dateText, start: raw.start as string, end: raw.end as string,
    sessionMinutes: sessionMinutes!, gapMinutes: gapMinutes!, costPence: costPence!,
    venuePostcode: (postcode as { postcode: string }).postcode, details: (details as { details: string }).details,
    shareMessage, listed: raw.listed as boolean | undefined, startUtc: startUtc!, endUtc: endUtc!, breaks, lanes, capacity,
    fields: bookingFields, identityLimit, configRev,
  };
  const slotCount = previewSchedule(draft).slots.length;
  if (slotCount === 0) return { fields: { end: "No sessions fit between the start and end." } };
  if (slotCount > MAX_SLOTS) return { fields: { sessionMinutes: `That would make more than ${MAX_SLOTS} slots.` } };
  // The places are checked with the slots, using what an omitted lanes or capacity keeps (one lane and one place for a new event).
  const places = placeCountOf(
    slotCount, lanes?.length ?? opts.layout?.laneIds.length ?? opts.kept?.laneCount ?? 1, capacity ?? opts.layout?.capacity ?? opts.kept?.capacity ?? 1,
  );
  if (places > MAX_PLACES) {
    const key = capacity !== undefined ? "capacity" : lanes ? "lanes" : "sessionMinutes";
    return { fields: { [key]: `That would make ${places} places (time slots times lanes times places per lane). An event can have at most ${MAX_PLACES}; use fewer lanes or places, or longer sessions.` } };
  }
  return { draft };
}

export const readEventBody = (request: Request): Promise<Record<string, unknown> | Response> =>
  readJsonObject(request, MAX_BODY_BYTES);

export const invalidInput = (fields: Fields): Response =>
  errorResponse(400, "invalid_input", "Check the highlighted fields.", { fields }, noStore);

/** Reads and validates a draft from the request body, or returns the error response to send. `layout` is the stored one (and `keep` the names it already has) when the draft is for an existing event. */
export async function readEventDraft(request: Request, requireFuture: boolean, layout?: StoredLayout, keep?: KeptNames): Promise<EventDraft | Response> {
  const body = await readEventBody(request);
  if (body instanceof Response) return body;
  const parsed = parseEventDraft(body, { now: new Date(), requireFuture, layout, keep });
  if ("fields" in parsed) return invalidInput(parsed.fields);
  return parsed.draft;
}

/** The create request's idempotency key, or the field error to report. */
export const checkEventKey = (value: unknown): { key: string } | { message: string } =>
  typeof value === "string" && IDEMPOTENCY_KEY.test(value) ? { key: value } : { message: "Reload the page and try again." };

export interface PreviewSuggestion {
  /** Index in the draft's breaks of the break this is about. */
  breakIndex: number;
  droppedSlot: TimeRange;
  overrunMinutes: number;
  suggestedBreak: TimeRange;
  /** The suggested break as London HH:MM, ready for the form inputs. */
  suggestedLocal: { start: string; end: string };
  /** The break's name ("" if unnamed), for the suggestion's wording. */
  breakLabel: string;
}

export function previewSchedule(draft: EventDraft): { slots: TimeRange[]; suggestions: PreviewSuggestion[] } {
  const { slots, suggestions } = generateSchedule({
    start: draft.startUtc, end: draft.endUtc, sessionMinutes: draft.sessionMinutes, gapMinutes: draft.gapMinutes,
    breaks: draft.breaks.map((b) => ({ start: b.startUtc, end: b.endUtc })),
    nearMissMinutes: DEFAULT_NEAR_MISS_MINUTES,
  });
  const usable: PreviewSuggestion[] = [];
  for (const s of suggestions) {
    const breakIndex = draft.breaks.findIndex((b) => b.startUtc === s.break.start && b.endUtc === s.break.end);
    const suggestedLocal = {
      start: utcToLondon(s.suggestedBreak.start).time, end: utcToLondon(s.suggestedBreak.end).time,
    };
    // The form takes London times on the event's date: leave out a suggestion those can't express
    // (a time in the hour the clocks repeat, or one on another day).
    try {
      if (londonToUtc(draft.date, suggestedLocal.start) !== s.suggestedBreak.start
        || londonToUtc(draft.date, suggestedLocal.end) !== s.suggestedBreak.end) continue;
    } catch (e) {
      if (e instanceof RangeError) continue;
      throw e;
    }
    if (breakIndex === -1) continue;
    usable.push({
      breakIndex, droppedSlot: s.droppedSlot, overrunMinutes: s.overrunMinutes,
      suggestedBreak: s.suggestedBreak, suggestedLocal, breakLabel: draft.breaks[breakIndex].label,
    });
  }
  return { slots, suggestions: usable };
}

/** An event as stored, with the breaks as stored: all that create answers with and compares. */
export interface SavedEvent {
  slug: string; name: string; startUtc: string; endUtc: string; sessionMinutes: number; gapMinutes: number;
  costPence: number; venuePostcode: string; details: string; shareMessage: string; listed: boolean;
  breaks: { startUtc: string; endUtc: string; label: string }[];
  lanes: { id: number; name: string }[];
  capacity: number;
  fields: FieldDraft[];
  identityLimit: number;
  /** The layout's revision (0 for a new event), which the edit page sends back when it saves the lanes, places or form. */
  configRev: number;
}

export interface CreateEventResult { kind: "created" | "replayed" | "idempotency_key_reuse"; saved: SavedEvent }

/** The create response body: the same for a first create, a replay and the original shown on a reuse. */
export const createdBody = (e: SavedEvent) => ({
  event: {
    slug: e.slug, name: e.name, startUtc: e.startUtc, endUtc: e.endUtc, sessionMinutes: e.sessionMinutes,
    gapMinutes: e.gapMinutes, costPence: e.costPence, venuePostcode: e.venuePostcode, details: e.details,
    shareMessage: e.shareMessage, lanes: e.lanes, capacity: e.capacity, fields: e.fields, identityLimit: e.identityLimit, configRev: e.configRev,
  },
  path: `/e/${e.slug}`,
  slotCount: generateSchedule({
    start: e.startUtc, end: e.endUtc, sessionMinutes: e.sessionMinutes, gapMinutes: e.gapMinutes,
    breaks: e.breaks.map((b) => ({ start: b.startUtc, end: b.endUtc })),
  }).slots.length,
});

/** The lanes a create request means: the ones it lists, or the one unnamed lane. */
const lanesOf = (d: EventDraft): { name: string }[] => d.lanes ?? [{ name: "" }];

/** The fields a create request means: the ones it lists, or the one required "Name" field. */
const fieldsOf = (d: Pick<EventDraft, "fields">): FieldDraft[] => d.fields ?? [...DEFAULT_FIELDS];

const breakKey = (b: { startUtc: string; endUtc: string; label: string }): string => JSON.stringify([b.startUtc, b.endUtc, b.label]);

/** The same event, breaks compared as a set so their order doesn't matter. */
function sameEvent(saved: SavedEvent, d: EventDraft): boolean {
  const mine = d.breaks.map(breakKey).sort();
  const theirs = saved.breaks.map(breakKey).sort();
  return saved.name === d.name && saved.startUtc === d.startUtc && saved.endUtc === d.endUtc
    && saved.sessionMinutes === d.sessionMinutes && saved.gapMinutes === d.gapMinutes && saved.costPence === d.costPence
    && saved.venuePostcode === d.venuePostcode && saved.details === d.details && saved.shareMessage === (d.shareMessage ?? "")
    && saved.listed === (d.listed ?? true) && saved.capacity === (d.capacity ?? 1) && saved.identityLimit === (d.identityLimit ?? 1)
    && JSON.stringify(saved.fields) === JSON.stringify(fieldsOf(d))
    && JSON.stringify(saved.lanes.map((l) => l.name)) === JSON.stringify(lanesOf(d).map((l) => l.name))
    && mine.length === theirs.length && mine.every((k, i) => k === theirs[i]);
}

/**
 * What the idempotency key says: a replay if an event saved under it matches the draft, a reuse (carrying
 * the saved event as stored, never the draft) if it differs, or null if no event holds the key. One batch,
 * so the event and its breaks come from the same moment.
 */
export async function findEventByKey(
  db: D1Database, key: string, d: EventDraft,
): Promise<{ kind: "replayed" | "idempotency_key_reuse"; saved: SavedEvent } | null> {
  const idOf = "(SELECT id FROM events WHERE idempotency_key = ?)";
  const [events, breaks, lanes, fieldRows, layout] = await db.batch([
    db.prepare(
      `SELECT slug, name, start_utc, end_utc, session_minutes, gap_minutes, cost_pence, venue_postcode, details, share_message, listed
       FROM events WHERE idempotency_key = ?`,
    ).bind(key),
    db.prepare(`SELECT start_utc, end_utc, label FROM breaks WHERE event_id = ${idOf} ORDER BY start_utc, end_utc, label`).bind(key),
    db.prepare(`SELECT id, name FROM event_lanes WHERE event_id = ${idOf} ORDER BY position`).bind(key),
    db.prepare(`SELECT position, label, required, max_length, in_identity FROM event_fields WHERE event_id = ${idOf} ORDER BY position`).bind(key),
    db.prepare(`SELECT capacity, identity_limit, config_rev FROM event_layout WHERE event_id = ${idOf}`).bind(key),
  ]);
  const e = (events.results as {
    slug: string; name: string; start_utc: string; end_utc: string; session_minutes: number; gap_minutes: number;
    cost_pence: number; venue_postcode: string; details: string; share_message: string; listed: number;
  }[])[0];
  if (!e) return null;
  const saved: SavedEvent = {
    slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc, sessionMinutes: e.session_minutes,
    gapMinutes: e.gap_minutes, costPence: e.cost_pence, venuePostcode: e.venue_postcode, details: e.details,
    shareMessage: e.share_message, listed: e.listed === 1,
    breaks: (breaks.results as { start_utc: string; end_utc: string; label: string }[])
      .map((b) => ({ startUtc: b.start_utc, endUtc: b.end_utc, label: b.label })),
    lanes: lanes.results as { id: number; name: string }[],
    capacity: (layout.results as { capacity: number }[])[0]?.capacity ?? 1,
    fields: draftsOf((fieldRows.results as unknown as RawField[]).map(fieldOf)),
    identityLimit: (layout.results as { identity_limit: number }[])[0]?.identity_limit ?? 1,
    configRev: (layout.results as { config_rev: number }[])[0]?.config_rev ?? 0,
  };
  return { kind: sameEvent(saved, d) ? "replayed" : "idempotency_key_reuse", saved };
}

/**
 * Creates the event unless the key already holds one. The key is looked up first, then the insert is
 * tried, and if it fails on a UNIQUE constraint the key is looked up again: a simultaneous request with
 * the same key may have won, and the unique index decides. If the key still holds nothing, the failure
 * was something else (a slug clash) and is rethrown.
 */
export async function createEvent(db: D1Database, d: EventDraft, key: string): Promise<CreateEventResult> {
  const prior = await findEventByKey(db, key, d);
  if (prior) return prior;
  const slug = generateSlug();
  let laneIds: number[];
  try {
    laneIds = await insertEventWithBreaks(db, slug, d, key);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("UNIQUE constraint failed")) throw e;
    const won = await findEventByKey(db, key, d);
    if (won) return won;
    throw e;
  }
  const lanes = lanesOf(d).map((l, i) => ({ id: laneIds[i], name: l.name }));
  return {
    kind: "created",
    saved: { ...d, shareMessage: d.shareMessage ?? "", listed: d.listed ?? true, slug, lanes, capacity: d.capacity ?? 1, fields: fieldsOf(d), identityLimit: d.identityLimit ?? 1, configRev: 0 },
  };
}

/**
 * Inserts the event, its layout (the capacity, 1 if the draft has none; the identity limit, likewise 1), its lanes (the
 * draft's, or one unnamed lane), its breaks and its booking form's fields (the draft's, or one required "Name") in one batch, so either all of it is stored or none. Returns the lane ids in order.
 * Assumes a validated draft; the table CHECK constraints are the last line of defence.
 */
export async function insertEventWithBreaks(db: D1Database, slug: string, d: EventDraft, idempotencyKey: string): Promise<number[]> {
  const lanes = lanesOf(d);
  const idOfEvent = "(SELECT id FROM events WHERE slug = ?)";
  const results = await db.batch([
    db.prepare(
      `INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, gap_minutes, cost_pence, venue_postcode, details, share_message, listed, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(slug, d.name, d.startUtc, d.endUtc, d.sessionMinutes, d.gapMinutes, d.costPence, d.venuePostcode, d.details,
      d.shareMessage ?? "", d.listed === false ? 0 : 1, idempotencyKey),
    db.prepare("INSERT INTO event_layout (event_id, capacity, identity_limit) VALUES ((SELECT id FROM events WHERE slug = ?), ?, ?)")
      .bind(slug, d.capacity ?? 1, d.identityLimit ?? 1),
    ...lanes.map((l, i) =>
      db.prepare("INSERT INTO event_lanes (event_id, position, name) VALUES ((SELECT id FROM events WHERE slug = ?), ?, ?) RETURNING id")
        .bind(slug, i + 1, l.name)),
    ...d.breaks.map((b) =>
      db.prepare("INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES ((SELECT id FROM events WHERE slug = ?), ?, ?, ?)")
        .bind(slug, b.startUtc, b.endUtc, b.label)),
    ...withPositions(fieldsOf(d)).map((f) =>
      db.prepare(`INSERT INTO event_fields (event_id, position, label, required, max_length, in_identity) VALUES (${idOfEvent}, ?, ?, ?, ?, ?)`)
        .bind(slug, f.position, f.label, f.required ? 1 : 0, f.maxLength, f.identity ? 1 : 0)),
  ]);
  return results.slice(2, 2 + lanes.length).map((r) => (r.results as { id: number }[])[0].id);
}

interface ListedEvent { id: number; slug: string; name: string; start_utc: string; end_utc: string; session_minutes: number; gap_minutes: number; cost_pence: number; venue_postcode: string; details: string; share_message: string; listed: number }

interface ListedOld { slug: string; name: string; start_utc: string; end_utc: string; venue_postcode: string; archived: number; listed: number; booked: number }

/** The first 100 of an ended or archived group (most recently started first) with booked counts, and whether more exist. */
const olderEvents = (db: D1Database, where: string) =>
  db.prepare(
    `WITH page AS (
       SELECT id, slug, name, start_utc, end_utc, venue_postcode, archived, listed FROM events WHERE ${where}
       ORDER BY start_utc DESC, id DESC LIMIT ${MAX_LIST + 1}
     ), counts AS (SELECT event_id, COUNT(*) AS n FROM bookings WHERE event_id IN (SELECT id FROM page) GROUP BY event_id)
     SELECT page.slug, page.name, page.start_utc, page.end_utc, page.venue_postcode, page.archived, page.listed, COALESCE(counts.n, 0) AS booked
     FROM page LEFT JOIN counts ON counts.event_id = page.id ORDER BY page.start_utc DESC, page.id DESC`,
  );

function olderGroup(rows: ListedOld[]) {
  return {
    items: rows.slice(0, MAX_LIST).map((e) => ({
      slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc, venuePostcode: e.venue_postcode,
      bookedCount: e.booked, archived: e.archived === 1, listed: e.listed === 1,
    })),
    hasMore: rows.length > MAX_LIST,
  };
}

/** The default template's share message, if any: one row. The Share button falls back to it when an event has none of its own. */
export const defaultShareMessageStatement = (db: D1Database): D1PreparedStatement =>
  db.prepare("SELECT share_message FROM event_templates WHERE is_default = 1");

/**
 * The admin list in three groups; every event is in exactly one (archived wins, then the end time decides):
 * `events` (Upcoming: not archived, ends after now, soonest first), `past` (not archived, ended at or before
 * now) and `archived`, each of the last two at most 100, most recently started first, with a HasMore flag.
 * One batch of eleven statements: two idempotent repairs that give an upcoming event with no layout row or lane (one made by the previous
 * version of the app between the migration and the deploy) its one unnamed lane (they write nothing for any other), then the upcoming
 * events, their breaks, lanes, fields, layouts and booking counts, then Past and Archived, then the default template's share message
 * (`defaultShareMessage`, "" if there is none). An upcoming event
 * is `full` when every place of every lane at every time is booked. `slotCount` is the number of times and `bookedCount` the
 * number of bookings; `laneCount`, `capacity` and `placeCount` (times x lanes x places per lane) say how many places there are.
 */
export async function listAdminEvents(db: D1Database, now: Date, cutoffOffsetMinutes: number) {
  const nowIso = `${now.toISOString().slice(0, 19)}Z`;
  const upcoming = `SELECT id FROM events WHERE archived = 0 AND end_utc > ?1 ORDER BY start_utc, id LIMIT ${MAX_LIST}`;
  const [, , events, breaks, lanes, fieldRows, layouts, counts, pastRows, archivedRows, defaultMessage] = await db.batch([
    // First, so the reads below see an upcoming event the previous version of the app made without a layout row or lane (see ensureEventLayout).
    ...layoutRepairStatements(db, upcoming, nowIso),
    db.prepare(
      `SELECT id, slug, name, start_utc, end_utc, session_minutes, gap_minutes, cost_pence, venue_postcode, details, share_message, listed
       FROM events WHERE id IN (${upcoming}) ORDER BY start_utc, id`,
    ).bind(nowIso),
    db.prepare(`SELECT event_id, start_utc, end_utc, label FROM breaks WHERE event_id IN (${upcoming})`).bind(nowIso),
    db.prepare(`SELECT event_id, id, position, name FROM event_lanes WHERE event_id IN (${upcoming}) ORDER BY position`).bind(nowIso),
    db.prepare(`SELECT event_id, position, label, required, max_length, in_identity FROM event_fields WHERE event_id IN (${upcoming}) ORDER BY position`).bind(nowIso),
    db.prepare(`SELECT event_id, capacity, identity_limit, config_rev FROM event_layout WHERE event_id IN (${upcoming})`).bind(nowIso),
    db.prepare(`SELECT event_id, COUNT(*) AS n FROM bookings WHERE event_id IN (${upcoming}) GROUP BY event_id`).bind(nowIso),
    olderEvents(db, "archived = 0 AND end_utc <= ?1").bind(nowIso),
    olderEvents(db, "archived = 1").bind(),
    defaultShareMessageStatement(db),
  ]);
  const breaksOf = new Map<number, EventRow["breaks"]>();
  for (const b of (breaks.results as { event_id: number; start_utc: string; end_utc: string; label: string }[])) {
    breaksOf.set(b.event_id, [...(breaksOf.get(b.event_id) ?? []), { start: b.start_utc, end: b.end_utc, label: b.label }]);
  }
  const lanesOf = new Map<number, EventRow["lanes"]>();
  for (const l of (lanes.results as { event_id: number; id: number; position: number; name: string }[])) {
    lanesOf.set(l.event_id, [...(lanesOf.get(l.event_id) ?? []), { id: l.id, position: l.position, name: l.name }]);
  }
  const fieldsOfEvent = new Map<number, EventRow["fields"]>();
  for (const f of (fieldRows.results as unknown as (RawField & { event_id: number })[])) {
    fieldsOfEvent.set(f.event_id, [...(fieldsOfEvent.get(f.event_id) ?? []), fieldOf(f)]);
  }
  const layoutOf = new Map((layouts.results as { event_id: number; capacity: number; identity_limit: number; config_rev: number }[]).map((r) => [r.event_id, r]));
  const bookedOf = new Map((counts.results as { event_id: number; n: number }[]).map((r) => [r.event_id, r.n]));
  const upcomingList = (events.results as unknown as ListedEvent[]).map((e) => {
    const row = {
      id: e.id, slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc,
      sessionMinutes: e.session_minutes, gapMinutes: e.gap_minutes, costPence: e.cost_pence,
      venuePostcode: e.venue_postcode, details: e.details, shareMessage: e.share_message, archived: false, listed: e.listed === 1, breaks: breaksOf.get(e.id) ?? [],
      lanes: lanesOf.get(e.id) ?? [], fields: fieldsOfEvent.get(e.id) ?? [...LEGACY_FIELDS], capacity: layoutOf.get(e.id)?.capacity ?? 1,
      identityLimit: layoutOf.get(e.id)?.identity_limit ?? 1, configRev: layoutOf.get(e.id)?.config_rev ?? 0,
    } satisfies EventRow;
    const slotCount = generateSchedule({
      start: row.startUtc, end: row.endUtc, sessionMinutes: row.sessionMinutes, gapMinutes: row.gapMinutes, breaks: row.breaks,
    }).slots.length;
    const bookedCount = bookedOf.get(e.id) ?? 0;
    const placeCount = placeCountOf(slotCount, row.lanes.length, row.capacity);
    return {
      slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc, costPence: e.cost_pence,
      venuePostcode: e.venue_postcode, details: e.details, shareMessage: e.share_message, slotCount, bookedCount, archived: false,
      listed: e.listed === 1,
      laneCount: row.lanes.length, lanes: row.lanes.map(({ name }) => ({ name })), capacity: row.capacity, placeCount,
      fields: draftsOf(row.fields), identityLimit: row.identityLimit,
      full: slotCount > 0 && bookedCount >= placeCount,
      bookings: bookingWindow(row, cutoffOffsetMinutes, now),
      path: `/e/${e.slug}`,
    };
  });
  const past = olderGroup(pastRows.results as unknown as ListedOld[]);
  const archived = olderGroup(archivedRows.results as unknown as ListedOld[]);
  const defaultShareMessage = (defaultMessage.results as { share_message: string }[])[0]?.share_message ?? "";
  return {
    events: upcomingList, past: past.items, archived: archived.items, pastHasMore: past.hasMore, archivedHasMore: archived.hasMore,
    defaultShareMessage,
  };
}

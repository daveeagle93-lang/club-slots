import { generateSchedule, type TimeRange } from "../core/schedule";
import { generateBookingToken } from "../core/slug";
import { scheduleUnchanged } from "./db-guard";
import { computeSlotViews, type EventField, type EventRow, type LanePlaces } from "./events";
import { columnValues, identityKeyFor, shownValues } from "./fields";
import { errorResponse } from "./http";
import { placeAtFreeSpot } from "./places";

const MAX_BODY_BYTES = 4096;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
// Every Unicode format character (general category Cf): soft hyphen, zero-width space, ZWNJ/ZWJ, LRM/RLM, Arabic letter
// mark, bidi controls, word joiner and invisible operators, BOM, tag characters and so on. They render as nothing or
// reorder the text, so a name could look like another or fake a line. Emoji joined with ZWJ are rejected too.
export const INVISIBLE = /\p{Cf}/u;
const INVISIBLE_EXPLANATION = "can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.";
/** The message for a refused Cf character: `what` is the field as the sentence names it ("event name", "details"). */
export const invisibleMessage = (what: string): string => `The ${what} ${INVISIBLE_EXPLANATION}`;
// LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029) are categories Zl and Zp, not control characters, but
// WhatsApp and most editors start a new line on them, so a name containing one could fake a line in a pasted lineup.
export const LINE_SEPARATORS = /[\p{Zl}\p{Zp}]/u;
export const noStore = { "Cache-Control": "no-store" };

/** A booking request, checked: `values` has one trimmed value per field of the event, in order ("" for an optional field left blank). */
export interface BookingInput { slot: string; laneId: number; values: string[]; idempotencyKey: string }

/** What a confirmed booking shows: its time, its lane and a value for each field that has one, with the field's label. */
type BookedResult = { booking: { slot: TimeRange; lane: { id: number; name: string }; fields: { label: string; value: string }[] }; token: string };

/** A slot a public booker could take right now, with what is left in each lane. */
export type FreeSlot = TimeRange & { places: LanePlaces[] };

export type BookingResult =
  | ({ kind: "created" } & BookedResult)
  | ({ kind: "replayed" } & BookedResult)
  | { kind: "idempotency_key_reuse"; original: BookedResult | null }
  | { kind: "duplicate_booking" }
  | { kind: "slot_taken"; freeSlots: FreeSlot[] };

/** What createBooking answers: a BookingResult, or schedule_changed when the event was edited under it (nothing written). */
export type CreateResult = BookingResult | { kind: "schedule_changed" };

export const payloadTooLarge = (): Response =>
  errorResponse(413, "payload_too_large", "That request is too large.", {}, noStore);

/** True if the client declares a body over the cap; lets the handler refuse before touching the database. */
export const declaresOversizeBody = (request: Request): boolean =>
  Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES;

/** Reads the body as text, cancelling the stream and returning null as soon as it passes the byte cap. */
async function readCappedText(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** Returns the parsed JSON object, or the error response to send. */
export async function readJsonObject(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown> | Response> {
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return errorResponse(415, "unsupported_media_type", "Send the request as application/json.", {}, noStore);
  }
  const text = await readCappedText(request, maxBytes);
  if (text === null) return payloadTooLarge();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return errorResponse(400, "invalid_json", "The request body isn't valid JSON.", {}, noStore);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return errorResponse(400, "invalid_json", "The request body must be a JSON object.", {}, noStore);
  }
  return value as Record<string, unknown>;
}

/**
 * One value of the booking form against its field. The messages name the field by its bare label ("Dog is required.",
 * "Dog must be at most 80 characters."). Every rule of v1.0's names applies to every field: well-formed text, no format
 * characters, no line or paragraph separators, no control characters, a real letter or number, no private-use or
 * blank-looking characters. A required field must have a value; an optional one may be left out or blank (""), and then
 * the rules above are not asked of nothing.
 */
export function checkFieldValue(value: unknown, field: Pick<EventField, "label" | "required" | "maxLength">): { value: string } | { message: string } {
  const { label } = field;
  const required = { message: `${label} is required.` };
  if (value === undefined || value === null) return field.required ? required : { value: "" };
  if (typeof value !== "string") return field.required ? required : { message: `${label} must be text.` };
  if (!value.isWellFormed()) return { message: `${label} can't contain unpaired surrogate characters.` };
  if (INVISIBLE.test(value)) return { message: `${label} ${INVISIBLE_EXPLANATION}` };
  if (LINE_SEPARATORS.test(value)) return { message: `${label} can't contain line or paragraph separators.` };
  const text = value.trim();
  if (text === "") return field.required ? required : { value: "" };
  if ([...text].length > field.maxLength) return { message: `${label} must be at most ${field.maxLength} characters.` };
  if (/\p{Cc}/u.test(text)) return { message: `${label} can't contain control characters.` };
  // Invisible characters outside Cf (variation selectors, Hangul fillers, ...) and blank-looking symbols could make a
  // value that looks empty or that a second booking could copy, so there must be a real letter or number. Emoji are
  // still fine beside one ("Rex ❤️").
  if (!/[\p{L}\p{N}]/u.test(text.replace(/\p{Default_Ignorable_Code_Point}/gu, ""))) {
    return { message: `${label} must contain at least one letter or number.` };
  }
  // A private-use character (category Co) draws as whatever font the reader has, or as a box, and the braille blank (U+2800) draws as
  // nothing, so either could pass for a real character beside a letter. Unassigned code points (Cn) stay allowed: a newer runtime
  // may have assigned one to an emoji, and refusing it would break values that were fine yesterday.
  if (/[\p{Co}\u2800]/u.test(text)) return { message: `${label} can't contain private-use or blank-looking characters. Try plain text.` };
  return { value: text };
}

/** The request's `field1` to `field4` against the event's fields, in order: the values, or the messages keyed `field1` and so on. */
export function checkFieldValues(
  raw: Record<string, unknown>, fields: readonly EventField[],
): { values: string[] } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const values = fields.map((f) => {
    const checked = checkFieldValue(raw[`field${f.position}`], f);
    if ("message" in checked) errors[`field${f.position}`] = checked.message;
    return "value" in checked ? checked.value : "";
  });
  return Object.keys(errors).length > 0 ? { errors } : { values };
}

/**
 * The lane a request names: `laneId` may be left out only when the event has exactly one lane, and must otherwise be
 * the id of one of the event's lanes.
 */
export function chooseLane(event: Pick<EventRow, "lanes">, value: unknown): { laneId: number } | { message: string } {
  if (value === undefined && event.lanes.length === 1) return { laneId: event.lanes[0].id };
  const lane = typeof value === "number" ? event.lanes.find((l) => l.id === value) : undefined;
  return lane ? { laneId: lane.id } : { message: "Choose a lane." };
}

export function validateBookingInput(
  raw: Record<string, unknown>, event: Pick<EventRow, "lanes" | "fields">,
): BookingInput | { fields: Record<string, string> } {
  const checked = checkFieldValues(raw, event.fields);
  const fields: Record<string, string> = "errors" in checked ? checked.errors : {};
  const lane = chooseLane(event, raw.laneId);
  if ("message" in lane) fields.laneId = lane.message;
  if (typeof raw.slot !== "string") fields.slot = "Choose a slot.";
  if (typeof raw.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(raw.idempotencyKey)) {
    fields.idempotencyKey = "Reload the page and try again.";
  }
  if (Object.keys(fields).length > 0) return { fields };
  return {
    slot: raw.slot as string, laneId: (lane as { laneId: number }).laneId,
    values: (checked as { values: string[] }).values, idempotencyKey: raw.idempotencyKey as string,
  };
}

/** The slots a public booker could take right now: a place free in some lane and not yet started. */
export async function bookableSlots(db: D1Database, event: EventRow, now: Date): Promise<FreeSlot[]> {
  const views = await computeSlotViews(db, event, now);
  return views.filter((s) => s.status === "free").map(({ start, end, places }) => ({ start, end, places }));
}

function scheduleOf(event: EventRow): TimeRange[] {
  return generateSchedule({
    start: event.startUtc, end: event.endUtc,
    sessionMinutes: event.sessionMinutes, gapMinutes: event.gapMinutes, breaks: event.breaks,
  }).slots;
}

export const findSlot = (event: EventRow, start: string): TimeRange | undefined =>
  scheduleOf(event).find((s) => s.start === start);

/**
 * What the request's idempotency key says: a replay of the key holder's booking if the key was used by
 * the same slot, lane, identity and other values (a retry), idempotency_key_reuse if it was used by anything else, or
 * null if no booking holds it. The lookup is by event and key alone, and the key is a 128-bit secret
 * held only by the booker's browser, so presenting it proves ownership: a reuse carries the key
 * holder's own booking as stored (never the requested values) so a booker who edited the form after a
 * lost response can still find it. If that booking's slot has since left the schedule, a retry gets
 * null (and so the usual invalid_slot) and a reuse carries no booking.
 */
export async function findByIdempotencyKey(
  db: D1Database, event: EventRow, input: BookingInput,
): Promise<Extract<BookingResult, { kind: "replayed" | "idempotency_key_reuse" }> | null> {
  const row = await db
    .prepare(
      "SELECT slot_start_utc, lane_id, value_1, value_2, value_3, value_4, identity_key, token FROM bookings WHERE event_id = ? AND idempotency_key = ?",
    )
    .bind(event.id, input.idempotencyKey)
    .first<{ slot_start_utc: string; lane_id: number; value_1: string; value_2: string; value_3: string; value_4: string; identity_key: string; token: string }>();
  if (!row) return null;
  const stored4 = [row.value_1, row.value_2, row.value_3, row.value_4];
  // The identity fields are compared by their key (case and spacing don't make a different booking), the others as typed:
  // a retry that changed a note is not the same request, and the answer then is the booking as it was saved.
  const same = row.slot_start_utc === input.slot && row.lane_id === input.laneId
    && row.identity_key === identityKeyFor(event.fields, input.values)
    && event.fields.every((f, i) => f.identity || stored4[i] === input.values[i]);
  const slot = findSlot(event, row.slot_start_utc);
  const lane = { id: row.lane_id, name: event.lanes.find((l) => l.id === row.lane_id)?.name ?? "" };
  const stored = slot && { booking: { slot, lane, fields: shownValues(event.fields, stored4) }, token: row.token };
  if (!same) return { kind: "idempotency_key_reuse", original: stored ?? null };
  return stored ? { kind: "replayed", ...stored } : null;
}

/**
 * Inserts at the lowest free place of the lane without trusting any earlier check: the UNIQUE constraints decide, and
 * what a failure means is worked out afterwards (placeAtFreeSpot). Whoever holds the requested lane and slot decides the
 * answer: with no place left, a different identity gets slot_taken even if the requester's own identity has booked
 * elsewhere, so guessing a taken slot cannot confirm that an identity (a dog and handler, say) has booked. If the guessed slot has a free
 * place, a request with the guessed identity gets duplicate_booking when it is at its limit; that is a known limitation
 * (a wrong guess also creates a real booking). The first thing checked after a failure is the idempotency key,
 * because a simultaneous request with the same key may have won.
 *
 * The insert is the second statement of a batch whose first is `scheduleUnchanged`, so if the event was
 * edited between the caller's read and now, nothing is written and the answer is schedule_changed; the
 * caller reloads the event and decides (the slot may be gone, or still be there).
 */
export async function createBooking(
  db: D1Database, event: EventRow, slot: TimeRange, input: BookingInput, now: Date,
): Promise<CreateResult> {
  const lane = event.lanes.find((l) => l.id === input.laneId);
  if (!lane) return { kind: "schedule_changed" };
  const key = identityKeyFor(event.fields, input.values);
  const token = generateBookingToken();
  const outcome = await placeAtFreeSpot({
    db, event, laneId: lane.id, slot: slot.start, identityKey: key,
    insert: async ({ place, seq }) => {
      await db.batch([
        scheduleUnchanged(db, event),
        db
          .prepare(
            `INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, value_3, value_4, identity_key, identity_seq, token, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(event.id, lane.id, slot.start, place, ...columnValues(input.values), key, seq, token, input.idempotencyKey),
      ]);
    },
    settled: () => findByIdempotencyKey(db, event, input),
  });
  switch (outcome.kind) {
    case "placed":
      return { kind: "created", booking: { slot, lane: { id: lane.id, name: lane.name }, fields: shownValues(event.fields, input.values) }, token };
    case "settled":
      return outcome.value;
    case "schedule_changed":
      return { kind: "schedule_changed" };
    case "identity_limit":
      return { kind: "duplicate_booking" };
    case "full":
      if (outcome.sameIdentityHolds) return { kind: "duplicate_booking" };
      return { kind: "slot_taken", freeSlots: await bookableSlots(db, event, now) };
    case "gave_up":
      return { kind: "slot_taken", freeSlots: await bookableSlots(db, event, now) };
  }
}

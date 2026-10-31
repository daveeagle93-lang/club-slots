import { formatPounds } from "./format";
import { IDENTITY_SEPARATOR } from "./identity";

/**
 * Pure RFC 5545 builder for a single confirmed booking: no I/O, no clock, no globals.
 *
 * Rules
 * - Instants are UTC strings of the fixed form YYYY-MM-DDTHH:MM:SSZ (as in schedule.ts).
 * - DTSTART/DTEND are London wall-clock times with TZID=Europe/London, derived via Intl.
 * - Lines end CRLF and are folded at 75 octets (UTF-8) without splitting a character.
 * - TEXT values (SUMMARY, LOCATION, DESCRIPTION) are escaped per section 3.3.11.
 *
 * Known limit: in the repeated hour when clocks go back (01:00-02:00 on the last Sunday of
 * October) a TZID local time is ambiguous. Trial slots are not scheduled then.
 */
export interface BookingIcsInput {
  uid: string;
  dtstamp: string;
  slot: { start: string; end: string };
  /** What the booking form collected, a value for each field that has one, in the form's order. The first is the booking's name in the calendar. */
  fields: { label: string; value: string }[];
  eventName: string;
  venuePostcode: string;
  costPence: number;
  details: string;
  /** The club's name, if one is set: the first line of the description. */
  clubName?: string;
  /** The booking's lane, named in the description's Slot line (`Slot: 10:00–10:30, Ring 1`); left out or "" for an unnamed lane. */
  laneName?: string;
}

const TZID = "Europe/London";
const MAX_OCTETS = 75;

const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZID,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function toMs(iso: string): number {
  const ms = Date.parse(iso);
  // The round trip rejects wrong formats and impossible dates (30 February, hour 24).
  if (Number.isNaN(ms) || new Date(ms).toISOString().replace(".000Z", "Z") !== iso) {
    throw new RangeError(`Invalid instant "${iso}": expected YYYY-MM-DDTHH:MM:SSZ`);
  }
  return ms;
}

function london(ms: number): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const p of londonParts.formatToParts(ms)) parts[p.type] = p.value;
  return parts;
}

const localStamp = (p: Record<string, string>): string =>
  `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;

function escapeText(text: string): string {
  return text
    .replace(/\r\n|\r/g, "\n")
    .replace(/(?![\n\t])\p{Cc}/gu, "")
    .replace(/[\\;,]/g, "\\$&")
    .replace(/\n/g, "\\n");
}

function fold(line: string): string {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let current = "";
  let used = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    // Continuation lines spend one octet on the leading space.
    if (used + size > MAX_OCTETS) {
      lines.push(current);
      current = " ";
      used = 1;
    }
    current += char;
    used += size;
  }
  lines.push(current);
  return lines.join("\r\n");
}

/**
 * What a booking's calendar UID is hashed from. An identity's first booking: the event's slug and the identity fields' keys joined
 * with "|", the same text v1.0 hashed for a dog and a handler, so existing UIDs do not change. From its second booking: a JSON list
 * of the slug, the keys and the number. That text starts with "[" and a first booking's with the slug (letters, numbers, "_" and
 * "-"), so the two can never be equal, and a list is read back one way only. A suffix such as "|#2" on the first form would make
 * the second booking of "Rex" equal the first booking of someone called "Rex|#2".
 */
export const uidSource = (slug: string, identityKey: string, seq: number): string =>
  seq > 1 ? JSON.stringify([slug, ...identityKey.split(IDENTITY_SEPARATOR), seq]) : [slug, ...identityKey.split(IDENTITY_SEPARATOR)].join("|");

export function buildBookingIcs(input: BookingIcsInput): string {
  const start = toMs(input.slot.start);
  const end = toMs(input.slot.end);
  const stamp = toMs(input.dtstamp);
  if (end <= start) throw new RangeError("end must be after start");
  if (input.uid === "" || /[\r\n]/.test(input.uid)) {
    throw new RangeError("uid must be non-empty and free of line breaks");
  }
  const cost = formatPounds(input.costPence);

  const s = london(start);
  const e = london(end);
  const clubName = input.clubName?.trim();
  const description = [
    ...(clubName ? [clubName] : []),
    ...input.fields.map((f) => `${f.label}: ${f.value}`),
    `Slot: ${s.hour}:${s.minute}–${e.hour}:${e.minute}${input.laneName ? `, ${input.laneName}` : ""}`,
    `Cost: ${cost}`,
  ];
  const details = input.details.trim();
  if (details) description.push("", details);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//slot-booker//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE",
    `TZID:${TZID}`,
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0000",
    "TZOFFSETTO:+0100",
    "TZNAME:BST",
    "DTSTART:19700329T010000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0000",
    "TZNAME:GMT",
    "DTSTART:19701025T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `DTSTAMP:${new Date(stamp).toISOString().replace(/[-:]|\.000/g, "")}`,
    `DTSTART;TZID=${TZID}:${localStamp(s)}`,
    `DTEND;TZID=${TZID}:${localStamp(e)}`,
    `SUMMARY:${escapeText(`${input.fields[0].value} – ${input.eventName}`)}`,
    `LOCATION:${escapeText(input.venuePostcode)}`,
    `DESCRIPTION:${escapeText(description.join("\n"))}`,
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

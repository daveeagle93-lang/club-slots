import { utcToLondon } from "./london";

/**
 * The running order as plain text for pasting into a chat. Pure: London wall-clock times from the UTC
 * instants (never the host's time zone), British English long date, 24-hour times.
 *
 * Nothing is escaped or marked up: names (the club's included) are printed exactly as stored, and the text adds no
 * formatting of its own. Names can't fake a new line (the server refuses control characters and U+2028/U+2029), but
 * WhatsApp's own markup characters (`*`, `_`, `~` and backticks) are allowed in names, so a name containing them
 * can still make part of the message bold, italic or struck through when pasted into the chat. That is not
 * coded around. Lane names are user text too and are printed the same way, as stored.
 *
 * One line per place: a booking shows the value of each of the fields it is given, in the form's order, between " — " (`10:00 — Rex — Sam`).
 * It prints what it is given and decides nothing about privacy: eventDetail (src/server/admin-event-edit.ts) gives it only the fields that
 * identify a booking, so an optional phone number or a note never reaches a pasted lineup.
 * An event with exactly one lane and that lane unnamed reads as in v1.0 (`10:00 — Rex — Sam`,
 * `10:00 — free`; with several places in the lane, the bookings in place order and then a `free` line for each free
 * place). Any other event names the lane in every line (`10:00 Ring 1 — Rex — Sam`, `10:00 Ring 1 — free`), by time,
 * then lane order, then place.
 */
export interface LineupInput {
  /** The club's name, if one is set: the first line, above the event name. */
  clubName?: string;
  name: string;
  venuePostcode: string;
  /** The event's start; its London date heads the message. */
  startUtc: string;
  /**
   * Slots of the schedule, each with its lanes in lane order: the lane's bookings in place order, and how many of its places
   * are `free`. Every slot lists the same lanes. Bookings outside the schedule are not passed in.
   */
  slots: { start: string; places: { laneName: string; bookings: { fields: { value: string }[] }[]; free: number }[] }[];
  breaks: { start: string; end: string; label: string }[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Saturday 14 March 2026", from the London date, with no locale data involved. */
function longDate(iso: string): string {
  const [y, m, d] = utcToLondon(iso).date.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

export function buildLineup(input: LineupInput): string {
  const naming = input.slots.some((s) => s.places.length > 1 || s.places.some((p) => p.laneName !== ""));
  const items = [
    ...input.slots.map((s) => ({
      start: s.start, order: 1,
      lines: s.places.flatMap((p) => {
        const at = `${utcToLondon(s.start).time}${naming ? ` ${p.laneName}` : ""}`;
        return [
          ...p.bookings.map((b) => `${at} — ${b.fields.map((f) => f.value).join(" — ")}`),
          ...Array.from({ length: p.free }, () => `${at} — free`),
        ];
      }),
    })),
    ...input.breaks.map((b) => ({
      start: b.start, order: 0,
      lines: [`${utcToLondon(b.start).time}–${utcToLondon(b.end).time} — ${b.label === "" ? "Break" : b.label}`],
    })),
  ].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.order - b.order));
  const head = [...(input.clubName ? [input.clubName] : []), input.name, `${longDate(input.startUtc)} · ${input.venuePostcode}`];
  return [...head, ...(items.length > 0 ? ["", ...items.flatMap((i) => i.lines)] : [])].join("\n");
}

/** Europe/London wall-clock times and UTC instants (YYYY-MM-DDTHH:MM:SSZ). Pure; independent of the host's time zone. */

/** `invalid` is a malformed or impossible date or time; the other two are London clock changes. */
export class LondonTimeError extends RangeError {
  readonly kind: "invalid" | "nonexistent" | "ambiguous";
  constructor(kind: LondonTimeError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

const parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

const HOUR = 3_600_000;
const toIso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

/** The London wall clock at an instant, as a date, a time and the same wall clock read as UTC milliseconds. */
function wallClock(ms: number): { date: string; time: string; wallMs: number } {
  const p: Record<string, string> = {};
  for (const part of parts.formatToParts(ms)) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`,
    wallMs: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute),
  };
}

export function utcToLondon(iso: string): { date: string; time: string } {
  const { date, time } = wallClock(Date.parse(iso));
  return { date, time };
}

/**
 * London wall-clock time on a YYYY-MM-DD date as a UTC instant, right in both GMT and BST.
 * Throws LondonTimeError (a RangeError) for a malformed or impossible date or time, for a time the
 * clocks skip (spring forward) and for a time they repeat (autumn), where there is no single answer.
 */
export function londonToUtc(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new LondonTimeError("invalid", `Invalid date "${date}": expected a real YYYY-MM-DD date`);
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new LondonTimeError("invalid", `Invalid time "${time}": expected HH:MM from 00:00 to 23:59`);
  }
  const wall = Date.parse(`${date}T${time}:00Z`);
  // London is UTC+0 (GMT) or UTC+1 (BST): the wall time is valid under each offset whose conversion lands back on it.
  const matches = [wall, wall - HOUR].filter((utc) => wallClock(utc).wallMs === wall);
  if (matches.length === 0) throw new LondonTimeError("nonexistent", `${date} ${time} does not exist in London (the clocks go forward)`);
  if (matches.length === 2) throw new LondonTimeError("ambiguous", `${date} ${time} happens twice in London (the clocks go back)`);
  return toIso(matches[0]);
}

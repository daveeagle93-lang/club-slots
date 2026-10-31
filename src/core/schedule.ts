/**
 * Pure, deterministic schedule engine: no I/O, no clock, no globals.
 *
 * Rules
 * - Instants are UTC strings of the fixed form YYYY-MM-DDTHH:MM:SSZ; durations are whole minutes.
 * - Sessions are laid out from `start`; each is followed by `gapMinutes` before the next.
 *   No gap is needed before a break or before `end`.
 * - A cursor inside a break jumps to that break's end (so adjacent or overlapping breaks chain).
 * - A session ending exactly at a break start, or exactly at `end`, fits.
 * - A session that would run past `end` is never placed and produces no suggestion.
 * - A session that would overrun a break start is never placed; the cursor resumes at the
 *   ORIGINAL break end. Time left empty before a break is simply unused buffer.
 *
 * Near-miss suggestions are advisory only. If the dropped session overran the break start by
 * no more than `nearMissMinutes`, a suggestion proposes moving the break LATER (to start where
 * the dropped session would have ended, keeping its duration). The schedule itself is always
 * computed against the breaks as given; breaks are never moved or changed, and never moved earlier.
 * A suggestion is suppressed (the schedule is unaffected) if the moved break would overlap any
 * other break (merely touching is fine) or would end after `end` (ending exactly at `end` is fine).
 */
export interface TimeRange { start: string; end: string }
export interface ScheduleInput {
  start: string; end: string;
  sessionMinutes: number; gapMinutes: number;
  breaks: TimeRange[];
  nearMissMinutes?: number;
}
export interface NearMissSuggestion {
  droppedSlot: TimeRange;
  break: TimeRange;
  overrunMinutes: number;
  suggestedBreak: TimeRange;
}
export interface ScheduleResult { slots: TimeRange[]; suggestions: NearMissSuggestion[] }
export const DEFAULT_NEAR_MISS_MINUTES = 10;

const MINUTE = 60_000;
const toIso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

function toMs(iso: string): number {
  const ms = Date.parse(iso);
  // The round trip rejects wrong formats and impossible dates (30 February, hour 24).
  if (Number.isNaN(ms) || toIso(ms) !== iso) {
    throw new RangeError(`Invalid instant "${iso}": expected YYYY-MM-DDTHH:MM:SSZ`);
  }
  return ms;
}

function requireMinutes(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be a whole number of minutes >= ${min}, got ${value}`);
  }
}

export function generateSchedule(input: ScheduleInput): ScheduleResult {
  const start = toMs(input.start);
  const end = toMs(input.end);
  if (end <= start) throw new RangeError("end must be after start");
  requireMinutes("sessionMinutes", input.sessionMinutes, 1);
  requireMinutes("gapMinutes", input.gapMinutes, 0);
  const nearMissMinutes = input.nearMissMinutes ?? DEFAULT_NEAR_MISS_MINUTES;
  requireMinutes("nearMissMinutes", nearMissMinutes, 0);
  const session = input.sessionMinutes * MINUTE;
  const gap = input.gapMinutes * MINUTE;
  const nearMiss = nearMissMinutes * MINUTE;
  const slots: TimeRange[] = [];
  const suggestions: NearMissSuggestion[] = [];
  const breaks = input.breaks
    .map((b) => {
      const range = { start: toMs(b.start), end: toMs(b.end) };
      if (range.end <= range.start) throw new RangeError("a break must end after it starts");
      return range;
    })
    .sort((a, b) => a.start - b.start);
  let cursor = start;
  for (;;) {
    const inside = breaks.find((b) => b.start <= cursor && cursor < b.end);
    if (inside) {
      cursor = inside.end;
      continue;
    }
    const sessionEnd = cursor + session;
    if (sessionEnd > end) break;
    const overrun = breaks.find((b) => b.start > cursor && b.start < sessionEnd);
    if (overrun) {
      const movedStart = sessionEnd;
      const movedEnd = sessionEnd + overrun.end - overrun.start;
      const collides = breaks.some((b) => b !== overrun && movedStart < b.end && b.start < movedEnd);
      if (sessionEnd - overrun.start <= nearMiss && !collides && movedEnd <= end) {
        suggestions.push({
          droppedSlot: { start: toIso(cursor), end: toIso(sessionEnd) },
          break: { start: toIso(overrun.start), end: toIso(overrun.end) },
          overrunMinutes: (sessionEnd - overrun.start) / MINUTE,
          suggestedBreak: { start: toIso(movedStart), end: toIso(movedEnd) },
        });
      }
      cursor = overrun.end;
      continue;
    }
    slots.push({ start: toIso(cursor), end: toIso(sessionEnd) });
    cursor = sessionEnd + gap;
  }
  return { slots, suggestions };
}

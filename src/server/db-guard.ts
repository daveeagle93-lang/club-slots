/**
 * An in-batch precondition for D1. A batch runs as one transaction, so a statement that errors rolls back
 * every statement in it. `guard` is such a statement: it errors unless its condition holds, which lets a
 * batch check something (for example "no booking has appeared on a slot we are about to remove") at the
 * moment it runs, after earlier statements in the same batch and with no gap in which another request
 * could change the answer.
 *
 * The error is SQLite's "integer overflow", raised by `abs(-9223372036854775808)` (the one value whose
 * absolute value does not fit in 64 bits) in the ELSE branch of a CASE, so it is only evaluated when the
 * condition is false. Checked on local D1 (workerd's SQLite): the batch fails with
 * "D1_ERROR: integer overflow: SQLITE_ERROR" and nothing in it is written. The alternative,
 * `json(CASE WHEN ... THEN '1' ELSE 'x' END)` ("malformed JSON"), also works but could be mistaken for a
 * real JSON error from a json_each() parameter, whereas nothing else in these batches can overflow.
 * Production D1 is the same SQLite engine; this has not been run against remote D1.
 *
 * `conditionSql` is trusted SQL written by the caller, never user input; values go in `binds`. D1 allows
 * at most 100 bound parameters per statement, so pass a list as ONE JSON text and read it with json_each(?).
 */
export function guard(db: D1Database, conditionSql: string, ...binds: unknown[]): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN ${conditionSql} THEN 1 ELSE abs(-9223372036854775808) END`).bind(...binds);
}

/** True if the error is a failed `guard` (so the batch wrote nothing), not some other database error. */
export const isGuardFailure = (e: unknown): boolean => e instanceof Error && e.message.includes("integer overflow");

/**
 * A guard that aborts the batch if the event's schedule definition is no longer what the handler read:
 * start, end, session length, gap, the set of breaks (name, price, break labels and the rest don't matter) and the
 * layout's `config_rev`. It closes the race where another admin edits the event between a handler's read and its
 * batch, which could otherwise put a booking on a slot the edit removed, or in a lane or place the edit removed.
 * The handler answers `event_changed` (or re-reads the event) when the batch fails on it.
 *
 * INVARIANT: every code path that edits an event's lanes, capacity or identity limit, or the number of its booking fields,
 * which of them identify a booking, which are required or how long each can be (not their labels), must increase
 * event_layout.config_rev in the same batch as the edit. The revision is the only thing that tells a booking request
 * that those changed, because they are not part of the schedule. An event with no layout row counts
 * as revision 0.
 *
 * The schedule depends only on the SET of (start, end) pairs: an identical duplicate break has the same effect
 * as one. So the breaks are compared as sets of `start|end` strings, in both directions, with no ordering or
 * aggregation (SQLite does not document the order of a subquery feeding `group_concat`). The handler's set goes
 * in as ONE JSON parameter, used twice.
 */
export function scheduleUnchanged(
  db: D1Database,
  event: {
    id: number; startUtc: string; endUtc: string; sessionMinutes: number; gapMinutes: number; configRev: number;
    breaks: { start: string; end: string }[];
  },
): D1PreparedStatement {
  const loaded = JSON.stringify([...new Set(event.breaks.map((b) => `${b.start}|${b.end}`))]);
  return guard(
    db,
    `(SELECT COUNT(*) FROM events WHERE id = ? AND start_utc = ? AND end_utc = ? AND session_minutes = ? AND gap_minutes = ?) = 1
     AND COALESCE((SELECT config_rev FROM event_layout WHERE event_id = ?), 0) = ?
     AND NOT EXISTS (SELECT 1 FROM breaks WHERE event_id = ? AND start_utc || '|' || end_utc NOT IN (SELECT value FROM json_each(?)))
     AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE value NOT IN (SELECT start_utc || '|' || end_utc FROM breaks WHERE event_id = ?))`,
    event.id, event.startUtc, event.endUtc, event.sessionMinutes, event.gapMinutes, event.id, event.configRev, event.id, loaded, loaded, event.id,
  );
}

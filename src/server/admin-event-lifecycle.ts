import { isValidSlug } from "../core/slug";
import { guard, isGuardFailure } from "./db-guard";

/** Sets the archived flag by slug; null if there is no such event. Idempotent: setting the same value again is fine. */
export async function setArchived(db: D1Database, slug: string, archived: boolean): Promise<{ archived: boolean } | null> {
  if (!isValidSlug(slug)) return null;
  const row = await db
    .prepare("UPDATE events SET archived = ? WHERE slug = ? RETURNING archived")
    .bind(archived ? 1 : 0, slug).first<{ archived: number }>();
  return row ? { archived: row.archived === 1 } : null;
}

export type DeleteResult =
  | { kind: "deleted"; slug: string; name: string; bookings: number }
  | { kind: "not_found" }
  | { kind: "confirmation_mismatch" };

/** Test seam: runs after the event was read and before the batch, where another request could change things. */
export interface LifecycleHooks { afterRead?: () => Promise<void> }

/**
 * Permanently deletes the event with its breaks, bookings, lanes and layout, if `confirmName` is exactly the stored name
 * (raw string comparison: no trimming, folding or Unicode normalisation; the page may trim what was typed, the
 * server never does). Bookings, breaks and the event are deleted explicitly in one batch rather than relying
 * on ON DELETE CASCADE (the lanes and the layout do go by cascade, with the event, and only after the bookings
 * that point at the lanes are gone), and the batch starts with a guard that the event still exists under the
 * confirmed name: a second delete racing the first finds nothing (not_found), and an event renamed after the
 * read is not deleted on the strength of the old name. The booking count is what the batch actually deleted, so a
 * booking that landed after the read is deleted and counted too.
 */
export async function deleteEvent(db: D1Database, slug: string, confirmName: unknown, hooks: LifecycleHooks = {}): Promise<DeleteResult> {
  if (!isValidSlug(slug)) return { kind: "not_found" };
  const event = await db.prepare("SELECT id, name FROM events WHERE slug = ?").bind(slug).first<{ id: number; name: string }>();
  if (!event) return { kind: "not_found" };
  if (typeof confirmName !== "string" || confirmName !== event.name) return { kind: "confirmation_mismatch" };
  await hooks.afterRead?.();
  try {
    const results = await db.batch([
      guard(db, "EXISTS (SELECT 1 FROM events WHERE id = ? AND name = ?)", event.id, event.name),
      db.prepare("DELETE FROM bookings WHERE event_id = ? RETURNING id").bind(event.id),
      db.prepare("DELETE FROM breaks WHERE event_id = ?").bind(event.id),
      db.prepare("DELETE FROM events WHERE id = ?").bind(event.id),
    ]);
    return { kind: "deleted", slug, name: event.name, bookings: results[1].results.length };
  } catch (e) {
    if (!isGuardFailure(e)) throw e;
    const now = await db.prepare("SELECT 1 AS n FROM events WHERE id = ?").bind(event.id).first();
    return now ? { kind: "confirmation_mismatch" } : { kind: "not_found" };
  }
}

export const MAX_CLEAR_SLUGS = 100;

export interface ClearPastResult {
  deletedEvents: number;
  deletedBookings: number;
  skipped: { slug: string; reason: "not_past" | "not_found" }[];
}

/** Test seam: runs just before the batch, where another request could change an event. */
export interface ClearHooks { beforeBatch?: () => Promise<void> }

/**
 * Permanently deletes the listed events that are past (`end_utc <= now`, archived or not), with their breaks
 * and bookings, in one atomic batch. The slugs travel as ONE JSON parameter (D1 allows 100 bound parameters,
 * and the list may be that long). The "only past" rule is a condition of each DELETE inside the batch, so an
 * event edited into the future after the admin chose it is not deleted. Every other slug is left alone and
 * reported: still existing after the batch means not_past, gone means not_found. The caller has validated
 * the slugs (1 to 100, distinct, well formed).
 */
export async function clearPastEvents(db: D1Database, now: Date, slugs: string[], hooks: ClearHooks = {}): Promise<ClearPastResult> {
  const nowIso = `${now.toISOString().slice(0, 19)}Z`;
  const list = JSON.stringify(slugs);
  const chosen = `slug IN (SELECT value FROM json_each(?)) AND end_utc <= ?`;
  await hooks.beforeBatch?.();
  const [bookings, , events, remaining] = await db.batch([
    db.prepare(`DELETE FROM bookings WHERE event_id IN (SELECT id FROM events WHERE ${chosen}) RETURNING id`).bind(list, nowIso),
    db.prepare(`DELETE FROM breaks WHERE event_id IN (SELECT id FROM events WHERE ${chosen})`).bind(list, nowIso),
    db.prepare(`DELETE FROM events WHERE ${chosen} RETURNING slug`).bind(list, nowIso),
    db.prepare("SELECT slug FROM events WHERE slug IN (SELECT value FROM json_each(?))").bind(list),
  ]);
  const deleted = new Set((events.results as { slug: string }[]).map((r) => r.slug));
  const kept = new Set((remaining.results as { slug: string }[]).map((r) => r.slug));
  return {
    deletedEvents: deleted.size,
    deletedBookings: bookings.results.length,
    skipped: slugs.filter((s) => !deleted.has(s)).map((slug) => ({ slug, reason: kept.has(slug) ? "not_past" : "not_found" })),
  };
}

/** The request's slugs: 1 to 100 distinct well-formed ones, or the field error to report. */
export function checkClearSlugs(value: unknown): { slugs: string[] } | { message: string } {
  const ok = Array.isArray(value) && value.length >= 1 && value.length <= MAX_CLEAR_SLUGS
    && value.every((v) => typeof v === "string" && isValidSlug(v)) && new Set(value).size === value.length;
  return ok ? { slugs: value as string[] } : { message: `Send 1 to ${MAX_CLEAR_SLUGS} different event links (slugs).` };
}

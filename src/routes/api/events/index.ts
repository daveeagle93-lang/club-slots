import type { RouteHandler } from "../../../server/env";
import { noStore } from "../../../server/bookings";
import { errorResponse, json } from "../../../server/http";

const MAX_EVENTS = 50;

/**
 * The landing page's list: listed events open to the public that haven't started yet, soonest first. Only what the
 * list shows (slug for the link, name, times); no ids, counts, venue or details.
 */
export const onRequestGet: RouteHandler = async ({ env }) => {
  const nowIso = `${new Date().toISOString().slice(0, 19)}Z`;
  try {
    const { results } = await env.DB.prepare(
      `SELECT slug, name, start_utc, end_utc FROM events
       WHERE archived = 0 AND listed = 1 AND slug IS NOT NULL AND start_utc > ?1
       ORDER BY start_utc, id LIMIT ${MAX_EVENTS}`,
    ).bind(nowIso).all<{ slug: string; name: string; start_utc: string; end_utc: string }>();
    return json(
      { events: results.map((e) => ({ slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc })) },
      200,
      { "Cache-Control": "no-store" },
    );
  } catch (e) {
    // Only the message is logged: an error object can carry SQL text and bound values.
    console.error("listing events failed:", e instanceof Error ? e.message : String(e));
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
  }
};

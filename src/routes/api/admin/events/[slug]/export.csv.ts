import { toCsv } from "../../../../../core/csv";
import { utcToLondon } from "../../../../../core/london";
import { editFailed, eventNotFound } from "../../../../../server/admin-event-edit";
import { refuseUnlessAdmin } from "../../../../../server/admin-context";
import type { RouteHandler } from "../../../../../server/env";
import { loadEventBySlug } from "../../../../../server/events";
import { apiHeaders } from "../../../../../server/http";

interface Row { slot_start_utc: string; lane_name: string; value_1: string; value_2: string; value_3: string; value_4: string; created_at: string }

const london = (iso: string): string => {
  const { date, time } = utcToLondon(iso);
  return `${date} ${time}`;
};

/**
 * The event's bookings as a CSV download (Time, Lane, one column for each field of the booking form headed by its label, Booked at;
 * London time; by slot start, then lane, then place). The Lane column is there only when the event has a named lane, so one
 * unnamed lane with the Dog and Handler fields gives the v1.0 file. One query.
 * Values, labels and lane names are user input, so toCsv guards every cell (the headers too) against spreadsheet formulas. The file name is the slug,
 * which loadEventBySlug has already limited to letters, digits, hyphens and underscores, so it can't break the header.
 */
export const onRequestGet: RouteHandler<"slug"> = async ({ env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    const { results } = await env.DB
      .prepare(`SELECT b.slot_start_utc, l.name AS lane_name, b.value_1, b.value_2, b.value_3, b.value_4, b.created_at
         FROM bookings b JOIN event_lanes l ON l.id = b.lane_id WHERE b.event_id = ? ORDER BY b.slot_start_utc, l.position, b.place, b.id`)
      .bind(event.id)
      .all<Row>();
    const withLane = event.lanes.some((l) => l.name !== "");
    const csv = toCsv([
      ["Time", ...(withLane ? ["Lane"] : []), ...event.fields.map((f) => f.label), "Booked at"],
      ...results.map((r) => [
        london(r.slot_start_utc), ...(withLane ? [r.lane_name] : []),
        ...event.fields.map((f) => [r.value_1, r.value_2, r.value_3, r.value_4][f.position - 1]), london(r.created_at),
      ]),
    ]);
    return new Response(csv, {
      headers: {
        ...apiHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${event.slug}-bookings.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return editFailed("exportBookings", e);
  }
};

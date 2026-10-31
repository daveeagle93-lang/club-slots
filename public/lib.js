// Pure helpers: no DOM, no network. Everything is shown in London time, whatever the device's timezone.

const TZ = "Europe/London";
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** "09:00" */
export const formatTime = (iso) => timeFmt.format(new Date(iso));

/** "Saturday 13 June 2026" (built from parts, as the separator punctuation varies between ICU versions) */
export function formatDate(iso) {
  const p = Object.fromEntries(dateFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/** "09:00–16:00" */
export const formatTimeRange = (startIso, endIso) => `${formatTime(startIso)}–${formatTime(endIso)}`;

// Duplicate of src/core/format.ts (the browser can't import it without a build); lib.test.ts checks they agree.
export function formatPounds(pence) {
  if (!Number.isInteger(pence) || pence < 0) {
    throw new RangeError(`pence must be a non-negative integer, got ${pence}`);
  }
  if (pence === 0) return "Free";
  const pounds = Math.floor(pence / 100).toLocaleString("en-GB");
  return `£${pounds}.${String(pence % 100).padStart(2, "0")}`;
}

/** The slug from "/e/<slug>" (trailing slash allowed), or null. */
export function slugFromPathname(pathname) {
  const m = /^\/e\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m ? m[1] : null;
}

export const mapsUrl = (postcode) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(postcode)}`;

export const slotsLeftText = (n) => (n === 0 ? "Fully booked" : n === 1 ? "1 slot left" : `${n} slots left`);

/** As slotsLeftText, for a page that counts places (lanes or more than one place per time). */
export const placesLeftText = (n) => (n === 0 ? "Fully booked" : n === 1 ? "1 place left" : `${n} places left`);

/** Plain-text booking summary for the clipboard. */
export function copyText(event, booking) {
  const lines = [
    event.name,
    `${formatDate(booking.slot.start)}, ${formatTimeRange(booking.slot.start, booking.slot.end)}`,
    ...booking.fields.map((f) => `${f.label}: ${f.value}`),
    ...(booking.lane?.name ? [`Lane: ${booking.lane.name}`] : []),
    `Venue: ${event.venuePostcode}`,
    `Cost: ${formatPounds(event.costPence)}`,
  ];
  if (event.details) lines.push(event.details);
  return lines.join("\n");
}

/** 128 random bits as 22 base64url characters: one per booking form, reused when a request is retried. */
export function newIdempotencyKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Paragraphs of the privacy notice: blank lines separate them. */
export const privacyParagraphs = (text) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/** Only paths the server issues for booking pages are ever turned into links. */
export const isBookingPath = (path) => typeof path === "string" && /^\/e\/[A-Za-z0-9_-]+$/.test(path);

const MAX_COST_PENCE = 100_000; // as src/server/admin-events.ts

/**
 * Whole pounds or pounds and pence as typed ("12", "12.5", "12.50", "£12") to integer pence, or an error message.
 * Integer arithmetic on the digits only: no floating point, no exponents, no signs.
 */
export function penceFromPounds(text) {
  const t = String(text).trim().replace(/^£\s*/, "");
  if (t === "") return { error: "Enter the cost in pounds, or 0 if it's free." };
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t);
  if (!m || m[2] === "") return { error: "Enter the cost in pounds, for example 12.50." };
  const fraction = m[2] ?? "";
  if (fraction.length > 2) return { error: "Use two decimal places at most, for example 12.50." };
  const pence = Number(m[1]) * 100 + Number(fraction.padEnd(2, "0"));
  if (pence > MAX_COST_PENCE) return { error: "The cost can be at most £1,000." };
  return { pence };
}

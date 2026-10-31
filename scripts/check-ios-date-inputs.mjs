// Opt-in layout check for the admin pages, and the public booking page, on a phone (npm run test:webkit).
//
// iOS Safari (WebKit) gives input[type=date|time] an intrinsic minimum width, which made the Date field run past
// the card and the Start/End pairs overlap on a phone. This loads the real pages at phone widths and checks that no
// date or time input leaves its field, row, group or card, that pairs in one row don't overlap, and that the page
// doesn't scroll sideways. Pages and states: the events list, create (plain, with templates and after switching
// template), edit, schedule, settings, and the templates page (list, create form with breaks, edit form with breaks).
// On every state it also checks that no element sticks out past the right edge of the screen (except scrolling boxes
// and the visually-hidden class), and that the admin navigation (.admin-nav) is fully visible, has tappable links
// (>= 48px each way) on one row, doesn't overlap or scroll sideways, and sits under the header band.
// On every form it also puts a validation error under ONE cell of each paired row (.field-row: Start/End, session/gap,
// the break rows) and checks that the other cell's label and input stay level with the first cell's (within 1px). Under 360px the cells stack (one
// column), so that check applies at 390px only; at 320px the rows are checked for stacking, not alignment.
//
// The admin pages for lanes and places (an event with three lanes of two places) are checked in these states: the schedule
// (every time as a header with a row per booking and an Add row per lane with room; then with the Move panel open, then
// with the Add panel open), the event edit form with its Lanes card (three lanes; with validation errors under a lane and
// under the places; after removing a lane, with the bookings it would strand listed), and the templates page (the list with
// its "3 lanes x 2 places" line, the create form with three lanes, the edit form of a template with lanes). Besides the checks
// every state gets, these check that every button, select and field in them is at least 48px tall and wide, and that rows,
// lane rows, buttons and fields stay inside the card that holds them.
//
// The booking form's fields (an event or template has one to four, each with a label, Required, Max length and Identifies a booking,
// and a limit on how many bookings one identity may hold) are checked in these states: the create form with four fields (long
// labels, one optional, two identifying a booking) and, after a rejected save, errors under a label, a max length, the limit and the
// card; the edit form of an event that has bookings (the card locked: Add, Remove and the Identifies boxes disabled, with the hint);
// the template form (create with a second field, edit with a template that has three fields); and the schedule's Add booking panel
// for a form of three fields. They check that every control (inputs, the two checkboxes' labels, buttons) is at least 48px
// tall and wide, that the field rows, checkboxes and the limit stay inside the card, and that the paired Required / Identifies
// a booking cells stay level whichever of them shows an error.
//
// The public booking page (/e/<slug>, event.html with the booking API stubbed) is checked in these states: one lane with
// one place (the v1.0 look), one lane with two places, one named lane, three lanes with two places each (all open; one
// lane full and a started time; long lane names; a lane chosen with the form open; the confirmation with its Lane row).
// There it checks: no sideways scroll, nothing past the right edge, every time and lane button at least 48px tall, text
// not clipped in them (scrollWidth within clientWidth), lane buttons inside their card and not overlapping each other, and
// at 390px (normal lane names) the three lane buttons of a card on one row (at 320px they may wrap).
//
//   node scripts/check-ios-date-inputs.mjs [--engine webkit|chromium] [--allow-skip] [--break-css]
//                                          [--shots] [--shots-dir <dir>]
//
// --engine      webkit (default) or chromium. Chromium never showed the bug, so it is only a sanity check of the
//               script and the page; only a WebKit run says anything about iOS.
// --allow-skip  exit 0 instead of 2 when WebKit can't launch here (Playwright supports a limited set of systems).
// --break-css   self-test: breaks the CSS for every kind of check (wide date and time inputs, short nav links, an error shown above its input in paired rows, short buttons, selects
//               and fields in the schedule rows, Add and Move panels, lane rows and booking form card, short time and lane buttons
//               and wide lane grids on the booking page) and counts the failures PER CATEGORY (date and time inputs, admin
//               navigation, paired rows, admin lanes and booking-form card, public booking page). It exits 1 (a failing run, as
//               it must) only if every category caught something; if any category found nothing it says so and exits 0, because
//               that check can't fail yet and the self-test has failed.
// --shots       also writes full-page PNGs of the main states (<name>-<width>-<scheme>.png) to --shots-dir (default:
//               slot-booker-layout in the system temp folder), for looking at.
// Every state runs at both widths in light and dark.
//
// Exit codes: 0 all checks passed (or skipped with --allow-skip), 1 a check failed, 2 the engine can't launch
// (not a pass).
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright-core";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const WIDTHS = [320, 390];
const TOLERANCE = 0.5;
const SLUG = "abcdefghijklmnop1234";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
};
// A 1x1 transparent PNG, for the icon links.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const engineName = args.includes("--engine") ? args[args.indexOf("--engine") + 1] : "webkit";
const shotsDir = args.includes("--shots-dir") ? resolve(args[args.indexOf("--shots-dir") + 1]) : join(tmpdir(), "slot-booker-layout");
const engines = { webkit, chromium };
if (!engines[engineName]) {
  console.error(`Unknown engine "${engineName}": use webkit or chromium.`);
  process.exit(2);
}

/** Serves ./public the way the Worker's assets do: /admin/new is admin/new.html, /admin/ is admin/index.html. */
function startServer() {
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index";
    if (/^\/e\/[A-Za-z0-9_-]+$/.test(path)) path = "/event"; // the booking page, as the Worker serves it
    let file = resolve(join(PUBLIC_DIR, path));
    if (!extname(file)) file += ".html";
    if (!file.startsWith(PUBLIC_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

// The shape of GET /api/admin/events/:slug (eventDetail in src/server/admin-event-edit.ts), with two breaks.
const EVENT = {
  slug: SLUG, name: "Saturday agility", archived: false, listed: true,
  date: "2030-06-15", start: "10:00", end: "14:00", sessionMinutes: 15, gapMinutes: 5, costPence: 1200,
  venuePostcode: "AB1 2CD", details: "Bring water.",
  startUtc: "2030-06-15T09:00:00.000Z", endUtc: "2030-06-15T13:00:00.000Z",
  fields: [{ label: "Dog", required: true, maxLength: 80, identity: true }, { label: "Handler", required: true, maxLength: 80, identity: true }], identityLimit: 1, hasBookings: false,
  breaks: [
    { start: "11:00", end: "11:30", label: "Tea", startUtc: "2030-06-15T10:00:00.000Z", endUtc: "2030-06-15T10:30:00.000Z" },
    { start: "12:30", end: "13:00", label: "Lunch", startUtc: "2030-06-15T11:30:00.000Z", endUtc: "2030-06-15T12:00:00.000Z" },
  ],
};
const SLOTS = [{ start: "2030-06-15T09:00:00.000Z", end: "2030-06-15T09:15:00.000Z" }];
// Schedule page rows: a free slot, a booked one with long names, the break between, another booked one. Each slot lists its one lane.
const dh = (dog, handler) => [{ label: "Dog", value: dog }, { label: "Handler", value: handler }];
const oneLane = (...bookings) => [{ laneId: 1, laneName: "", free: bookings.length ? 0 : 1, bookings }];
const SCHEDULE_SLOTS = [
  { start: "2030-06-15T09:00:00.000Z", end: "2030-06-15T09:15:00.000Z", places: oneLane() },
  { start: "2030-06-15T09:20:00.000Z", end: "2030-06-15T09:35:00.000Z", places: oneLane({ id: 1, fields: dh("Bartholomew-Maximilian", "Alexandria Featherstonehaugh-Cholmondeley") }) },
  { start: "2030-06-15T10:40:00.000Z", end: "2030-06-15T10:55:00.000Z", places: oneLane({ id: 2, fields: dh("Pip", "Sam") }) },
];
// An event with three lanes and two places in each (the shape of eventDetail's `event`, and its slots with `places`).
const RING_LANES = [{ id: 31, name: "Ring 1" }, { id: 32, name: "Ring 2" }, { id: 33, name: "Indoor hall, far end" }];
const LANED_EVENT = { ...EVENT, lanes: RING_LANES, capacity: 2 };
const LONG_DOG = { id: 1, fields: dh("Bartholomew-Maximilian", "Alexandria Featherstonehaugh-Cholmondeley") };
const heldIn = (lane, free, ...bookings) => ({ laneId: lane.id, laneName: lane.name, free, bookings });
// 10:00 (London) all free; 10:20 Ring 1 full (a long name and a short one), Ring 2 one booking, hall free; 11:40 the hall full, Rings free.
const LANE_SLOTS = [
  { start: "2030-06-15T09:00:00.000Z", end: "2030-06-15T09:15:00.000Z", places: RING_LANES.map((l) => heldIn(l, 2)) },
  { start: "2030-06-15T09:20:00.000Z", end: "2030-06-15T09:35:00.000Z",
    places: [heldIn(RING_LANES[0], 0, LONG_DOG, { id: 2, fields: dh("Pip", "Sam") }), heldIn(RING_LANES[1], 1, { id: 3, fields: dh("Moss", "Lee Ann") }), heldIn(RING_LANES[2], 2)] },
  { start: "2030-06-15T10:40:00.000Z", end: "2030-06-15T10:55:00.000Z",
    places: [heldIn(RING_LANES[0], 2), heldIn(RING_LANES[1], 2), heldIn(RING_LANES[2], 0, { id: 4, fields: dh("Fly", "Jo") }, { id: 5, fields: dh("Tess", "Ali") })] },
];
// Bookings that removing the third lane would strand, as the preview lists them.
const STRANDED = [{ id: 4, slotStart: "2030-06-15T10:40:00.000Z", fields: dh("Fly", "Jo"), lane: RING_LANES[2] }, { id: 5, slotStart: "2030-06-15T10:40:00.000Z", fields: dh("Tess", "Ali"), lane: RING_LANES[2] }];
// Booking forms with long labels: four fields (the third optional, with a short longest value; two identify a booking), and three for the Add panel.
const draft = (label, o = {}) => ({ label, required: true, maxLength: 80, identity: false, ...o });
const FOUR_FIELDS = [
  draft("Name of the dog as on the entry form", { identity: true }), draft("Handler's full name and club", { identity: true }),
  draft("Phone number for the day of the event", { required: false, maxLength: 20 }), draft("Anything else we should know?", { required: false, maxLength: 40 }),
];
const THREE_FIELDS = FOUR_FIELDS.slice(0, 3);
// The card's controls and what each must stay inside (the same ids for the event form's card, `event-`, and the template form's, `tpl-`).
const cardControls = (limit) => `.field-def button, .field-def .select-all, .field-def input[type="text"], .field-def input[type="number"], .fields-group > button, ${limit}`;
const cardInside = (limit) => [[".field-def", ".fields-group"], [".field-def input", ".field-def"], [".field-def .select-all", ".field-def"], [".field-def button", ".field-def"], [limit, ".fields-group"]];
// The events list (GET /api/admin/events): two upcoming events, the second with a long unbroken name.
const LIST_EVENTS = [
  { slug: SLUG, path: `/e/${SLUG}`, name: "Saturday agility", startUtc: EVENT.startUtc, endUtc: EVENT.endUtc, bookedCount: 3, slotCount: 12, full: false, listed: true, bookings: { open: true } },
  { slug: `${SLUG}2`, path: `/e/${SLUG}2`, name: "Extraordinarily-long-event-name-without-any-spaces-at-all-to-test-wrapping", startUtc: EVENT.startUtc, endUtc: EVENT.endUtc, bookedCount: 12, slotCount: 12, full: true, listed: false, bookings: { open: false } },
];

// The public booking page (GET /api/events/:slug, as the Worker answers it). Times are in the future, so only a status of
// "past" makes a slot started. Slots are 09:00 to 10:20 London time (BST), every 20 minutes.
const field = (position, label, required = true, maxLength = 80) => ({ position, label, required, maxLength });
const PUBLIC_EVENT = {
  slug: SLUG, name: "Saturday agility", startUtc: EVENT.startUtc, endUtc: EVENT.endUtc, costPence: 1200, venuePostcode: "AB1 2CD", details: "Bring water.", archived: false,
  fields: [field(1, "Dog"), field(2, "Handler")],
};
const SLOT_STARTS = ["08:00", "08:20", "08:40", "09:00", "09:20"].map((t) => `2030-06-15T${t}:00Z`);
const PUBLIC_END = (start) => new Date(Date.parse(start) + 15 * 60_000).toISOString();
const publicSlot = (n, status, ...free) => ({ start: SLOT_STARTS[n], end: PUBLIC_END(SLOT_STARTS[n]), status, places: free.map((f, i) => ({ laneId: i + 1, free: f })) });
const laneList = (...names) => names.map((name, i) => ({ id: i + 1, name }));
const PRIVACY = "We store the details you enter on this form (Dog, Handler) and the slot you choose so the club can run the event.\n\nThe details are kept until an organiser deletes the event.";
/** The public states: what the page is given, and what the form is told when a booking is made (lane 1 at the first open time). */
const PUBLIC_STATES = {
  single: { event: { ...PUBLIC_EVENT, lanes: laneList(""), capacity: 1 }, slots: [publicSlot(0, "past", 1), publicSlot(1, "free", 1), publicSlot(3, "free", 1), publicSlot(4, "free", 1)] },
  singleTwoPlaces: { event: { ...PUBLIC_EVENT, lanes: laneList(""), capacity: 2 }, slots: [publicSlot(0, "past", 1), publicSlot(1, "free", 2), publicSlot(2, "free", 1), publicSlot(3, "free", 2)] },
  singleNamed: { event: { ...PUBLIC_EVENT, lanes: laneList("Main ring"), capacity: 1 }, slots: [publicSlot(0, "past", 1), publicSlot(1, "free", 1), publicSlot(2, "free", 1)] },
  // 08:00 started; 08:20 all open; 08:40 Ring 2 full; 09:00 only Ring 3 has a place; 09:20 full (hidden)
  lanes: { event: { ...PUBLIC_EVENT, lanes: laneList("Ring 1", "Ring 2", "Ring 3"), capacity: 2 },
    slots: [publicSlot(0, "past", 2, 2, 2), publicSlot(1, "free", 2, 2, 2), publicSlot(2, "free", 2, 0, 1), publicSlot(3, "free", 0, 0, 1), publicSlot(4, "taken", 0, 0, 0)] },
  // A form of four fields, two of them optional, with labels long enough to wrap.
  fourFields: { event: { ...PUBLIC_EVENT, lanes: laneList(""), capacity: 1, fields: [field(1, "Rider's full name as on the entry form"), field(2, "Pony"), field(3, "Phone number for the day (optional details)", false, 20), field(4, "Notes", false, 40)] },
    slots: [publicSlot(0, "past", 1), publicSlot(1, "free", 1), publicSlot(3, "free", 1), publicSlot(4, "free", 1)] },
  longLanes: { event: { ...PUBLIC_EVENT, lanes: laneList("Extraordinarily-long-lane-name-without-any-spaces-at-all", "Novice and intermediate scent work", "Ring 3"), capacity: 2 },
    slots: [publicSlot(1, "free", 2, 1, 0), publicSlot(2, "free", 0, 2, 2)] },
};
const ADMIN_SETTINGS = {
  clubName: "Test club", website: "https://example.org", privacyContact: { name: "Pat", email: "pat@example.org" },
  logo: null, theme: { primary: "#0b5cad", accent: "#0b5cad", isDefault: true }, icons: null,
};

const tpl = (id, name, isDefault, breaks, more = {}) => ({
  id, name, isDefault, details: "Bring water and a towel.", venuePostcode: "AB1 2CD", costPence: 1200, start: "10:00", end: "16:00",
  sessionMinutes: 15, gapMinutes: 5, breaks, shareMessage: "", ...more,
});
// The templates page's list: a default, a long name with spaces (60 characters, the most allowed) and one with no spaces at all.
const LIST_TEMPLATES = [
  tpl(1, "Weekend scent trial", true, [{ start: "12:00", end: "12:30", label: "Lunch" }, { start: "14:00", end: "14:15", label: "" }]),
  tpl(2, "Regional qualifier, novice and intermediate scent work", false, [{ start: "11:00", end: "11:30", label: "Tea break for everyone and the judges" }, { start: "13:00", end: "13:45", label: "Lunch" }],
    { lanes: [{ name: "Ring 1" }, { name: "Ring 2" }, { name: "Indoor hall, far end" }], capacity: 2, fields: THREE_FIELDS, identityLimit: 2 }),
  tpl(3, "Extraordinarily-long-template-name-without-any-spaces-at-a", false, []),
];
// The create page's picker: the default has two breaks, the other three.
const PICKER_TEMPLATES = [
  tpl(1, "Weekend scent trial", true, [{ start: "12:00", end: "12:30", label: "Lunch" }, { start: "14:00", end: "14:15", label: "" }]),
  tpl(2, "Evening class", false, [{ start: "18:30", end: "18:45", label: "Tea" }, { start: "19:30", end: "19:45", label: "Water" }, { start: "20:15", end: "20:30", label: "Last run" }],
    { start: "18:00", end: "21:00", costPence: 800 }),
];

/** Answers every /api/** call the pages make, so no Worker or database is needed. `stub` says what the current state needs. */
async function stubApi(page, stub) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(/\/api\//, (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === `/api/events/${SLUG}`) return json(route, { event: stub.public.event, slots: stub.public.slots, bookings: { open: true, closesAt: EVENT.startUtc }, privacyNotice: PRIVACY });
    if (pathname === `/api/events/${SLUG}/bookings` && method === "POST") {
      const lane = stub.public.event.lanes[0];
      return json(route, { booking: { slot: { start: SLOT_STARTS[1], end: PUBLIC_END(SLOT_STARTS[1]) }, lane, fields: [{ label: "Dog", value: "Bartholomew-Maximilian" }, { label: "Handler", value: "Alexandria Featherstonehaugh" }] }, event: stub.public.event, icsUrl: `/api/events/${SLUG}/bookings/tok0123456789abcdef01/ics` }, 201);
    }
    if (pathname === "/api/admin/session" && stub.public) return json(route, { error: { code: "unauthorized", message: "Sign in" } }, 401);
    if (pathname === "/api/admin/session") return json(route, { identity: "admin", provider: "password", csrfToken: "test-token" });
    if (pathname === "/api/settings") return json(route, { clubName: "Test club", website: null, privacyContact: null, logo: null });
    if (pathname === "/api/admin/settings") return json(route, ADMIN_SETTINGS);
    if (pathname === "/api/theme.css") return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (pathname.startsWith("/api/icon/")) return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    if (pathname.startsWith("/api/manifest")) return json(route, {});
    if (pathname === "/api/admin/events") return json(route, { events: LIST_EVENTS, past: [], archived: [], pastHasMore: false, archivedHasMore: false, defaultShareMessage: "" });
    if (pathname === "/api/admin/templates") {
      if (method === "POST") return json(route, { template: stub.templates[0] }, 201);
      return json(route, { templates: stub.templates });
    }
    const one = /^\/api\/admin\/templates\/(\d+)$/.exec(pathname);
    if (one) {
      const found = stub.templates.find((t) => String(t.id) === one[1]);
      if (!found) return json(route, { error: { code: "not_found", message: "No such template" } }, 404);
      return method === "DELETE" ? json(route, { deleted: { id: found.id, name: found.name } }) : json(route, { template: found });
    }
    if (pathname === `/api/admin/events/${SLUG}`) {
      if (method === "PUT" && stub.putAnswer) return json(route, stub.putAnswer.body, stub.putAnswer.status);
      if (method === "PUT" && stub.putFields) return json(route, { error: { code: "invalid_input", message: "Check the highlighted fields." }, fields: stub.putFields }, 400);
      return json(route, { event: stub.event ?? EVENT, slots: stub.slots, orphans: [], lineup: "", defaultShareMessage: "" });
    }
    if (pathname.endsWith("/preview")) return json(route, { slots: SLOTS, suggestions: [], affected: stub.affected ?? [], ...(stub.placeCount ? { placeCount: stub.placeCount } : {}) });
    return json(route, { error: { code: "not_stubbed", message: pathname } }, 404);
  });
}

const DATE_TIME = 'input[type="date"], input[type="time"]';

/** One entry per date or time input (its rect and those of the field, row, group and card around it), plus the page-wide and nav facts. */
const measure = ({ formSelector, dateTime }) => {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const form = formSelector ? document.querySelector(formSelector) : null;
  const card = form ? box(form) : null;
  const inputs = [...document.querySelectorAll(dateTime)].map((input) => {
    const row = input.closest(".field-row");
    const group = input.closest("fieldset");
    return {
      id: input.id,
      rect: box(input),
      field: box(input.closest(".field")),
      row: row ? box(row) : null,
      group: group ? box(group) : null,
      card,
      pair: row ? [...row.querySelectorAll(dateTime)].map((i) => i.id) : [],
    };
  });

  // Elements past the right edge of the screen. Skipped: the visually-hidden class, and anything that scrolls on its own
  // (overflow auto or scroll) or sits inside something that does.
  const scrolls = new Map();
  const scrollsSideways = (el) => {
    if (!scrolls.has(el)) {
      const x = getComputedStyle(el).overflowX;
      scrolls.set(el, x === "auto" || x === "scroll");
    }
    return scrolls.get(el);
  };
  const overflowing = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest(".visually-hidden")) continue;
    let skip = false;
    for (let e = el; e && e !== document.body; e = e.parentElement) if (scrollsSideways(e)) { skip = true; break; }
    if (skip) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > window.innerWidth + 0.5) {
      overflowing.push({ what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}`, right: r.right });
    }
  }

  const nav = document.querySelector(".admin-nav");
  const header = document.querySelector("header.site-header");
  return {
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    inputs,
    overflowing,
    nav: nav && {
      rect: box(nav), scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth,
      links: [...nav.querySelectorAll("a")].map((a) => {
        const style = getComputedStyle(a);
        const rect = box(a);
        return { href: a.getAttribute("href"), rect, visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 };
      }),
      header: header && { rect: box(header), before: Boolean(header.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING) },
    },
  };
};

/**
 * For each paired row (.field-row with two or more .field cells) and each cell in turn: shows a wrapping error under that
 * cell only, reads the label and input tops of every cell, then clears it. One entry per (row, cell with the error).
 */
const measurePairs = () => {
  const message = "Enter a time before the end time.";
  const out = [];
  [...document.querySelectorAll(".field-row")].forEach((row, rowIndex) => {
    const cells = [...row.children].filter((c) => c.classList.contains("field"));
    if (cells.length < 2) return;
    const name = `row ${rowIndex + 1} (${cells.map((c) => c.querySelector("input")?.id ?? "?").join(" / ")})`;
    cells.forEach((withError, n) => {
      const error = withError.querySelector(".field-error");
      error.textContent = message;
      out.push({
        name, errorIn: withError.querySelector("input")?.id,
        // Under 360px the cells stack, so there is nothing to level.
        sideBySide: cells.every((c) => c.getBoundingClientRect().top === cells[0].getBoundingClientRect().top),
        cells: cells.map((c) => ({
          id: c.querySelector("input")?.id,
          labelTop: c.querySelector("label").getBoundingClientRect().top,
          inputTop: c.querySelector("input").getBoundingClientRect().top,
        })),
      });
      error.textContent = "";
    });
  });
  return out;
};

/** Failures where an error under one cell moved the label or the input of another cell out of line with it. */
function checkPairs(label, pairs) {
  const failures = [];
  const round = (n) => Math.round(n * 10) / 10;
  for (const p of pairs) {
    if (!p.sideBySide) continue;
    for (const part of ["labelTop", "inputTop"]) {
      const tops = p.cells.map((c) => c[part]);
      if (Math.max(...tops) - Math.min(...tops) > 1) {
        failures.push(`${label}: ${p.name}: with an error under #${p.errorIn}, the ${part === "labelTop" ? "label" : "input"} tops differ (${p.cells.map((c) => `#${c.id} ${round(c[part])}`).join(", ")})`);
      }
    }
  }
  return failures;
}

// Sideways always; top and bottom too for a container that grows to hold what is in it (a card, a row, a panel), so a control that sticks out
// of the bottom of its card is caught as well. Not for the date and time inputs' field/row/group checks, which only ever mattered sideways.
const inside = (inner, outer, vertical = false) =>
  inner.left >= outer.left - TOLERANCE && inner.right <= outer.right + TOLERANCE
  && (!vertical || (inner.top >= outer.top - TOLERANCE && inner.bottom <= outer.bottom + TOLERANCE));
const overlap = (a, b) =>
  a.left < b.right - TOLERANCE && b.left < a.right - TOLERANCE && a.top < b.bottom - TOLERANCE && b.top < a.bottom - TOLERANCE;
const NAV_HREFS = ["/admin/", "/admin/templates", "/admin/settings"];

/** The failures for one loaded page, as readable lines in two lists: `inputs` (the date and time inputs, the page's width) and `nav` (the admin navigation). */
function check(label, m, { ids: expectedIds = [], breakInputs }) {
  const failures = [];
  const navFailures = [];
  const done = () => ({ inputs: failures, nav: navFailures });
  const ids = m.inputs.map((i) => i.id);
  for (const id of expectedIds) if (!ids.includes(id)) failures.push(`${label}: expected input #${id} is not on the page`);
  if (breakInputs !== undefined) {
    const found = ids.filter((id) => /^(tpl-)?break-/.test(id)).length;
    if (found !== breakInputs) failures.push(`${label}: expected ${breakInputs} break time inputs, found ${found}`);
  }
  const round = (n) => Math.round(n * 10) / 10;
  const span = (r) => `${round(r.left)}..${round(r.right)}`;
  for (const i of m.inputs) {
    if (!inside(i.rect, i.field)) failures.push(`${label}: #${i.id} (${span(i.rect)}) leaves its field (${span(i.field)})`);
    if (i.row && !inside(i.rect, i.row)) failures.push(`${label}: #${i.id} (${span(i.rect)}) leaves its row (${span(i.row)})`);
    if (i.group && !inside(i.rect, i.group)) failures.push(`${label}: #${i.id} (${span(i.rect)}) leaves its group (${span(i.group)})`);
    if (i.card && !inside(i.rect, i.card)) failures.push(`${label}: #${i.id} (${span(i.rect)}) leaves the form card (${span(i.card)})`);
    for (const otherId of i.pair) {
      const other = m.inputs.find((o) => o.id === otherId);
      if (otherId > i.id && overlap(i.rect, other.rect)) failures.push(`${label}: #${i.id} and #${otherId} overlap`);
    }
  }
  if (m.scrollWidth > m.innerWidth) failures.push(`${label}: the page scrolls sideways (scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth})`);
  for (const o of m.overflowing.slice(0, 5)) failures.push(`${label}: ${o.what} ends at ${round(o.right)}, past the screen edge (${m.innerWidth})`);
  if (m.overflowing.length > 5) failures.push(`${label}: ... and ${m.overflowing.length - 5} more elements past the screen edge`);

  const nav = m.nav;
  if (!nav) {
    navFailures.push(`${label}: no .admin-nav on the page`);
    return done();
  }
  for (const href of NAV_HREFS) if (!nav.links.some((l) => l.href === href)) navFailures.push(`${label}: the admin nav has no link to ${href}`);
  for (const l of nav.links) {
    if (!l.visible) navFailures.push(`${label}: nav link ${l.href} is not visible`);
    if (l.rect.height < 48 - TOLERANCE || l.rect.width < 48 - TOLERANCE) navFailures.push(`${label}: nav link ${l.href} is ${round(l.rect.width)}x${round(l.rect.height)}, under 48x48`);
    if (l.rect.left < -TOLERANCE || l.rect.right > m.innerWidth + TOLERANCE) navFailures.push(`${label}: nav link ${l.href} (${span(l.rect)}) is outside the screen (0..${m.innerWidth})`);
  }
  if (nav.links.some((l) => Math.abs(l.rect.top - nav.links[0].rect.top) > 1)) navFailures.push(`${label}: the nav links wrap onto more than one row`);
  for (const [a, b] of nav.links.flatMap((a, n) => nav.links.slice(n + 1).map((b) => [a, b]))) {
    if (overlap(a.rect, b.rect)) navFailures.push(`${label}: nav links ${a.href} and ${b.href} overlap`);
  }
  if (nav.scrollWidth > nav.clientWidth + TOLERANCE || nav.rect.right > m.innerWidth + TOLERANCE) {
    navFailures.push(`${label}: the nav scrolls or runs past the screen (scrollWidth ${nav.scrollWidth}, clientWidth ${nav.clientWidth}, right ${round(nav.rect.right)})`);
  }
  if (!nav.header) navFailures.push(`${label}: no header band (header.site-header) on the page`);
  else {
    if (!nav.header.before) navFailures.push(`${label}: the header band is not before the nav in the page order`);
    if (nav.header.rect.bottom > nav.rect.top + TOLERANCE) navFailures.push(`${label}: the header band (bottom ${round(nav.header.rect.bottom)}) is not above the nav (top ${round(nav.rect.top)})`);
  }
  return done();
}

/**
 * What the lane states add: every visible control matching `targets` (its size), and for each [inner, outer] pair every inner
 * element with its rect and that of the outer element that holds it.
 */
const measureLayout = ({ targets, inside }) => {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("aria-label") ? ` "${el.getAttribute("aria-label")}"` : el.textContent && el.tagName === "BUTTON" ? ` "${el.textContent.trim()}"` : ""}`;
  const controls = targets ? [...document.querySelectorAll(targets)].map((el) => ({ what: name(el), rect: box(el) })).filter((c) => c.rect.width > 0 && c.rect.height > 0) : [];
  const held = inside.flatMap(([innerSelector, outerSelector]) => [...document.querySelectorAll(innerSelector)].flatMap((el) => {
    const outer = el.closest(outerSelector);
    const rect = box(el);
    return outer && rect.width > 0 ? [{ what: name(el), innerSelector, outerSelector, rect, outer: box(outer) }] : [];
  }));
  return { controls, held };
};

/** The failures of measureLayout: controls under 48px either way, and elements that leave the card, row or group that holds them. */
function checkLayout(label, m, o) {
  const failures = [];
  const round = (n) => Math.round(n * 10) / 10;
  if (o.targets && m.controls.length === 0) failures.push(`${label}: no controls matched ${o.targets}`);
  for (const c of m.controls) {
    if (c.rect.height < 48 - TOLERANCE || c.rect.width < 48 - TOLERANCE) failures.push(`${label}: ${c.what} is ${round(c.rect.width)}x${round(c.rect.height)}, under 48x48`);
  }
  for (const [innerSelector] of o.inside ?? []) {
    if (!m.held.some((x) => x.innerSelector === innerSelector)) failures.push(`${label}: nothing matched ${innerSelector}`);
  }
  for (const x of m.held) {
    if (!inside(x.rect, x.outer, true)) failures.push(`${label}: ${x.what} (${round(x.rect.left)}..${round(x.rect.right)}, ${round(x.rect.top)}..${round(x.rect.bottom)}) leaves its ${x.outerSelector} (${round(x.outer.left)}..${round(x.outer.right)}, ${round(x.outer.top)}..${round(x.outer.bottom)})`);
  }
  return failures;
}

/** The public booking page's facts: sideways scroll, anything past the right edge, and every time and lane button. */
// `width` is the screen width asked for: on an emulated phone the layout viewport grows to fit overflowing content, so window.innerWidth can't be trusted.
const measurePublic = (width) => {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const overflowing = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > width + 0.5) overflowing.push({ what: `${el.tagName.toLowerCase()}${typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}`, right: r.right });
  }
  const buttons = [...document.querySelectorAll("button.slot")].map((b) => ({
    text: b.textContent, lane: b.classList.contains("lane"), rect: box(b), scrollWidth: b.scrollWidth, clientWidth: b.clientWidth,
    scrollHeight: b.scrollHeight, clientHeight: b.clientHeight, card: b.closest(".slot-group") ? box(b.closest(".slot-group")) : null,
    group: [...document.querySelectorAll(".slot-group")].indexOf(b.closest(".slot-group")),
  }));
  return { scrollWidth: document.documentElement.scrollWidth, innerWidth: width, overflowing, buttons, groups: document.querySelectorAll(".slot-group").length };
};

/** The failures for one state of the public booking page. `o.oneRow`: the lane buttons of a card must share a row. */
function checkPublic(label, m, o) {
  const failures = [];
  const round = (n) => Math.round(n * 10) / 10;
  if (m.scrollWidth > m.innerWidth) failures.push(`${label}: the page scrolls sideways (scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth})`);
  for (const x of m.overflowing.slice(0, 5)) failures.push(`${label}: ${x.what} ends at ${round(x.right)}, past the screen edge (${m.innerWidth})`);
  if (m.overflowing.length > 5) failures.push(`${label}: ... and ${m.overflowing.length - 5} more elements past the screen edge`);
  if (o.lanes !== undefined && m.buttons.filter((b) => b.lane).length !== o.lanes) failures.push(`${label}: expected ${o.lanes} lane buttons, found ${m.buttons.filter((b) => b.lane).length}`);
  for (const b of m.buttons) {
    const name = `${b.lane ? "lane" : "time"} button "${b.text}"`;
    if (b.rect.height < 48 - TOLERANCE) failures.push(`${label}: ${name} is ${round(b.rect.height)}px tall, under 48`);
    if (b.scrollWidth > b.clientWidth + TOLERANCE || b.scrollHeight > b.clientHeight + TOLERANCE) failures.push(`${label}: ${name} clips its text (scroll ${b.scrollWidth}x${b.scrollHeight}, client ${b.clientWidth}x${b.clientHeight})`);
    if (b.card && !inside(b.rect, b.card, true)) failures.push(`${label}: ${name} leaves its card`);
  }
  const lanes = m.buttons.filter((b) => b.lane);
  for (const [a, b] of lanes.flatMap((a, n) => lanes.slice(n + 1).map((b) => [a, b]))) {
    if (overlap(a.rect, b.rect)) failures.push(`${label}: lane buttons "${a.text}" and "${b.text}" overlap`);
  }
  if (o.oneRow) {
    for (let g = 0; g < m.groups; g++) {
      const row = lanes.filter((b) => b.group === g);
      if (row.length > 1 && row.some((b) => Math.abs(b.rect.top - row[0].rect.top) > 1)) failures.push(`${label}: the lane buttons of card ${g + 1} are not on one row`);
    }
  }
  return failures;
}

async function main() {
  let browser;
  try {
    browser = await engines[engineName].launch();
  } catch (e) {
    const reason = String(e.message).split("\n").find((l) => l.trim()) ?? "unknown error";
    console.log(`SKIPPED: ${engineName} cannot launch here: ${reason}`);
    process.exit(engineName === "webkit" && flag("allow-skip") ? 0 : 2);
  }

  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { defaultBrowserType, ...phone } = devices["iPhone 13"];
  const schemes = ["light", "dark"];
  if (flag("shots")) mkdirSync(shotsDir, { recursive: true });
  // The failures by what they are about. A check that cannot fail proves nothing, so --break-css counts them per category.
  const CATEGORIES = ["date and time inputs", "admin navigation", "paired rows", "admin lanes and booking-form card", "public booking page"];
  const tally = new Map(CATEGORIES.map((c) => [c, { checks: 0, failures: [] }]));
  const record = (category, lines) => { const t = tally.get(category); t.checks++; t.failures.push(...lines); };
  let checked = 0;
  let loads = 0;
  let pairedChecked = 0;
  let publicChecked = 0;
  let laneChecked = 0;
  try {
    for (const width of WIDTHS) {
      for (const scheme of schemes) {
        const context = await browser.newContext({ ...phone, viewport: { width, height: 844 }, colorScheme: scheme });
        const page = await context.newPage();
        const stub = { templates: [], slots: [], public: null, event: null, affected: [], placeCount: 0, putFields: null, putAnswer: null };
        await stubApi(page, stub);

        /** Checks the page as it is now; `o.shot` names its screenshot. */
        const verify = async (label, o) => {
          if (flag("break-css")) {
            await page.addStyleTag({ content: 'input[type="date"], input[type="time"] { min-width: 300px !important; } .admin-nav a { min-height: 20px !important; height: 20px !important; padding-block: 0 !important; }' });
          }
          const m = await page.evaluate(measure, { formSelector: o.form ?? null, dateTime: DATE_TIME });
          const found = check(`${label} @${width}px ${scheme}`, m, o);
          record("date and time inputs", found.inputs);
          record("admin navigation", found.nav);
          checked++;
          // Before the paired-row check, which writes (and clears) errors in the cells to see whether the rows stay level.
          if (flag("shots") && o.shot) await page.screenshot({ path: join(shotsDir, `${o.shot}-${width}-${scheme}.png`), fullPage: true });
          if (o.form) {
            if (flag("break-css")) {
              // An error that shows ABOVE its input pushes that cell down and out of line with the other (what the rows' shared grid prevents).
              await page.addStyleTag({ content: ".field-row { align-items: start !important; } .field-row > .field { display: flex !important; flex-direction: column !important; grid-row: auto !important; grid-template-rows: none !important; } .field-row > .field > .field-error { order: -1 !important; }" });
            }
            const pairs = await page.evaluate(measurePairs);
            record("paired rows", [
              ...(pairs.length === 0 ? [`${label} @${width}px ${scheme}: no paired rows found to test with an error`] : []),
              ...checkPairs(`${label} @${width}px ${scheme}`, pairs),
            ]);
            pairedChecked += pairs.filter((p) => p.sideBySide).length;
          }
          if (o.targets || o.inside) {
            if (flag("break-css")) {
              await page.addStyleTag({ content: ".sched-actions .button, .lane-row .button, .lane-row input, #capacity, #tpl-capacity, .field-def .button, .field-def input, .field-def .select-all, .fields-group > .button, #event-identity-limit, #tpl-identity-limit, .sched-panel input, .sched-panel select, .sched-panel button { min-height: 20px !important; height: 20px !important; }" });
            }
            const lm = await page.evaluate(measureLayout, { targets: o.targets ?? "", inside: o.inside ?? [] });
            record("admin lanes and booking-form card", checkLayout(`${label} @${width}px ${scheme}`, lm, o));
            laneChecked++;
          }
        };
        /**
         * Loads `path` (with the API stubbed as `o.templates` / `o.slots` say), waits for `o.ready`, runs `o.prepare`, then
         * checks. `o.then` are further steps on the same page: { label, act, ...expectations }.
         */
        const run = async (label, path, o) => {
          stub.templates = o.templates ?? [];
          stub.slots = o.slots ?? [];
          stub.event = o.event ?? null;
          stub.affected = o.affected ?? [];
          stub.placeCount = o.placeCount ?? 0;
          stub.putFields = o.putFields ?? null;
          stub.putAnswer = o.putAnswer ?? null;
          await page.goto(`${origin}${path}`);
          await page.waitForSelector(".site-header");
          await page.waitForSelector(o.ready);
          loads++;
          if (o.prepare) await o.prepare();
          await verify(label, o);
          for (const step of o.then ?? []) {
            await step.act();
            await verify(`${label} > ${step.label}`, { form: o.form, targets: o.targets, inside: o.inside, ...step });
          }
        };

        const breakIds = (n, prefix = "break") => Array.from({ length: n }, (_, i) => [`${prefix}-${i + 1}-start`, `${prefix}-${i + 1}-end`]).flat();
        const plain = ["date", "start", "end"];
        const form = "#event-form";
        await run("index", "/admin/", { ready: ".event-card" });
        await run("new", "/admin/new", { ready: "#event-form", form, ids: plain });
        await run("new + 2 breaks", "/admin/new", {
          ready: "#event-form", form, ids: [...plain, ...breakIds(2)],
          prepare: async () => {
            await page.click("text=Add break");
            await page.click("text=Add break");
          },
        });
        await run("new + templates", "/admin/new", {
          ready: "#template", form, templates: PICKER_TEMPLATES, shot: "new-template",
          prepare: async () => { await page.waitForSelector("#break-2-end"); },
          ids: [...plain, ...breakIds(2)], breakInputs: 4,
          then: [{
            label: "switched to the other template",
            act: async () => {
              await page.selectOption("#template", String(PICKER_TEMPLATES[1].id));
              await page.waitForFunction(() => document.querySelectorAll('input[id^="break-"][type="time"]').length === 6);
            },
            ids: plain, breakInputs: 6, shot: "new-template-switched",
          }],
        });
        await run("edit", `/admin/edit?slug=${SLUG}`, { ready: "#break-2-end", form, ids: [...plain, ...breakIds(2)] });
        await run("schedule", `/admin/schedule?slug=${SLUG}`, { ready: ".sched", slots: SCHEDULE_SLOTS, shot: "schedule" });
        await run("settings", "/admin/settings", { ready: "#theme" });
        const tform = "#template-form";
        const tplIds = ["tpl-start", "tpl-end"];
        await run("templates list", "/admin/templates", { ready: ".event-card", templates: LIST_TEMPLATES, shot: "templates-list" });
        await run("templates create", "/admin/templates", {
          ready: ".event-card", templates: LIST_TEMPLATES, form: tform, ids: [...tplIds, ...breakIds(2, "tpl-break")], breakInputs: 4,
          shot: "template-create",
          prepare: async () => {
            await page.click("text=New template");
            await page.waitForSelector(tform);
            await page.click("text=Add break");
            await page.click("text=Add break");
          },
        });
        await run("templates edit", "/admin/templates", {
          ready: ".event-card", templates: LIST_TEMPLATES, form: tform, ids: [...tplIds, ...breakIds(2, "tpl-break")], breakInputs: 4,
          shot: "template-edit",
          prepare: async () => {
            await page.click(`[aria-label="Edit ${LIST_TEMPLATES[1].name}"]`);
            await page.waitForSelector("#tpl-break-2-end");
          },
        });

        // The lane states (admin side): every control at least 48px, and every row, lane row and field inside its card.
        const SCHED_CONTROLS = ".sched-actions button";
        const SCHED_INSIDE = [[".sched-place", ".sched-group"], [".sched-actions button", ".sched-place"]];
        const PANEL_INSIDE = [...SCHED_INSIDE, [".sched-panel", ".sched-place"]];
        await run("schedule, three lanes of two places", `/admin/schedule?slug=${SLUG}`, {
          ready: ".sched-group", slots: LANE_SLOTS, event: LANED_EVENT, shot: "schedule-lanes", targets: SCHED_CONTROLS, inside: SCHED_INSIDE,
          then: [
            {
              label: "Move panel open", shot: "schedule-lanes-move",
              targets: `${SCHED_CONTROLS}, .sched-panel button, .sched-panel select`, inside: [...PANEL_INSIDE, [".sched-panel select", ".sched-panel"]],
              act: async () => {
                await page.click('button[aria-label="Move Bartholomew-Maximilian at 10:20 · Ring 1"]');
                await page.waitForSelector("#pick-move");
              },
            },
            {
              label: "Add panel open", shot: "schedule-lanes-add",
              targets: `${SCHED_CONTROLS}, .sched-panel button, .sched-panel input`, inside: [...PANEL_INSIDE, [".sched-panel input", ".sched-panel"]],
              act: async () => {
                await page.click(".sched-panel button:has-text('Cancel')");
                await page.click('button[aria-label="Add booking at 10:20 · Indoor hall, far end"]');
                await page.waitForSelector("#add-field-1");
              },
            },
          ],
        });
        const LANE_CONTROLS = ".lane-row button, .lane-row input, .lanes-group > button, #capacity";
        const LANE_INSIDE = [[".lane-row", ".lanes-group"], [".lane-row input", ".lane-row"], [".lane-row button", ".lane-row"], ["#capacity", ".lanes-group"], [".lanes-group", "#event-form"]];
        await run("edit, Lanes card with three lanes", `/admin/edit?slug=${SLUG}`, {
          ready: "#lane-3-name", form, event: LANED_EVENT, placeCount: 6, ids: [...plain, ...breakIds(2)], shot: "edit-lanes",
          targets: LANE_CONTROLS, inside: LANE_INSIDE,
          then: [{
            label: "errors under a lane and the places", shot: "edit-lanes-errors",
            act: async () => {
              stub.putFields = {
                "lanes.2.name": "Two lanes can't have the same name. Give this lane a different name from the others.",
                capacity: "Enter a whole number of places from 1 to 50.",
              };
              await page.fill("#lane-3-name", "Ring 1");
              await page.click("button:has-text('Save changes')");
              await page.waitForSelector("#lane-3-name-error:not(:empty)");
            },
          }],
        });
        await run("edit, a lane removed with bookings in it", `/admin/edit?slug=${SLUG}`, {
          ready: "#lane-3-name", form, event: LANED_EVENT, placeCount: 4, affected: STRANDED, ids: [...plain, ...breakIds(2)], shot: "edit-lanes-affected",
          targets: LANE_CONTROLS, inside: LANE_INSIDE,
          prepare: async () => {
            await page.click('button[aria-label="Remove lane 3"]');
            await page.waitForSelector(".affected li");
          },
        });
        const TPL_CONTROLS = ".lane-row button, .lane-row input, .lanes-group > button, #tpl-capacity";
        const TPL_INSIDE = [[".lane-row", ".lanes-group"], [".lane-row input", ".lane-row"], [".lane-row button", ".lane-row"], ["#tpl-capacity", ".lanes-group"]];
        await run("templates create, three lanes", "/admin/templates", {
          ready: ".event-card", templates: LIST_TEMPLATES, form: tform, ids: [...tplIds, ...breakIds(0, "tpl-break")], shot: "template-create-lanes",
          targets: TPL_CONTROLS, inside: TPL_INSIDE,
          prepare: async () => {
            await page.click("text=New template");
            await page.waitForSelector(tform);
            await page.click("text=Add lane");
            await page.click("text=Add lane");
            await page.fill("#tpl-lane-1-name", "Ring 1");
            await page.fill("#tpl-lane-2-name", "Ring 2");
            await page.fill("#tpl-lane-3-name", "Indoor hall, far end");
            await page.fill("#tpl-capacity", "2");
          },
        });
        await run("templates edit, a template with lanes", "/admin/templates", {
          ready: ".event-card", templates: LIST_TEMPLATES, form: tform, ids: [...tplIds, ...breakIds(2, "tpl-break")], breakInputs: 4, shot: "template-edit-lanes",
          targets: TPL_CONTROLS, inside: TPL_INSIDE,
          prepare: async () => {
            await page.click(`[aria-label="Edit ${LIST_TEMPLATES[1].name}"]`);
            await page.waitForSelector("#tpl-lane-3-name");
          },
        });

        // The booking form's card (fields, Required, Max length, Identifies a booking, the identity limit): create, edit (with errors, and locked) and the template form.
        const LIMIT_EVENT = "#event-identity-limit";
        const LIMIT_TPL = "#tpl-identity-limit";
        await run("new, Booking form with four fields", "/admin/new", {
          ready: "#event-form", form, ids: plain, shot: "new-booking-form", targets: cardControls(LIMIT_EVENT), inside: cardInside(LIMIT_EVENT),
          prepare: async () => {
            for (let i = 0; i < 3; i++) await page.click('button:has-text("Add field")');
            for (const [n, f] of FOUR_FIELDS.entries()) await page.fill(`#event-field-${n + 1}-label`, f.label);
            await page.check("#event-field-2-identity");
            await page.fill("#event-field-3-max", "20");
            await page.fill("#event-identity-limit", "2");
          },
        });
        await run("edit, Booking form with four fields", `/admin/edit?slug=${SLUG}`, {
          ready: "#event-field-4-label", form, event: { ...EVENT, fields: FOUR_FIELDS, identityLimit: 2 }, ids: [...plain, ...breakIds(2)], shot: "edit-booking-form",
          targets: cardControls(LIMIT_EVENT), inside: cardInside(LIMIT_EVENT),
          then: [{
            label: "errors under a label, a max length, the limit and the card", shot: "edit-booking-form-errors",
            act: async () => {
              stub.putFields = {
                "fields.1.label": "Two fields can't have the same label. Give this field a different label from the others.",
                "fields.2.maxLength": "Enter a whole number of characters from 1 to 80.", "fields.3.required": "A field that identifies a booking must be required.",
                identityLimit: "Enter a whole number of bookings from 1 to 20.", fields: "At least one field must identify a booking.",
              };
              await page.click('button:has-text("Save changes")');
              await page.waitForSelector("#event-field-2-label-error:not(:empty)");
            },
          }],
        });
        // Bookings arrived while the admin was editing: the save is refused and the card goes back to the form as it was loaded, saying so.
        await run("edit, Booking form after a fields_locked answer", `/admin/edit?slug=${SLUG}`, {
          ready: "#event-field-3-label", form, event: { ...EVENT, fields: THREE_FIELDS, identityLimit: 2 }, ids: [...plain, ...breakIds(2)],
          putAnswer: { status: 409, body: { error: { code: "fields_locked", message: "This event has bookings, so fields can't be added or removed and the fields that identify a booking can't be changed. You can still change labels, which fields are required, how long each can be and how many bookings one identity may hold." } } },
          targets: cardControls(LIMIT_EVENT), inside: cardInside(LIMIT_EVENT),
          then: [{
            label: "reset to the loaded form", shot: "edit-booking-form-reset",
            act: async () => {
              await page.click('button:has-text("Add field")');
              await page.fill("#event-field-4-label", "Owner");
              await page.fill("#event-field-1-label", "Hound");
              await page.click('button:has-text("Save changes")');
              await page.waitForSelector("#event-fields-error:not(:empty)");
            },
          }],
        });
        await run("edit, Booking form locked (the event has bookings)", `/admin/edit?slug=${SLUG}`, {
          ready: "#event-fields-locked:not([hidden])", form, event: { ...EVENT, fields: THREE_FIELDS, identityLimit: 2, hasBookings: true }, ids: [...plain, ...breakIds(2)],
          shot: "edit-booking-form-locked", targets: cardControls(LIMIT_EVENT), inside: cardInside(LIMIT_EVENT),
        });
        await run("templates create, Booking form with a second field", "/admin/templates", {
          ready: ".event-card", templates: LIST_TEMPLATES, form: tform, ids: tplIds, shot: "template-create-booking-form",
          targets: cardControls(LIMIT_TPL), inside: cardInside(LIMIT_TPL),
          prepare: async () => {
            await page.click("text=New template");
            await page.waitForSelector(tform);
            await page.click('button:has-text("Add field")');
            await page.fill("#tpl-field-2-label", FOUR_FIELDS[1].label);
            await page.check("#tpl-field-2-identity");
          },
        });
        await run("templates edit, a template with three fields", "/admin/templates", {
          ready: ".event-card", templates: LIST_TEMPLATES, form: tform, ids: [...tplIds, ...breakIds(2, "tpl-break")], breakInputs: 4, shot: "template-edit-booking-form",
          targets: cardControls(LIMIT_TPL), inside: cardInside(LIMIT_TPL),
          prepare: async () => {
            await page.click(`[aria-label="Edit ${LIST_TEMPLATES[1].name}"]`);
            await page.waitForSelector("#tpl-field-3-label");
          },
        });
        await run("schedule, Add panel with three fields", `/admin/schedule?slug=${SLUG}`, {
          ready: ".sched", slots: SCHEDULE_SLOTS, event: { ...EVENT, fields: THREE_FIELDS }, shot: "schedule-add-panel",
          targets: ".sched-actions button, .sched-panel button, .sched-panel input",
          inside: [[".sched-panel", ".sched-row"], [".sched-panel input", ".sched-panel"], [".sched-panel button", ".sched-panel"]],
          prepare: async () => {
            await page.click('button[aria-label="Add booking at 10:00"]');
            await page.waitForSelector("#add-field-3");
          },
        });

        /** Loads the public booking page with `state` stubbed, runs `o.act`, then checks it and takes `o.shot`. */
        const runPublic = async (label, state, o) => {
          stub.public = PUBLIC_STATES[state];
          await page.goto(`${origin}/e/${SLUG}`);
          await page.waitForSelector(o.ready ?? ".slot-grid button");
          loads++;
          if (o.act) await o.act();
          await page.waitForTimeout(300); // the buttons' colour transition (0.15s), so a shot shows the settled state
          if (flag("break-css")) {
            await page.addStyleTag({ content: ".lane-grid { grid-template-columns: repeat(3, 160px) !important; } .slot, .slot.lane, .slot.has-note { min-height: 20px !important; height: 20px !important; padding: 0 !important; line-height: 1 !important; }" });
          }
          const m = await page.evaluate(measurePublic, width);
          record("public booking page", checkPublic(`booking ${label} @${width}px ${scheme}`, m, { ...o, oneRow: o.oneRow && width >= 390 }));
          checked++;
          publicChecked++;
          if (flag("shots")) await page.screenshot({ path: join(shotsDir, `booking-${o.shot}-${width}-${scheme}.png`), fullPage: true });
        };
        const choose = (time, lane) => async () => {
          await page.click(lane ? `.slot-group [role=group][aria-label="${time}"] button:has-text("${lane}")` : `.slot-grid button:has-text("${time}")`);
          await page.waitForSelector("#booking-form:not([hidden])");
        };
        await runPublic("single lane, one place (v1.0)", "single", { shot: "single", lanes: 0 });
        await runPublic("single lane, two places", "singleTwoPlaces", { shot: "single-two-places", lanes: 0 });
        await runPublic("four fields, two optional, long labels", "fourFields", { shot: "four-fields", act: choose("09:20"), lanes: 0 });
        await runPublic("one named lane", "singleNamed", { shot: "single-named", act: choose("09:20"), lanes: 0 });
        await runPublic("three lanes, two places", "lanes", { shot: "lanes", lanes: 9, oneRow: true });
        await runPublic("three lanes, long names", "longLanes", { shot: "lanes-long", lanes: 6 });
        await runPublic("three lanes, a lane chosen", "lanes", { shot: "lanes-selected", lanes: 9, oneRow: true, act: choose("09:20", "Ring 3") });
        await runPublic("three lanes, confirmation", "lanes", {
          shot: "lanes-confirmed", lanes: 0, ready: ".slot-grid button",
          act: async () => {
            await choose("09:20", "Ring 1")();
            await page.fill("#field-1", "Bartholomew-Maximilian");
            await page.fill("#field-2", "Alexandria Featherstonehaugh");
            await page.click("#booking-form button[type=submit]");
            await page.waitForSelector(".confirmation");
          },
        });
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failures = [...tally.values()].flatMap((t) => t.failures);
  const counts = [...tally].map(([name, t]) => `${name}: ${t.failures.length} failure(s) in ${t.checks} check(s)`);
  if (flag("break-css")) {
    // The self-test: every category must catch what was broken for it, or the run says nothing about that category.
    const blind = [...tally].filter(([, t]) => t.checks > 0 && t.failures.length === 0).map(([name]) => name);
    console.log(`Per category with the CSS broken (${engineName}):`);
    for (const line of counts) console.log(`  ${line}`);
    if (blind.length > 0) {
      console.log(`SELF-TEST FAILED (${engineName}): nothing was caught in: ${blind.join(", ")}. Those checks cannot fail yet.`);
      process.exit(0);
    }
    console.log(`FAIL (${engineName}), as the self-test needs: every category caught the broken CSS (${failures.length} problem(s) in all).`);
    process.exit(1);
  }
  if (failures.length > 0) {
    console.log(`FAIL (${engineName}): ${failures.length} problem(s)`);
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log(`PASS (${engineName}): ${loads} page loads (${checked} checks) at ${WIDTHS.join(" and ")}px in light and dark, every date and time input fits its field, row and card, no overlaps, nothing past the screen edge, no sideways scroll; an error under one cell of a paired row leaves the other cell level (${pairedChecked} cases); the admin nav is whole and under the header band; the admin lane states (${laneChecked} checks): every control at least 48px, rows and fields inside their card; the public booking page in ${publicChecked / (WIDTHS.length * schemes.length)} states: no sideways scroll, time and lane buttons at least 48px tall with their text whole, lane buttons inside their card and apart, three on one row at 390px${flag("shots") ? `; screenshots in ${shotsDir}` : ""}`);
}

await main();

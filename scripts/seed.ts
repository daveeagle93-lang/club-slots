// Creates one test event. Each run adds a new event; nothing is wiped.
//
//   npm run seed                            LOCAL D1 (the state `wrangler dev` uses, .wrangler/state):
//                                           applies pending migrations, then event plus 3 sample bookings
//   npm run seed -- --no-bookings           event only
//   SEED_PERSIST_TO=/some/dir npm run seed  use a throwaway local state directory instead
//   npm run seed -- --remote --env preview  the REMOTE PREVIEW D1 only (never production). Migrations are NOT
//                                           applied for you: apply them first (docs/deploying.md). Interactive.
//   npm run seed:local                      same as `npm run seed -- --local`
//
// Plain Node (type stripping), hence the explicit .ts extensions.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityKeyOf } from "../src/core/identity.ts";
import { londonToUtc, utcToLondon } from "../src/core/london.ts";
import { generateSchedule } from "../src/core/schedule.ts";
import { generateBookingToken, generateSlug } from "../src/core/slug.ts";
import { executeArgs, migrateArgs, parseArgs } from "./seed-args.ts";

const PORT = 8787; // wrangler dev default
const root = join(import.meta.dirname, "..");
const parsed = parseArgs(process.argv.slice(2));
if ("error" in parsed) {
  console.error(parsed.error);
  process.exit(2);
}
const { mode, withBookings } = parsed;
const persistTo = process.env.SEED_PERSIST_TO;

/** The first Saturday at least 14 days after today (London date). */
function nextSaturday(): string {
  const [y, m, d] = utcToLondon(new Date().toISOString()).date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1, d + 14));
  target.setUTCDate(target.getUTCDate() + ((6 - target.getUTCDay() + 7) % 7));
  return target.toISOString().slice(0, 10);
}

const q = (s: string): string => `'${s.replaceAll("'", "''")}'`;

const date = nextSaturday();
const at = (time: string) => londonToUtc(date, time);
const slug = generateSlug();
const event = {
  name: "Saturday Trial Day (test)", start: at("09:00"), end: at("16:00"),
  sessionMinutes: 15, gapMinutes: 5, costPence: 1500, postcode: "SW1A 1AA",
  details: "Friendly trial day, all breeds welcome.\nBring water, a mat and your dog's favourite treats.\nIt's a relaxed day, so don't worry about getting it perfect!",
  breaks: [{ start: at("12:00"), end: at("13:00") }, { start: at("14:30"), end: at("14:40") }],
};

const { slots } = generateSchedule({
  start: event.start, end: event.end, sessionMinutes: event.sessionMinutes, gapMinutes: event.gapMinutes, breaks: event.breaks,
});

const sql: string[] = [
  `INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, gap_minutes, cost_pence, venue_postcode, details)
   VALUES (${q(slug)}, ${q(event.name)}, ${q(event.start)}, ${q(event.end)}, ${event.sessionMinutes}, ${event.gapMinutes}, ${event.costPence}, ${q(event.postcode)}, ${q(event.details)});`,
  `INSERT INTO event_layout (event_id) VALUES ((SELECT id FROM events WHERE slug = ${q(slug)}));`,
  `INSERT INTO event_lanes (event_id, position, name) VALUES ((SELECT id FROM events WHERE slug = ${q(slug)}), 1, '');`,
  // The sample is a dog club's trial day: Dog and Handler, both required and both in the identity.
  `INSERT INTO event_fields (event_id, position, label, required, max_length, in_identity) VALUES ((SELECT id FROM events WHERE slug = ${q(slug)}), 1, 'Dog', 1, 80, 1), ((SELECT id FROM events WHERE slug = ${q(slug)}), 2, 'Handler', 1, 80, 1);`,
  ...event.breaks.map((b) =>
    `INSERT INTO breaks (event_id, start_utc, end_utc) VALUES ((SELECT id FROM events WHERE slug = ${q(slug)}), ${q(b.start)}, ${q(b.end)});`),
];
const bookings = [
  { slot: slots[0], dog: "Zoë", handler: "Sam Jones" },
  { slot: slots[1], dog: "Biscuit", handler: "Ann Lee" },
  { slot: slots[5], dog: "Moss", handler: "Pat O'Brien" },
];
if (withBookings) {
  for (const b of bookings) {
    sql.push(
      `INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key, identity_seq, token)
       VALUES ((SELECT id FROM events WHERE slug = ${q(slug)}), (SELECT id FROM event_lanes WHERE event_id = (SELECT id FROM events WHERE slug = ${q(slug)}) AND position = 1), ${q(b.slot.start)}, 1, ${q(b.dog)}, ${q(b.handler)}, ${q(identityKeyOf([b.dog, b.handler]))}, 1, ${q(generateBookingToken())});`);
  }
}

const wrangler = (args: string[], stdio: "quiet" | "interactive"): void => {
  execFileSync("npx", ["wrangler", ...args], {
    cwd: root, stdio: stdio === "interactive" ? "inherit" : ["ignore", "ignore", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
};

if (mode === "local") wrangler(migrateArgs(persistTo), "quiet");
const dir = mkdtempSync(join(tmpdir(), "slot-booker-seed-"));
try {
  const file = join(dir, "seed.sql");
  writeFileSync(file, sql.join("\n") + "\n");
  wrangler(executeArgs(mode, file, persistTo), mode === "local" ? "quiet" : "interactive");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const hhmm = (utc: string): string => utcToLondon(utc).time;
console.log(`Event: ${event.name}, ${date}, ${hhmm(event.start)}-${hhmm(event.end)} London`);
console.log(`Schedule: ${slots.length} slots (${event.sessionMinutes} min + ${event.gapMinutes} min gap; breaks ${event.breaks.map((b) => `${hhmm(b.start)}-${hhmm(b.end)}`).join(", ")})`);
console.log(slots.map((s) => hhmm(s.start)).join(" "));
if (withBookings) console.log(`Bookings: ${bookings.length} sample (slots ${bookings.map((b) => hhmm(b.slot.start)).join(", ")})`);
console.log(`Slug: ${slug}`);
console.log(`Path: /e/${slug}`);
console.log(mode === "local"
  ? `URL:  http://localhost:${PORT}/e/${slug}`
  : "Seeded the remote PREVIEW database. Open the path above on your preview Worker's URL.");

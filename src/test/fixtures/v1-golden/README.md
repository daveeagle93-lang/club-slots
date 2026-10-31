# v1.0 golden outputs

Outputs of the **v1.0 code (commit `7810f8c`, "README: Deploy to Cloudflare button points at the public repository")** for one deterministic dog-club scenario.
They are the oracle for the back-compat test: "an event created on v1.0 behaves and renders identically after the migration".

The replay against the current code is `src/test/golden-v1.test.ts` (it applies `seed.sql` to a database at migration 0014, applies the later migrations (0015 to 0018), and compares every file here). Its `ALLOWED_ADDITIONS` (keys the current code adds), `WORDING` (the few texts that changed on purpose) and adapters (`adaptRequest` for the public and admin booking bodies, `legacyPublic` and `legacyAdmin` for the answers' new shapes, `legacyCall` for the pages' logged requests, `legacyDom` and `legacyAdminDom` for the position-derived attribute names of the booking page and the admin Add panel; all translated back for the labels Dog and Handler only) are the only differences, and each must be used by the replay.

**Never regenerate these files from newer code.** If the new code differs from them, either the new code is wrong or the difference is a deliberate, explicitly allow-listed change in the test; the files stay as v1.0 produced them.

## How they were produced

1. `git worktree add <scratchpad>/v1 7810f8c` (outside the repository), with the repository's `node_modules` symlinked in. The worktree's only difference from `7810f8c` was the new capture file (`git status` showed that file, and the untracked `node_modules` symlink, only).
2. `src/test/golden-capture.test.ts` in that worktree (a copy is `capture.test.ts.txt` here), run with:

   ```
   GOLDEN_OUT=<empty dir> npx vitest run src/test/golden-capture.test.ts
   ```

3. The run was done twice into two directories and `diff -r` of the two was empty.

The script builds a fresh, fully migrated local D1 (migrations 0001 to 0014) with `createTestEnv`, inserts the rows of `seed.sql` by SQL, and then calls the real Worker (`createWorker().fetch`, real guards, routing and handlers) for the JSON and file outputs. The pages are the real `public/booking.js` and `public/admin/schedule.js`, driven in a happy-dom `Window` (created directly, 20.14.5) whose `fetch` is the real Worker; so the DOM is rendered from real server answers. Admin calls sign in with the password provider as the existing tests do.

### The fixture (`seed.sql`)

Apply it on top of migrations 0001 to 0014 (one statement per line; skip lines starting with `--`). Fixed ids, slugs, booking tokens (`tok-bNN-0123456789abcdef`), `created_at` values and idempotency keys (some bookings); no random-id code path is used.

- Club settings: club name "Hillside Agility Club", privacy contact Jo Bennett, website.
- Event 1 `saturday-trial-2026-10-17` "Saturday Trial": Saturday 2026-10-17 (BST) 09:00 to 15:00 London, 30-minute sessions, 5-minute gap, break "Tea" 10:30 to 10:45, cost 1250p, postcode AB1 2CD, multi-line details, empty share message. Nine slots (London 09:00 09:35 10:45 11:20 11:55 12:30 13:05 13:40 14:15); six bookings (ids 1 to 6): "Rex 🐶", "Zoë", "Biscuit" / "Pat O'Brien", "=Max" / "+Dave Kerr" (formula guard), an 80-character dog name, "ZOË" (same dog name as booking 2, other handler). Free slots: 11:20, 12:30, 13:40.
- Event 2 `evening-run-2026-10-20` "Evening Run": 18:00 to 20:00, 20-minute sessions, an unnamed break 19:00 to 19:10; bookings 7, 8, 9 on slots and booking 10 an ORPHAN (16:30 London, not a slot). Used for the orphan section and the edit clash.
- Event 3 `winter-fun-day-2026-12-05` archived (bookings 11, 12). Event 4 `members-ring-time-2026-11-07` unlisted, with its own share message (booking 13). Event 5 `summer-agility-day-2026-09-12` in the past (bookings 14 to 16; one dog name is NFD "Zoe" + U+0301, one handler has a double space).
- Two templates: "Standard trial" (default, with a share message and the Tea break) and "Evening run".

Deviation from the brief: event 1 runs 09:00 to **15:00**, not 12:00, because 3 hours of 30-minute sessions with a 5-minute gap and the Tea break give only 4 slots, too few for six bookings plus free slots.

### Fixed clock

`vi.useFakeTimers({ toFake: ["Date"] })` and `vi.setSystemTime("2026-10-01T12:00:00Z")` (only `Date` is faked, so I/O and timers still work). A few scenarios move the clock and say so in their description: 2026-11-07T13:20Z/13:40Z (event 4, with `BOOKING_CUTOFF_OFFSET_MINUTES=120` so the booking window is still open while slots have started) and 2026-10-17T08:50Z (event 1, same cut-off). The admin sign-in uses a fixed `now` as well.

SQLite's own `strftime('now')` (the default `created_at` of a booking made through the API) is NOT under that clock. So **no captured artefact contains the `created_at` of an API-created booking**: the CSV and the .ics files are captured only for the seeded bookings.

### Normalisation (the only text that is not verbatim)

- `<token>`: the booking token of a booking made through the API during the capture (random) inside `/api/events/<slug>/bookings/<token>/ics` (the `icsUrl` field and the confirmation's "Add to calendar" link). The fixture tokens (`tok-b..`) are left as they are.
- `<key>`: the booking page's idempotency key (random, generated by `newIdempotencyKey`) in the recorded request bodies (`_meta.json` files). Idempotency keys chosen by the script itself are fixed strings and are not replaced.

### Formats

- JSON: pretty-printed (2 spaces), object keys sorted recursively, one trailing newline. API snapshots are `{ status, headers (content-type, cache-control, idempotent-replayed, content-disposition, allow, when present), body }`. Because keys are sorted, the cases in a grouped file appear alphabetically.
- DOM states: `<state>.html` is `document.body.innerHTML` with every `><` replaced by `>\n<` (so it diffs by line) plus a trailing newline; `<state>.txt` is `document.body.textContent` plus a trailing newline. `_meta.json` in each directory holds, per state, `document.title` and the requests the page made.
- `csv/*.csv`, `ics/*.ics` and `lineup/*.txt` are the raw text exactly as served (CSV: BOM and CRLF; .ics: CRLF; lineup: no trailing newline). The other `.txt` files (share, privacy) have one trailing newline added.

### What is not captured (gaps)

- Creating events and templates, editing templates, and the other admin write endpoints (their answers contain random slugs or ids, or are unaffected by this work). Settings, logo, icons and theme endpoints.
- A .ics or CSV row for a booking made during the capture (see the clock note).
- Layout and styling: the DOM is happy-dom's, with no CSS, so nothing about how the page looks (the layout checks are separate). Focus and scroll position are not recorded.
- Concurrent-request behaviour (each request is sent one at a time).

## Files

- `.gitattributes`: `* -text`: git never converts line endings or the BOM in these files (the CSV and .ics are CRLF; their bytes are part of the oracle)
- `README.md`: this file
- `admin-api/bookings-add.json`: POST /api/admin/events/:slug/bookings: success and every error
- `admin-api/bookings-clear.json`: DELETE /api/admin/events/:slug/bookings/:id: success and every error
- `admin-api/bookings-move.json`: POST /api/admin/events/:slug/bookings/:id/move: success and every error
- `admin-api/bookings-swap.json`: POST /api/admin/events/:slug/bookings/swap: success and every error
- `admin-api/detail-e1-after-actions.json`: GET /api/admin/events/:slug for event 1 after the add/move/swap/clear calls above, in that order (slots, bookings, lineup)
- `admin-api/detail-e1.json`: GET /api/admin/events/:slug for e1 (event, slots with bookings, orphans, defaultShareMessage, lineup)
- `admin-api/detail-e2-after-edit.json`: GET /api/admin/events/:slug for event 2 after the confirmed edit (same as step 7 of event-edit.json)
- `admin-api/detail-e2.json`: GET /api/admin/events/:slug for e2 (event, slots with bookings, orphans, defaultShareMessage, lineup)
- `admin-api/detail-e3.json`: GET /api/admin/events/:slug for e3 (event, slots with bookings, orphans, defaultShareMessage, lineup)
- `admin-api/detail-e4.json`: GET /api/admin/events/:slug for e4 (event, slots with bookings, orphans, defaultShareMessage, lineup)
- `admin-api/detail-e5.json`: GET /api/admin/events/:slug for e5 (event, slots with bookings, orphans, defaultShareMessage, lineup)
- `admin-api/event-edit.json`: PUT /api/admin/events/:slug on event 2: the clash (bookings_affected, with the orphan), invalid removeBookingIds, the confirmed save (removed bookings), the retry and the detail after
- `admin-api/events-list.json`: GET /api/admin/events: upcoming, past and archived groups, default share message
- `admin-api/orphan-actions.json`: event 2 (has an orphan booking): swap with the orphan refused, an add, and the detail JSON listing the orphan
- `admin-api/template-1.json`: GET /api/admin/templates/1 (the default template)
- `admin-api/template-2.json`: GET /api/admin/templates/2
- `admin-api/templates-list.json`: GET /api/admin/templates
- `admin-schedule-flows/_meta.json`: admin schedule flow: per state, the document title and the requests the page made (idempotency keys shown as "<key>"), plus clipboard writes where relevant
- `admin-schedule-flows/add-duplicate.html`: admin schedule flow, adding zoë / ANN LEE at 12:30, which duplicates booking 2: inline message: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule-flows/add-duplicate.txt`: admin schedule flow, adding zoë / ANN LEE at 12:30, which duplicates booking 2: inline message: textContent of <body>
- `admin-schedule-flows/add-invalid-input.html`: admin schedule flow, adding with a zero-width space in the dog name: field error: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule-flows/add-invalid-input.txt`: admin schedule flow, adding with a zero-width space in the dog name: field error: textContent of <body>
- `admin-schedule-flows/add-ok.html`: admin schedule flow, after adding Willow / Gail Park at 11:20: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule-flows/add-ok.txt`: admin schedule flow, after adding Willow / Gail Park at 11:20: textContent of <body>
- `admin-schedule-flows/clear-ok.html`: admin schedule flow, after clearing the 11:55 booking (=Max / +Dave Kerr): innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule-flows/clear-ok.txt`: admin schedule flow, after clearing the 11:55 booking (=Max / +Dave Kerr): textContent of <body>
- `admin-schedule-flows/move-ok.html`: admin schedule flow, after moving Rex 🐶 from 09:00 to 13:40: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule-flows/move-ok.txt`: admin schedule flow, after moving Rex 🐶 from 09:00 to 13:40: textContent of <body>
- `admin-schedule-flows/swap-nothing-chosen.html`: admin schedule flow, Swap panel submitted without choosing a slot: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule-flows/swap-nothing-chosen.txt`: admin schedule flow, Swap panel submitted without choosing a slot: textContent of <body>
- `admin-schedule-flows/swap-ok.html`: admin schedule flow, after swapping the 09:35 and 10:45 bookings: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule-flows/swap-ok.txt`: admin schedule flow, after swapping the 09:35 and 10:45 bookings: textContent of <body>
- `admin-schedule/_meta.json`: admin schedule page: per state, the document title and the requests the page made (idempotency keys shown as "<key>"), plus clipboard writes where relevant
- `admin-schedule/e1-add-open.html`: admin schedule page, event 1 with the Add booking panel open on the 11:20 row: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/e1-add-open.txt`: admin schedule page, event 1 with the Add booking panel open on the 11:20 row: textContent of <body>
- `admin-schedule/e1-add-submitted-empty.html`: admin schedule page, event 1, the Add booking panel submitted empty (server field errors): innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/e1-add-submitted-empty.txt`: admin schedule page, event 1, the Add booking panel submitted empty (server field errors): textContent of <body>
- `admin-schedule/e1-after-copy.html`: admin schedule page, event 1 after Copy lineup and Copy message were pressed: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/e1-after-copy.txt`: admin schedule page, event 1 after Copy lineup and Copy message were pressed: textContent of <body>
- `admin-schedule/e1-clear-open.html`: admin schedule page, event 1 with the Clear panel open on the 09:00 row: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/e1-clear-open.txt`: admin schedule page, event 1 with the Clear panel open on the 09:00 row: textContent of <body>
- `admin-schedule/e1-move-open.html`: admin schedule page, event 1 with the Move panel open on the 09:00 row: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/e1-move-open.txt`: admin schedule page, event 1 with the Move panel open on the 09:00 row: textContent of <body>
- `admin-schedule/e1-schedule.html`: admin schedule page, event 1: booked and free rows, the Tea break: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/e1-schedule.txt`: admin schedule page, event 1: booked and free rows, the Tea break: textContent of <body>
- `admin-schedule/e1-swap-open.html`: admin schedule page, event 1 with the Swap panel open on the 09:00 row: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/e1-swap-open.txt`: admin schedule page, event 1 with the Swap panel open on the 09:00 row: textContent of <body>
- `admin-schedule/e2-orphan-clear-open.html`: admin schedule page, event 2 with the Clear panel open on the orphan booking: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/e2-orphan-clear-open.txt`: admin schedule page, event 2 with the Clear panel open on the orphan booking: textContent of <body>
- `admin-schedule/e2-orphan-move-open.html`: admin schedule page, event 2 with the Move panel open on the orphan booking: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/e2-orphan-move-open.txt`: admin schedule page, event 2 with the Move panel open on the orphan booking: textContent of <body>
- `admin-schedule/e2-schedule-with-orphan.html`: admin schedule page, event 2: unnamed break and the 'Not in the schedule' orphan section: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/e2-schedule-with-orphan.txt`: admin schedule page, event 2: unnamed break and the 'Not in the schedule' orphan section: textContent of <body>
- `admin-schedule/e3-archived-schedule.html`: admin schedule page, event 3 (archived): no Share control: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/e3-archived-schedule.txt`: admin schedule page, event 3 (archived): no Share control: textContent of <body>
- `admin-schedule/unknown-event.html`: admin schedule page, an unknown event slug: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `admin-schedule/unknown-event.txt`: admin schedule page, an unknown event slug: textContent of <body>
- `booking-page-flows/_meta.json`: booking page flow: per state, the document title and the requests the page made (idempotency keys shown as "<key>"), plus clipboard writes where relevant
- `booking-page-flows/e1-confirmation-copied.html`: booking page flow, the confirmation after pressing Copy booking: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page-flows/e1-confirmation-copied.txt`: booking page flow, the confirmation after pressing Copy booking: textContent of <body>
- `booking-page-flows/e1-confirmation.copy.txt`: the text the confirmation's Copy booking button wrote to the clipboard (copyText)
- `booking-page-flows/e1-confirmation.html`: booking page flow, after booking 11:20 as Willow / Gail Park: the confirmation: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page-flows/e1-confirmation.txt`: booking page flow, after booking 11:20 as Willow / Gail Park: the confirmation: textContent of <body>
- `booking-page-flows/e1-duplicate-booking.html`: booking page flow, booking 12:30 as ZOË / ann lee, which duplicates booking 2: the form error: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page-flows/e1-duplicate-booking.txt`: booking page flow, booking 12:30 as ZOË / ann lee, which duplicates booking 2: the form error: textContent of <body>
- `booking-page-flows/e1-slot-taken-refresh.html`: booking page flow, 12:30 was booked by someone else after the page loaded: slot-taken notice and refreshed slots: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page-flows/e1-slot-taken-refresh.txt`: booking page flow, 12:30 was booked by someone else after the page loaded: slot-taken notice and refreshed slots: textContent of <body>
- `booking-page-flows/e2-archived-after-load.html`: booking page flow, event 2 was archived after the page loaded: bookings closed (410): innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page-flows/e2-archived-after-load.txt`: booking page flow, event 2 was archived after the page loaded: bookings closed (410): textContent of <body>
- `booking-page-flows/e2-invalid-slot-after-edit.html`: booking page flow, event 2's end was moved earlier after the page loaded; the chosen 19:10 slot no longer exists: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page-flows/e2-invalid-slot-after-edit.txt`: booking page flow, event 2's end was moved earlier after the page loaded; the chosen 19:10 slot no longer exists: textContent of <body>
- `booking-page-flows/e4-slot-started.html`: booking page flow, the 13:30 slot started between choosing it and submitting: 'already started' notice: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page-flows/e4-slot-started.txt`: booking page flow, the 13:30 slot started between choosing it and submitting: 'already started' notice: textContent of <body>
- `booking-page/_meta.json`: booking page: per state, the document title and the requests the page made (idempotency keys shown as "<key>"), plus clipboard writes where relevant
- `booking-page/e1-error-both-empty.html`: booking page, submitted with both names empty: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/e1-error-both-empty.txt`: booking page, submitted with both names empty: textContent of <body>
- `booking-page/e1-error-empty-dog.html`: booking page, submitted with an empty dog name: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/e1-error-empty-dog.txt`: booking page, submitted with an empty dog name: textContent of <body>
- `booking-page/e1-error-empty-handler.html`: booking page, submitted with an empty handler name: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/e1-error-empty-handler.txt`: booking page, submitted with an empty handler name: textContent of <body>
- `booking-page/e1-error-invisible-character.html`: booking page, submitted with a zero-width space in the dog name: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/e1-error-invisible-character.txt`: booking page, submitted with a zero-width space in the dog name: textContent of <body>
- `booking-page/e1-error-no-letter-or-number.html`: booking page, submitted with a dog name of only emoji: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/e1-error-no-letter-or-number.txt`: booking page, submitted with a dog name of only emoji: textContent of <body>
- `booking-page/e1-error-too-long.html`: booking page, submitted with an 81-character handler name: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/e1-error-too-long.txt`: booking page, submitted with an 81-character handler name: textContent of <body>
- `booking-page/e1-open.html`: booking page, event 1 open with free slots: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/e1-open.txt`: booking page, event 1 open with free slots: textContent of <body>
- `booking-page/e1-slot-selected.html`: booking page, event 1 with the 11:20 slot selected and the form shown: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/e1-slot-selected.txt`: booking page, event 1 with the 11:20 slot selected and the form shown: textContent of <body>
- `booking-page/e3-archived.html`: booking page, event 3 (archived): innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/e3-archived.txt`: booking page, event 3 (archived): textContent of <body>
- `booking-page/e4-started-slots.html`: booking page, event 4 at 2026-11-07T13:40:00Z with a 120-minute cut-off: started slots shown disabled: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/e4-started-slots.txt`: booking page, event 4 at 2026-11-07T13:40:00Z with a 120-minute cut-off: started slots shown disabled: textContent of <body>
- `booking-page/e5-closed.html`: booking page, event 5 (started, bookings closed): innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/e5-closed.txt`: booking page, event 5 (started, bookings closed): textContent of <body>
- `booking-page/unknown-event.html`: booking page, an unknown event slug: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line
- `booking-page/unknown-event.txt`: booking page, an unknown event slug: textContent of <body>
- `capture.test.ts.txt`: the capture script, exactly as run (a .txt so Vitest does not run it); to rerun it, copy it to src/test/golden-capture.test.ts in a v1.0 worktree
- `csv/e1.csv`: GET .../export.csv for e1, raw (BOM, CRLF, formula guard)
- `csv/e1.headers.json`: response headers of the e1 CSV export (content type and download name)
- `csv/e2.csv`: GET .../export.csv for e2, raw (BOM, CRLF, formula guard)
- `csv/e5.csv`: GET .../export.csv for e5, raw (BOM, CRLF, formula guard)
- `ics/e1-booking-01.ics`: GET /api/events/:slug/bookings/:token/ics, raw, for booking 1 ("Rex 🐶"; UID included)
- `ics/e1-booking-03.ics`: GET /api/events/:slug/bookings/:token/ics, raw, for booking 3 ("Biscuit"; UID included)
- `ics/e1-booking-04.ics`: GET /api/events/:slug/bookings/:token/ics, raw, for booking 4 ("=Max"; UID included)
- `ics/e1-booking-05.ics`: GET /api/events/:slug/bookings/:token/ics, raw, for booking 5 (80-character dog name; UID included)
- `ics/not-found.json`: the .ics route for an unknown token (404 body)
- `lineup/e1.txt`: the lineup text (admin detail "lineup" field, raw) for e1
- `lineup/e2.txt`: the lineup text (admin detail "lineup" field, raw) for e2
- `lineup/e5.txt`: the lineup text (admin detail "lineup" field, raw) for e5
- `manifest.json`: this list: every captured file with a one-line description (does not list itself, README.md or capture.test.ts.txt)
- `privacy/default-notice.txt`: DEFAULT_PRIVACY_NOTICE constant from src/server/config.ts
- `privacy/notice-in-api.txt`: privacyNotice as GET /api/events/:slug returns it (no PRIVACY_NOTICE set)
- `public-api/event-e1.json`: GET /api/events/:slug, open event with free slots
- `public-api/event-e2.json`: GET /api/events/:slug, open event with an orphan booking (ignored by the public view)
- `public-api/event-e3.json`: GET /api/events/:slug, archived event (no slots)
- `public-api/event-e4-with-started-slots.json`: GET /api/events/:slug for event 4 at 2026-11-07T13:40:00Z with BOOKING_CUTOFF_OFFSET_MINUTES=120: slots free, past and taken together
- `public-api/event-e4.json`: GET /api/events/:slug, unlisted event, open
- `public-api/event-e5.json`: GET /api/events/:slug, past, unarchived event (bookings closed)
- `public-api/event-not-found.json`: GET /api/events/:slug for an unknown slug (404)
- `public-api/events-list.json`: GET /api/events (listed, open, not started: events 1 and 2)
- `public-api/post-bookings.json`: POST /api/events/:slug/bookings: created, replayed, idempotency_key_reuse, slot_taken, duplicate_booking, invalid_slot, 404, 410s and malformed requests (tokens shown as <token> in icsUrl)
- `public-api/post-invalid-input.json`: POST /api/events/:slug/bookings with invalid input, one case at a time (fields object per case)
- `public-api/post-slot-started.json`: POST /api/events/:slug/bookings at 2026-10-17T08:50:00Z with BOOKING_CUTOFF_OFFSET_MINUTES=120: slot_started with freeSlots, and a normal booking in a later slot
- `public-api/settings.json`: GET /api/settings (club name, privacy contact, website)
- `seed.sql`: the exact SQL that builds every fixture row on top of migrations 0001-0014 (one statement per line)
- `share/e1-built-in-template.txt`: buildShareMessage for event 1 with the built-in template
- `share/e1-default-template.txt`: buildShareMessage for event 1 (no message of its own: the default template's message is used)
- `share/e1-schedule-page-copy-lineup.txt`: what the schedule page's Copy lineup button wrote to the clipboard (event 1)
- `share/e1-schedule-page-copy-message.txt`: what the schedule page's Copy message (Share) button wrote to the clipboard (event 1)
- `share/e4-own-message.txt`: buildShareMessage for event 4 (its own share message)

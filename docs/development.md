# Development

This page is for developers. A club that only wants to use the app does not need it: see the [README](../README.md) and the [admin guide](admin-guide.md).

## How it is built

The app is one Cloudflare Worker that serves the website and the booking API, plus one D1 database. The server is written in TypeScript. The front end is vanilla JavaScript with no build step: the files in `public/` are served as they are.

Design notes:

- Times are stored in UTC and shown in Europe/London.
- Money is whole pence.
- No tracking: no analytics or third-party scripts, and the Content-Security-Policy allows scripts from the site only.

## Run it on your own computer

You need Node 24 (the tests and typecheck pass here on v24.20.0).

```sh
npm install
cp .dev.vars.example .dev.vars   # every line is commented out: nothing is needed to start
npm test                         # unit and integration tests
npm run typecheck
npm run db:migrate:local         # local D1 under .wrangler/state
npm run seed                     # adds a test event and prints its URL
npm run dev                      # Wrangler prints the local address
```

Open the local address to make a local admin secret and recovery code, as in [First run: `/setup`](../README.md#first-run-setup). The local database gets its own 30-minute first-run window when `npm run db:migrate:local` first creates it, and while the window is open `/` and the admin pages send you to `/setup`. After that, `/setup` needs a code: set `SETUP_CODE` (12 or more characters) in `.dev.vars` and restart `npm run dev`. Once you have signed in, `/setup` is closed; `/recover` with the recovery code makes a new secret.

To reset the local sign-in, delete the `admin_credentials` row and reopen the window in the local database (**unverified**: I have not run these local commands):

```sh
npx wrangler d1 execute DB --local --command "DELETE FROM admin_credentials"
npx wrangler d1 execute DB --local --command "UPDATE auth_settings SET setup_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), claim_token_hash = NULL, recovery_hash = NULL, recovery_created_at = NULL"
```

Or delete the `.wrangler/state` folder and run `npm run db:migrate:local` again, which also deletes the local bookings. This is the same reset as in [handover.md](handover.md#if-the-admin-secret-is-lost), pointed at the local database.

If `/setup` answers 404 locally, see [Local development: `/setup` 404s](deploying.md#local-development-setup-404s).

## Migrations in development

`npm run db:migrate:local` applies every file in `migrations/` to the local database under `.wrangler/state` (`wrangler d1 migrations apply DB --local`). Run it again after pulling new migrations. After `npm run configure` (the command-line deploy in [deploying.md](deploying.md#advanced-deploy-from-the-command-line)), Wrangler keys the local database file on the database id, so `npm run dev` then starts from an empty local database: run `npm run db:migrate:local` again.

The tests migrate their own local database (`src/test/global-setup.ts`) and use the database name `slot-booker-db` from `wrangler.jsonc`, so do not rename it.

`scripts/verify-schema.sh` applies the migrations to a throwaway local database and checks the schema's constraints. It exits non-zero if any check fails.

## Seeding

`npm run seed` adds one test event to the local database (it applies any pending migrations first) and three sample bookings, and prints the event's URL. Each run adds another event; nothing is wiped.

- `npm run seed -- --no-bookings` adds the event only.
- `SEED_PERSIST_TO=/some/dir npm run seed` uses a throwaway local state folder instead of `.wrangler/state`.
- `npm run seed:local` is the same as `npm run seed -- --local`.
- `npm run seed -- --remote --env preview` seeds the remote **preview** database only (the script refuses production). It does not apply migrations: apply them first, as in [For maintainers: the preview environment](deploying.md#for-maintainers-the-preview-environment).

The options are listed at the top of `scripts/seed.ts`.

## Tests

`npm test` runs Vitest over `src/**/*.test.ts` and `public/**/*.test.ts`. The tests run with the time zone set to Pacific/Auckland on purpose, so a test that needs Europe/London has to ask for it. The parallel booking tests (many requests at once against the local database) take a few seconds each, so the test timeout is 30 seconds.

`npm run typecheck` checks the server code and the code in `public/` separately (two `tsc` runs).

### The golden fixtures

`src/test/fixtures/v1-golden/` holds outputs of the v1.0 code (commit `7810f8c`) for one dog-club event: the public and admin JSON, the booking page, the admin schedule, the CSV, the calendar file, the lineup and the share text. `src/test/golden-v1.test.ts` replays them against the current code after migrating a v1.0 database, to prove that an event made on v1.0 behaves and looks the same. Only changes that are written into that test, one by one, are allowed. **Never regenerate the fixtures from newer code.** How they were made, and what each file is: [the fixtures' README](../src/test/fixtures/v1-golden/README.md).

## The phone layout check: `npm run test:webkit`

`npm run test:webkit` is an opt-in layout check for the admin pages and the public booking page on a phone, started with the date and time inputs. iOS Safari gives those inputs a minimum width of their own, which once made them overflow the card and overlap on a phone, and Chromium never shows it. The script serves `public/` locally, stubs the API, and loads the events list, `/admin/new` (plain, with templates, and after switching template), `/admin/edit`, the schedule, settings and the three states of `/admin/templates` (list, create form, edit form with breaks) at 320 and 390 px wide in Playwright's WebKit. It fails if a date or time input leaves its field, row, group or card, a Start/End pair overlaps, any element sticks out past the right edge of the screen (scrolling boxes aside), or the page scrolls sideways; and if the admin navigation has a link that is hidden, under 48 px, outside the screen or overlapping another, wraps onto a second row, or is not directly under the header band.

It also loads the pages for lanes, places and the booking form's fields: the schedule with several lanes, the event and template forms with their "Lanes" and "Booking form" cards, the schedule's Add booking panel, and the public booking page with one lane, one named lane, several places and several lanes. There it checks that buttons and fields are at least 48 px tall and wide, that rows and buttons stay inside their card, and that text is not clipped. The list of states and checks is at the top of `scripts/check-ios-date-inputs.mjs`.

`--shots` also runs every state in dark mode and saves full-page screenshots (`--shots-dir <dir>`, default a folder in the system temp directory) for looking at.

It needs a machine where Playwright supports WebKit (`npx playwright-core install webkit` fetches the browser; Linux also needs its system libraries). Where WebKit can't launch, it prints `SKIPPED` and exits 2, so a skip is never mistaken for a pass; add `--allow-skip` to exit 0 instead. `--engine chromium` runs the same checks in Chromium, as a sanity check of the script only. It is not part of `npm test`.

## Deploying from the command line

To deploy from the command line instead of the button, see [Advanced: deploy from the command line](deploying.md#advanced-deploy-from-the-command-line).

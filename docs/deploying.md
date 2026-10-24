# Deploying slot-booker

This page gets your club its own copy of the app on Cloudflare's free plan. The first part is for a club organiser and needs no terminal. The advanced parts are for people comfortable with a command line.

Your copy is **one Cloudflare Worker**, named `slot-booker` unless you change it. It serves the website and the booking API, and it uses one D1 database, `slot-booker-db`. The migrations in `migrations/` (0001 to 0019) build the database.

**What was and was not checked.** The button was run once end to end against the public copy of this repository on 6 October 2026 ([Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)), when it still asked for a setup code: the form, the build, the migrations, the deploy to `workers.dev`, `/setup`, sign-in, creating an event and booking all worked. On 22 October 2026 a trial copy of the earlier version with no setup code was deployed through the form, which showed no secret field and ran `npm run deploy`. The first-run page, the recovery code and `/recover` described below have **not** yet been run through the button: that run is still to do. The rest of the steps follow Cloudflare's documentation and this repository's code and configuration. Where the text says something that run, the documentation and the code do not confirm, it says **unverified**. Dashboard labels may have changed.

Contents:

- [Before you start](#before-you-start)
- [Deploy with the button](#deploy-with-the-button)
- [Check that it works](#check-that-it-works)
- [Advanced: deploy from the command line](#advanced-deploy-from-the-command-line)
- [Custom domain and Cloudflare Access](#custom-domain-and-cloudflare-access)
- [For maintainers: the preview environment](#for-maintainers-the-preview-environment)
- [Updating your copy](#updating-your-copy)
- [Troubleshooting](#troubleshooting)
- [Before a real event](#before-a-real-event)

## Before you start

You need:

- A **Cloudflare account** (free). Use a club email address that more than one person can reach.
- A **GitHub or GitLab account.** The button copies the code into it.
- The address of the template, which must be a **public** repository on github.com or gitlab.com. The button only works from a public one.

There is nothing to decide or type beforehand: the form has no password or code field. You make your admin secret on your new site once it is deployed.

## Deploy with the button

1. **Press the "Deploy to Cloudflare" button** in the [README](../README.md). It opens Cloudflare.
2. **Sign in to Cloudflare**, or create the free account. The sign-up screens are Cloudflare's own: unverified here.
3. **Connect your Git account** when asked. The form has a "Create private Git repository" checkbox: tick it if you want your copy private. Cloudflare's docs say the button copies the repository into your own account, so you end up with your own copy that you own.
4. **Fill in the prompts.** Cloudflare's docs say you can customise the "repository name, Worker name, and required resource names". The suggestions are fine. The form list is in the [README](../README.md#what-the-form-asks-for).
   - The **project name** is also your Worker's name and your copy's repository name, and it becomes part of your address: `https://<worker-name>.<your-workers-subdomain>.workers.dev`. If your account already has a repository of that name, Cloudflare suggests the same name with `-1`; accept it.
   - The **database** (`DB`) is made for you: leave "Create new" and the suggested name, location hint and read-replication checkbox. The description shown is the one in `package.json`: "Your club's booking database. Cloudflare creates it for you, so the suggested name is fine."
   - **Build command** is empty and **Deploy command** is `npm run deploy`: leave both.
   - There is no secret or password field. If the form shows a switch for Cloudflare Access or for preview builds, leave it off; neither appeared on 22 October 2026.
   - This is the form as expected after this change; the ADMIN_AUTH field is expected to be gone but has not been seen yet (**unverified**).
5. **Deploy.** Cloudflare creates the database and replaces the placeholder database id in your copy of `wrangler.jsonc`, then builds the copy with Workers Builds. That runs `npm run deploy`, which applies all 19 migrations to the database through its `DB` binding and publishes the Worker. Wait for it to finish; the trial run took about 45 seconds. The last migration starts your 30-minute first-run window (see below). Both scripts pass `--env=""`, which targets the top-level environment explicitly: without it Wrangler warned that several environments are defined and none was chosen (`env.preview` exists). A dry run of the current scripts shows no such warning.
6. **Find your site's address.** Cloudflare does not show it when the deploy ends. In this order:
   1. It is the `https://….workers.dev` line near the end of the build log.
   2. Or, in the Cloudflare dashboard, open **Workers & Pages**, then your Worker (named as you named the project). Its page shows the address. These menu names are **unverified**: check on the next run and correct this. A new account may have to pick a `workers.dev` subdomain first: also unverified.

   Open that address, not `/setup`, for your first visit. Once the 30 minutes have run out, the address just shows the ordinary home page; add `/setup` to it to see the closed message and the ways to reopen (or open `/admin`, which says sign-in isn't set up).
7. **Make your admin secret and recovery code.** While the first-run window is open, your address takes you to a page that says the site has no admin yet. Then:
   1. Press **Create my admin secret**.
   2. The page shows your **admin secret** (43 characters) and your **recovery code** (43 characters), **once**. Press **Copy admin secret** and **Copy recovery code** and paste each into a password manager now, ideally as two separate entries.
   3. Tick **I've saved both**, then press **Go to sign in**.
   4. On the sign-in page, paste the admin secret into **Admin secret** and press **Sign in**.

What to know about the first run:

- **The window is 30 minutes, counted from when the database was created** (the last migration in the build), not from your first visit. A redeploy does not reopen it.
- **Only the button creates anything.** Opening the page, or a link checker or preview fetching your address, creates nothing.
- A second visitor is refused with "This site has already been set up". Until you first sign in, and within a day, the browser that pressed the button can press again to **replace** the pair: the old secret and the old recovery code then stop working.
- **Until you press the button, anyone who finds your site's address within the 30 minutes can press it first.** To close that gap, set `SETUP_CODE` as a Worker secret (any phrase of 12 or more characters) before your first visit. The window is then off and `/setup` asks for that phrase, as in v1.1.
- It works only on a password-provider site and only while no admin has signed in yet. Under Cloudflare Access, `/setup` is closed (404).
- If you open an admin page while the window is open and nobody has pressed the button, it sends you to `/setup`.
- After the first successful sign-in `/setup` is closed for good (404).
- With `SETUP_CODE` set, the code form is limited to 5 attempts per 15 minutes per visitor (every attempt counts), the code is compared in constant time, and the page accepts same-origin requests only. The button has no such limit, because there is nothing to guess.
- Only hashes are stored: the admin secret's in `admin_credentials` and the recovery code's in `auth_settings`. If you lose the secret, use the recovery code on your site's `/recover` page; if you lose both, see [If the admin secret is lost](handover.md#if-the-admin-secret-is-lost).
- If nobody pressed the button within the 30 minutes, your address shows the ordinary home page ("No events are open for booking right now"), `/admin` says "Admin sign-in isn't set up.", and `/setup` says setup is closed. See [Troubleshooting](#troubleshooting).

## Check that it works

On your phone or computer, with your own address:

1. Open `https://<your-address>/api/health`. It should show `{"ok":true}`.
2. Open `https://<your-address>/`. You should see the landing page ("Slot booker" until you set a club name, and no events yet).
3. Open `https://<your-address>/admin/` while signed out. It should send you to the sign-in page (or to `/setup` if you have not done step 7 yet and the window is still open).
4. Sign in, open **Settings** (`/admin/settings`) and set the club name and the **privacy contact** (a name and an email address). Until then the booking page shows signed-in admins a warning and tells bookers nothing about who to contact. See [branding.md](branding.md).
5. Create a test event (see [admin-guide.md](admin-guide.md)), open its booking link in a private window and book a slot. Then delete the test event.
6. Press **Sign out**, then check `/admin/` sends you back to the sign-in page.

## Advanced: deploy from the command line

Use this if you prefer a terminal, want to choose where the database lives, or want the deploy to happen from your own computer rather than from Workers Builds.

You need Node 24 and Git. Every step below uses a command that exists in `package.json` or Wrangler.

1. **Get the code and install.**

   ```sh
   git clone <your-copy-or-the-template-url> slot-booker
   cd slot-booker
   npm ci
   ```

2. **Log in to the club's Cloudflare account.**

   ```sh
   npx wrangler login
   npx wrangler whoami
   ```

   `whoami` shows which account you are using. If you set `CLOUDFLARE_API_TOKEN` instead of logging in, the token needs two permissions, confirmed in a real cutover on 6 October 2026: **Account → D1 → Edit**, and **Account → Workers Scripts → Edit**. The second is needed for `wrangler deploy` and also for `wrangler secret put`: without it the secret call fails with "No access to the specified resource" on `.../workers/scripts/<name>/secrets`. **Cloudflare Pages → Edit** is not needed: the app runs on Workers. Gotcha: unless the token also has **User → User Details → Read**, `whoami` prints a harmless error about missing permissions; it does not affect deploying.

3. **Create the databases.** `npm run configure` (step 4) needs **two** ids, production and preview, so create both; the free plan allows 10 databases per account.

   ```sh
   npx wrangler d1 create slot-booker-db --location weur
   npx wrangler d1 create slot-booker-db-preview --location weur
   ```

   **When Wrangler offers to add the binding to your Wrangler config, answer No.** If you answer Yes it edits `wrangler.jsonc` with a binding name that is not the committed one (`DB`). If you did, undo it with `git checkout -- wrangler.jsonc`. (This prompt comes from the earlier maintainer's real run, not from Cloudflare's docs.)

   `--location weur` is a placement hint (Western Europe). If bookings must stay within the EU use `--jurisdiction eu` instead (the location hint is then ignored), for both databases.

   Each command prints a `database_id` (a UUID). Note which is which.

4. **Put your ids in a git-ignored file and generate the config.** The committed `wrangler.jsonc` holds all-zero placeholder ids so no account details are committed. Do not edit it. Your ids go in `account.local.json` (git-ignored), and a script writes a git-ignored `wrangler.json` that Wrangler reads instead of `wrangler.jsonc`:

   ```sh
   cp account.local.example.json account.local.json
   ```

   Replace its contents with this, using your two ids (the example file also shows Access settings and a cut-off setting you do not need yet):

   ```jsonc
   {
     "productionDatabaseId": "<database_id of slot-booker-db>",
     "previewDatabaseId": "<database_id of slot-booker-db-preview>"
   }
   ```

   Optional keys, from `scripts/configure-core.ts`:

   - `name`: the Worker's name, if `slot-booker` is taken (lower-case letters, digits and hyphens).
   - `vars`: plain-text settings (strings) written into both the production and the preview block, for example `"BOOKING_CUTOFF_OFFSET_MINUTES": "-30"`. `productionVars` and `previewVars` add settings to one block only. `wrangler.jsonc` sets no `ADMIN_AUTH`: unset means `password`, so a password-provider site needs none. See [configuration.md](configuration.md).
   - Secrets (`ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`) are refused here: they are Worker secrets.

   Then generate the config:

   ```sh
   npm run configure
   ```

   It checks that both ids are real UUIDs, are not the placeholders and differ, writes `wrangler.json` and prints the variable names it wrote (never the values). Run it again whenever `wrangler.jsonc` or `account.local.json` changes. `npm run configure -- --clear` removes `wrangler.json` so Wrangler uses `wrangler.jsonc` again; it will not delete a `wrangler.json` it did not make.

   Wrangler looks for `wrangler.json` before `wrangler.jsonc` in the same folder, which is why the generated file takes over. That order is Wrangler's behaviour, not in Cloudflare's docs (they say only that both names are supported): check it after upgrading Wrangler by looking at the bindings `npm run dev` lists.

   Keep the top-level `database_name` as `slot-booker-db`: the tests and `npm run db:migrate:local` use it.

5. **Deploy.** This applies the migrations to the production database (`wrangler d1 migrations apply DB --remote`) and then publishes the Worker (`wrangler deploy`):

   ```sh
   npm run deploy
   ```

   `apply` asks for confirmation and takes a backup first. Wrangler prints the Worker's address. Both commands in `npm run deploy` pass `--env=""`, so the top-level environment is targeted explicitly and Wrangler does not warn about `env.preview`.

6. **Make your admin secret and recovery code.** Open the address Wrangler printed (not `/setup`) within 30 minutes of the migrations running, and follow step 7 of the button path above. If you would rather not rely on the window, set a `SETUP_CODE` first: it prompts for the value, so nothing secret goes on the command line, and it comes after the deploy so the Worker already exists:

   ```sh
   npx wrangler secret put SETUP_CODE
   ```

   (Wrangler's source has a prompt that offers to create the Worker if it does not exist, but I have not run it.) Whether the secret is live the moment the command finishes is **unverified**: if `/setup` still says it is not ready, wait a minute and reload.

Local development uses `.dev.vars` instead of secrets: `cp .dev.vars.example .dev.vars`, `npm run db:migrate:local`, `npm run dev`. The local database gets its own 30-minute window when it is created; to use `/setup` after that, set a `SETUP_CODE` of 12 or more characters in `.dev.vars`. After `npm run configure`, Wrangler keys the local database file on the database id, so `npm run dev` then starts from an empty local database: run `npm run db:migrate:local` again.

### Why the generated config is used, and the options that were rejected

- A plain edit of `wrangler.jsonc` would put your account's ids into a committed file. The fallback is to edit it by hand and hide the change with `git update-index --skip-worktree wrangler.jsonc`; Git may then refuse to pull when that file changes upstream (not tested), which is why the script exists.
- Wrangler's "generated configuration" redirect (`.wrangler/deploy/config.json`) cannot hold `env.preview`: Cloudflare's page says generated configuration should not include any environments ([docs](https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration)), and the earlier check on Wrangler 4.147.0 refused it. `d1` commands also ignored it.
- Cloudflare's configuration page describes no environment-variable substitution inside the config file.

Those three checks were made on an earlier version of the app and were not repeated for the Worker.

## Custom domain and Cloudflare Access

A club that wants named admins, or its own address, can add a custom domain and then Cloudflare Access.

1. **Custom domain.** It needs a domain whose nameservers are managed by Cloudflare ([Cloudflare's migration notes](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/) say custom domains require this). Adding it to the Worker is done in the dashboard under the Worker's settings: the exact labels are **unverified**, so follow Cloudflare's custom domains page for Workers.
2. **Access.** In the club's own copy of `wrangler.jsonc`, add `vars` with `ADMIN_AUTH` = `access`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (the template has no `vars`), commit and push so Workers Builds redeploys (or run `npm run deploy` from the command line). Create the Access application for the custom domain's hostname with the paths `/admin`, `/admin/*`, `/api/admin` and `/api/admin/*`. The full click path and the settings are in [admin-auth.md](admin-auth.md).
3. **Config `vars` overwrite values set in the dashboard on every deploy** unless `keep_vars` is set ([Wrangler docs](https://developers.cloudflare.com/workers/wrangler/commands/workers/)). Secrets are never deleted by a deploy.
4. **Test the sign-in.** It is **unverified** whether the `Cf-Access-Jwt-Assertion` header reaches a Worker that serves static assets: Cloudflare's docs say `ctx.access` is not available for such Workers ([Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)) and do not mention the header. The app validates the header itself. If admin answers 401 after you sign in through Access, that is the thing to look at.

The `workers.dev` address keeps serving the public booking pages. Access can protect `workers.dev` addresses too ([docs](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)), but the recommendation stays: use the custom domain.

With Access on, `/setup` is closed (404) and the stored admin secret is unused. The first time an admin signs in through Access, the Access settings are also saved in the database, so the `ADMIN_AUTH` line is then no longer what keeps the site on Access (see "Upgrading from v1.1" below for the order to remove it in). See [handover.md](handover.md) for switching over and for adding and removing admins.

## For maintainers: the preview environment

`wrangler.jsonc` has two environments:

- **Production** is the top level: Worker `slot-booker`, database `slot-booker-db`. `npm run deploy` is for this one.
- **Preview** is `env.preview`: Worker `slot-booker-preview`, database `slot-booker-db-preview`. It is a separate Worker with its own `workers.dev` address, secrets and data. `vars` and `d1_databases` are not inherited by `env.preview`, so each block spells them out.

Developers keep their own ids in `account.local.json` and run `npm run configure` (see above), which fills in both blocks. The commands:

```sh
npx wrangler d1 migrations apply DB --remote --env preview
npx wrangler deploy --env preview
npm run seed -- --remote --env preview
```

- The preview has its own database, so its own 30-minute first-run window. After that, set a `SETUP_CODE` for it with `npx wrangler secret put SETUP_CODE --env preview` to use `/setup` again.
- With `--env preview`, Wrangler looks the `DB` binding up in `env.preview.d1_databases` only, so these cannot migrate production. (Checked locally on the earlier version with `--local`; the remote commands resolve it the same way but were not run for this page.)
- `npm run seed -- --remote --env preview` inserts a sample event (and sample bookings; add `--no-bookings` for the event only) into the **preview** database only: the script refuses production. It does not apply migrations: if it fails with `no such table: events`, apply them first. Each run adds another event.
- Wrangler's `--preview` flag for D1 is an older, different mechanism based on `preview_database_id`. This repository does not use it; do not mix it with `--env preview`.
- `preview_urls` is `false` in `wrangler.jsonc`: Cloudflare's per-version preview URLs would serve the whole app, admin included, on extra hostnames, and use the production database by default.
- Treat the preview's data as test data.

## Updating your copy

The button makes a copy. Changes to the template do **not** flow into it, and Cloudflare's docs describe no way for them to. Two ways to update:

1. **Merge the template into your copy.** In your clone:

   ```sh
   git remote add template <template-url>
   git fetch template
   git merge template/main
   git push
   ```

   The migrations run on every deploy (the `deploy` script applies them), so pushing a merge that adds a migration applies it. Expect a conflict on the `database_id` lines of `wrangler.jsonc` if the button or you replaced the placeholders there: keep your own ids. If you added a `vars` block (for Cloudflare Access, say), expect a conflict there too: see "Upgrading from v1.1" below. That conflict is expected from how the button is documented to work; I have not seen it. A push redeploys your Worker automatically: the button's form says "Every push to your production branch will be deployed automatically". Tip: check the Deployments tab on the Worker's page in the dashboard after your first push. To deploy without pushing, run `npm run deploy` from your clone.
2. **Deploy a fresh copy** with the button and move the data across, as in [handover.md](handover.md). More work, but it starts clean.

Apply all migrations before running new code that needs them. For instance `0011_site_icons` adds the `site_icons` table: without it Settings, saving or removing the logo and uploading icons return errors, while public pages fall back to the default icons.

Migrations `0015` to `0017` rebuild the `bookings` table (for lanes and places) in three files, because Cloudflare's documentation does not say whether a migration file is applied as one transaction: `0016` is written so that running it again after an interruption finishes the job, and the old table is only dropped by `0017`, after the rows have been copied (and checked). From `0015` (which renames the old table) until the new Worker is live, the previous version of the Worker cannot read or make bookings, so a deploy that includes these migrations has a gap, normally seconds long: update at a quiet time, and take an export first (`npx wrangler d1 export`, see [handover.md](handover.md)). I have not measured the gap on a deployed copy. The booking table's id counter is not carried across (a write to D1's internal `sqlite_sequence` table might be refused, which would stop the migration after `0015` and leave the site down), so the id of a booking that was cleared before the migration may be given to a new booking; nothing outside the app refers to booking ids. Migration `0018` (the booking form's fields) only adds tables and rows, so it has no gap of its own: the previous Worker keeps working after it, and an event that Worker makes before the new one is live has no field rows and is read as Dog and Handler. The same goes for an event made in the window between `0016` and the new Worker going live: it has no layout row and no lane, so the new Worker gives it one unnamed lane, capacity 1 and a limit of 1 the first time anyone opens it (the public page, the booking form, or the admin list or event page), and it then behaves like any other event.

### Upgrading from v1.0

To go from v1.0 (migrations up to `0014`) to the version with lanes and places and the configurable booking form (migrations `0015` to `0018`), do these in order:

1. Take an export first, and keep it private (it contains the admin secret's hash): see [handover.md](handover.md#exporting-before-deleting).
2. **Apply the migrations before the new Worker is live.** `npm run deploy` does this in the right order (migrations, then `wrangler deploy`), and so does the build the button sets up, so pushing the upgrade is enough. By hand, run `npm run db:migrations:apply` and then deploy. Do not deploy the new code first: it needs the new tables.
3. Expect a short gap. `0015` renames `bookings`, so from then until the new Worker is live the old Worker cannot read or make bookings. Choose a quiet time. Nothing is lost in the gap.
4. If `migrations apply` stops at `0015` with "no such table: bookings", follow [the recovery steps](#migrations-apply-stops-at-0015-with-no-such-table-bookings) instead of editing a migration.

I upgraded a v1.0 preview database (2 events, 5 bookings) with `wrangler d1 migrations apply` and then `wrangler deploy --env preview` on 21 October 2026, and every booking was unchanged afterwards. I have not run `npm run deploy` end to end against a v1.0 database, and I have not measured the gap on a deployed copy.

### Upgrading from v1.1

v1.1 (migrations up to `0018`) asked for a `SETUP_CODE` on the Deploy form. This version (migration `0019`) does not, and the template's `wrangler.jsonc` no longer has a `vars` block. Updating works as described above. What changes for you:

- **Keep your own `vars`.** The template no longer sets `ADMIN_AUTH`. If you changed the `vars` line (for Access, say), merging the template shows a conflict on it: keep your version. Nothing else changes. A password-mode site can delete the line or keep it: both work.
- **A site whose admin has signed in, or that has `SETUP_CODE` set, is unaffected.** It behaves as before, and the first-run window is irrelevant to it.
- **A site with no admin and no `SETUP_CODE`** (one that today answers "Admin sign-in isn't set up." on every admin page) gets a 30-minute first-run window when the migration runs. Open its address within 30 minutes to make the admin secret and recovery code as in step 7 above; after that, set `SETUP_CODE` to reopen it.
- **A site made on v1.1 that has signed in has no recovery code.** It keeps whatever recovery it has today: its `SETUP_CODE`, or the D1 console ([handover.md](handover.md#if-the-admin-secret-is-lost)). A recovery code exists only for an admin secret made on this version's `/setup`.

**If your site is on Cloudflare Access through `ADMIN_AUTH`, do these in this order.** The template no longer has the line, so it is yours to keep until the site has recorded the Access settings itself:

1. Deploy the new code with `"vars": { "ADMIN_AUTH": "access" }` still in your own `wrangler.jsonc` (with your `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`).
2. Sign in once through Cloudflare Access. This first sign-in records the Access settings in the database (the mode is "pinned").
3. Check that `/api/admin/session` shows provider `access`. This only shows that the site is on Access: it says `access` even if saving the pin failed.
4. Open an admin page (the admin pages call the session endpoint, and that call is what saves the pin). Then, in the D1 console, or from a terminal in the project folder, run the decisive check and expect `access` and `import`:

   ```sh
   npx wrangler d1 execute DB --remote --env="" --command "SELECT mode, changed_by FROM auth_settings WHERE id = 1;"
   ```

5. Only when that shows `access` / `import`, remove the `ADMIN_AUTH` line.

Removing the line **before** that first sign-in drops the site back to password mode, with the old admin secret valid again. A site that has never had an admin sign in through Access is not protected against losing the line. Once pinned, the site stays on Access without the line, and editing the line back to `password` does not leave Access either; the ways out are in [handover.md](handover.md).

I have not run this upgrade on a deployed copy.

## Troubleshooting

### `/setup` says "Setup is closed. The first-run window ended"

Once the 30 minutes have run out, your site's address itself just shows the ordinary home page, so add `/setup` to it to see this message.

The cause: nobody pressed **Create my admin secret** within 30 minutes of the database being created, and no `SETUP_CODE` is set, so no admin secret can be made from the web any more. (A 503. An admin page says "Admin sign-in isn't set up." for the same reason.) Reopen it in one of two ways:

- Set `SETUP_CODE` as a Worker secret (any phrase of 12 or more characters), then reload `/setup` and type that phrase. In the dashboard: the Worker, then **Settings**, then **Variables and Secrets**, and add a secret named `SETUP_CODE` (menu names **unverified**). Or in a terminal, in the project folder: `npx wrangler secret put SETUP_CODE`.
- Or run the reopen statement below in the D1 console. It starts a new 30-minute window.

### `/setup` says "Setup isn't ready: SETUP_CODE must be at least 12 characters."

`SETUP_CODE` is set but shorter than 12 characters, so setup refuses it (a 503). Set a longer one as above and reload `/setup`.

### An admin page says "Admin sign-in isn't set up."

This is a 503 on `/admin/*` and `/api/admin/*`. For a new deployment it normally means the first-run window has ended with no admin made and no `SETUP_CODE` is set: see the entry above. (While the window is open, or with a `SETUP_CODE` set, an admin page sends you to `/setup` instead.) It can also mean `ADMIN_AUTH` is **set** to something other than `access` or `password` (an empty value counts), or one of the sign-in settings is missing or malformed. An unset `ADMIN_AUTH` is fine: it means `password`. The page does not say which; the reason is in the Worker's logs.

Read the logs with Wrangler (the command exists in the installed Wrangler 4.147.0, but I have not run it against a real deployment):

1. In one terminal: `npx wrangler tail` (add `--env preview` for the preview).
2. In another, reload the admin page.
3. Look for the line `Admin auth is not configured: <reason>`. The reason names the setting. The settings are in [admin-auth.md](admin-auth.md).

The Worker's logs may also be in the dashboard: **unverified**.

### `/setup` says "This site has already been set up"

Someone, probably you, has already pressed **Create my admin secret** (or made a secret with the code), and nobody has signed in yet. If you pressed it, sign in at `/admin/login` with the admin secret you saved. If you did it in the browser you still have, open `/setup` there, within a day, to get a new pair.

If you **never saw your admin secret** (the connection dropped, say), or you think someone else pressed the button first, take the site back: set `SETUP_CODE` as a Worker secret (any phrase of 12 or more characters) and reload `/setup`, or run the reopen statement below.

### `/setup` shows "Setup has already been completed."

An admin has already signed in, so `/setup` is closed (404). Sign in at `/admin/login`. If the secret is lost, use the recovery code on `/recover`, or see [If the admin secret is lost](handover.md#if-the-admin-secret-is-lost).

### The reopen statement

For when you need the first-run claim page back. Run it in the D1 console (dashboard menu names **unverified**), or from a terminal in the project folder. **Delete the `admin_credentials` row first** if an admin secret was already made:

```sh
npx wrangler d1 execute DB --remote --env="" --command "DELETE FROM admin_credentials"
npx wrangler d1 execute DB --remote --env="" --command "UPDATE auth_settings SET setup_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), claim_token_hash = NULL, recovery_hash = NULL, recovery_created_at = NULL;"
```

The second statement starts a new 30-minute window and also clears the recovery code. That matters: an old recovery code still works at any time, and could make a new admin in the empty site. So run the whole statement, not a shorter one, whenever the recovery code might be known to someone else. The new pair you then make on `/setup` includes a new recovery code.

If your site is on Cloudflare Access and you need to get back to the password sign-in, the statement is `UPDATE auth_settings SET mode = 'password', changed_by = 'owner' WHERE id = 1;` (and remove any `ADMIN_AUTH` = `access` line from your settings first, or the next Access sign-in puts Access back).

### `/recover` says "Not found"

`/recover` answers "Not found" if the site has no stored recovery code (an admin secret made before this version has none), or if `ADMIN_PASSWORD_HASH` or `ADMIN_SESSION_SECRET` is set as a Worker secret: they override the stored credentials, so there is nothing for `/recover` to replace (and `/setup` stays closed for them too). Delete those two secrets first (or, to keep using them, change them as described under "Override" in [handover.md](handover.md#changing-the-admin-secret-or-signing-everyone-out)).

If your site is on Cloudflare Access with an `ADMIN_AUTH` = `access` line in its settings, remove that line **first** and then use `/recover`; otherwise the next Access sign-in puts the Access mode back and undoes the recovery. `/recover` says so when it detects the setting.

### "That setup code isn't right." or "Too many attempts"

This is only for a site with `SETUP_CODE` set. Check the code you chose. After 5 attempts in 15 minutes the page says "Too many attempts. Try again in N minutes." Wait that long. The code is trimmed of spaces at both ends, but spaces inside it count.

### Admin sign-in says "Too many attempts"

The admin sign-in allows 5 attempts per client per 15 minutes. Wait, or use the secret from your password manager. Everyone on the same network address shares the count.

### Visitors get a 429 error

The Free plan's daily request limit for the Worker (100,000 a day) has been passed. Booking pages and the API answer 429 until the day resets (00:00 UTC), while static files keep working. See the numbers in [costs.md](costs.md). A club with a few dozen bookers should not reach it; an event link shared widely, or a bot, might.

### The button's build failed

Open the build log on the Worker's page in the dashboard (**unverified** where). A migration step that fails stops the deploy, so the Worker is not updated with code that needs a missing table. Fix the cause and retry. `npm run db:migrations:apply` can be run on its own from a terminal.

### `migrations apply` stops at `0015` with "no such table: bookings"

**Checked on real D1** (the preview database, 21 October 2026, Wrangler 4.147): I produced this state on purpose by running `0015_bookings_legacy.sql` on its own with `wrangler d1 execute`, so the rename was committed and `d1_migrations` had no record of it. `migrations apply` then stopped with exactly this error, the check below listed only `bookings_legacy`, the `INSERT` recorded `0015`, and the next `migrations apply` carried on with `0016`, `0017` and `0018`; the existing bookings were all still there afterwards, unchanged. I have not seen a real deploy stopped in this state: in a separate test, a migration file that failed half-way was rolled back as a whole by D1, so this state may never happen. It means the rename in `0015_bookings_legacy.sql` was committed but Wrangler's own record of it in the `d1_migrations` table was not, so Wrangler tries `0015` again. Do not edit the migration. First confirm the state: the old table must exist under its new name and the new one must not exist yet.

```sh
npx wrangler d1 execute DB --remote --env="" --command "SELECT name FROM sqlite_master WHERE name IN ('bookings', 'bookings_legacy')"
```

Only if that lists `bookings_legacy` and not `bookings`, record `0015` as applied by hand, then run the migrations again (it carries on with `0016`):

```sh
npx wrangler d1 execute DB --remote --env="" --command "INSERT INTO d1_migrations (name) VALUES ('0015_bookings_legacy.sql')"
npm run db:migrations:apply
```

If both tables are listed, or neither, stop and restore from the export you took before updating (see [handover.md](handover.md#exporting-before-deleting)).

### Admin shows an error saving Settings or a logo

The database probably lacks a migration. Run `npm run db:migrations:apply` (or `npm run deploy`), logged in to the club's account.

### Local development: `/setup` 404s

`/setup` answers 404 when setup is closed. Check that neither `ADMIN_PASSWORD_HASH` nor `ADMIN_SESSION_SECRET` is set in `.dev.vars` (setting either turns `/setup` off) and that `ADMIN_AUTH`, if set, is `password`. If it answers 503 "Setup is closed" instead, the local database's 30-minute window has ended: check `.dev.vars` has `SETUP_CODE` of 12 or more characters.

## Before a real event

- **Data location.** The button creates the database for you: whether it offers a location or jurisdiction choice is **unverified**. If bookings must stay in the EU, use the command-line path with `--jurisdiction eu`.
- **The booking API has no rate limiting or bot protection.** Only the admin sign-in, `/setup` (with a `SETUP_CODE`) and `/recover` count attempts. Add something like Cloudflare Turnstile before posting the link publicly.
- **Privacy notice.** The booking form shows one. The default says details are kept until an organiser deletes the event, and nothing is deleted automatically, which is what the app does: delete or clear out old events from the admin list when you no longer need them. The default names no data controller or contact, so set the privacy contact on the Settings page and, if you can, replace the notice with your own text ([configuration.md](configuration.md)).
- **Admin sign-in.** The default is a single shared secret with no second factor and no per-person identity ([admin-auth.md](admin-auth.md), "Known limits"). If that is not enough for your club, put the site on a custom domain and use Access (above).
- **Keep these safe.** Your Cloudflare login, the admin secret and the recovery code (and the `SETUP_CODE`, if you set one): see [handover.md](handover.md).

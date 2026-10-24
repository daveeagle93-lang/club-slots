# Handing the app over to the club

This is for the day the live app moves from the maintainer's own Cloudflare account to the club's own account, and for the jobs the club then does itself: keeping the right things safe, recovering a lost admin secret, changing it, adding and removing admins, exporting data and tidying up. The reader is a club volunteer who can follow steps and paste a few commands, and the maintainer who is handing over.

The app is **one Cloudflare Worker** (`slot-booker` by default) and one D1 database (`slot-booker-db`), deployed from the club's own copy of the code on GitHub or GitLab. See [deploying.md](deploying.md).

**What was and was not run.** No Cloudflare command was run in writing this document, and nobody has done this handover against a real pair of accounts. The `--help` output of the installed Wrangler (4.147.0) was read for `wrangler secret put|delete`, `wrangler d1 export|execute|delete`, `wrangler delete` and `wrangler logout`, and the app's code was read for what it does with sign-in, sessions, setup and deletion. Statements about Cloudflare's dashboard and services come from Cloudflare's documentation, with the page linked each time. Where the documentation says nothing, or nothing was checked, the text says **unverified** and tells you to check in the dashboard. Dashboard labels were the ones on Cloudflare's pages when this was written and may have changed.

## The short version

1. The club creates its own Cloudflare account and invites the maintainer, or the maintainer invites the club; either way, the club's owner ends up as a **Super Administrator**.
2. Deploy the app in the club's account from scratch with the button, from the club's own GitHub or GitLab account ([deploying.md](deploying.md)).
3. Copy the data across: export from the old database, import into the new one, and check the logo and the numbers match.
4. Make the new site's admin secret and recovery code on its first-run page, and test the site on its `workers.dev` address.
5. Move the club's address to the new site, and switch admin sign-in to Cloudflare Access if the club wants it.
6. Only when everything is checked: the maintainer exports a last copy, deletes their own Worker and databases, and leaves the club's account.

## What the club must keep safe

Write down where each of these is kept, and who can get at it. Keep them in a password manager the committee shares, not in one person's head.

| Keep safe | What it does | If it is lost |
| --- | --- | --- |
| **The Cloudflare login** (club email, password, any second factor) | Owns the Worker, the database and every setting. | Cloudflare's account recovery, not this app. Hold **Super Administrator** on two people, and make the account email one that more than one person can read. |
| **The GitHub or GitLab account** that holds the club's copy | Source of the code and its updates. | The live site keeps running. Updates and redeploys need access to it. |
| **The admin secret** (43 characters) | Signs admins in. Shown once on the first-run page. Only its hash is stored. | Make a new one with the recovery code: [If the admin secret is lost](#if-the-admin-secret-is-lost). |
| **The recovery code** (43 characters) | Shown once, next to the admin secret. Makes a new admin secret on the site's `/recover` page, at any time. Only its hash is stored. Keep it as a separate entry from the admin secret. | If you still have the admin secret, nothing is lost yet, but you have no safety net. Today the only ways to a new pair are deleting the `admin_credentials` row with `SETUP_CODE`, or the full reopen statement, both in [If the admin secret is lost](#if-the-admin-secret-is-lost), and both sign everyone out. A signed-in action to make a new recovery code is planned. If both are lost, use the `SETUP_CODE` or the D1 console, as there. |
| **The `SETUP_CODE`** (12+ characters), **only if you set one** | Optional. Replaces the 30-minute first-run window with a code, and reopens setup after the window has ended. | Set a new one (a Worker secret). It has no other use, and may be left in place. |

Anyone who holds the recovery code can reset the admin secret on `/recover`, so keep it as safe as the secret. Anyone who holds the Cloudflare login can also reset the admin secret, as below. That is by design: account owners already control everything.

## Before you start

- A Cloudflare account owned by the club, with a club email address that more than one person can reach. Cloudflare says only a Super Administrator can manage members, so make sure at least one club person has that role ([Manage members](https://developers.cloudflare.com/fundamentals/manage-members/manage/), [Roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)).
- A GitHub or GitLab account for the club (or for the person who looks after it) to hold the club's copy of the code.
- For command-line steps, a computer with Node 24, a clone of the club's copy, and someone who can paste commands into a terminal. Hand over the repository link, not the maintainer's `account.local.json` (it holds the maintainer's database ids).
- If the club wants Access: a domain whose nameservers are managed by Cloudflare (see "Switching to Cloudflare Access" below).
- The maintainer's access to the old account until the end. Nothing in the old account should be deleted until "Removing the maintainer's access".
- A private place for export files (they hold names).

## Moving to the club's own Cloudflare account

I couldn't find any documented way to transfer a Worker or a D1 database from one Cloudflare account to another. Treat that as **unverified**: the route below does not rely on a transfer. It builds a second copy in the club's account, copies the data in, checks it, then switches over. (Cloudflare does document moving a domain between accounts: [Move a domain](https://developers.cloudflare.com/fundamentals/manage-domains/move-domain/). That is the address only, not the app.)

### Step A: set up the club's account and its owner

1. The club creates its Cloudflare account.
2. Invite the people who will run it in **Manage Account**, **Members**, **Invite**, entering the email, choosing the role and confirming ([Manage members](https://developers.cloudflare.com/fundamentals/manage-members/manage/)). Give the club's owner **Super Administrator - All Privileges**. Cloudflare's "Administrator" role cannot manage members or billing ([Roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)).
3. Do this before anything else, and wait until the club's owner has accepted and can see the Members list. The maintainer can then be added as a temporary, lesser member (or simply work from the owner's login with the owner present). Reason: if the maintainer set everything up and then left, nobody else could add or remove members.

### Step B: deploy the app in the club's account

Follow [deploying.md](deploying.md), "Deploy with the button", logged in to the **club's** Cloudflare and GitHub or GitLab accounts, so the club owns the copy. There is no code to choose: the club makes its own admin secret and recovery code on the new site (see below). The deploy creates an empty database with all 19 migrations applied. Do not copy anything from the maintainer's account except the data in Step C.

Do **not** copy the old admin secret across. It is not in the exported tables below, and the club makes its own admin secret and recovery code on the first-run page (do it now, within 30 minutes of the database being created, so you can test the site; the club's owner should be the one who presses the button and saves both).

### Step C: copy the data across

The data lives in fourteen tables: `events`, `event_layout`, `event_lanes`, `event_fields`, `breaks`, `bookings`, `event_templates`, `event_template_layout`, `event_template_lanes`, `event_template_fields`, `event_template_breaks`, `site_settings`, `site_logo`, `site_icons`. Do **not** copy `admin_credentials` (the old admin secret's hash), `auth_settings` (the sign-in mode and the old recovery code's hash, and the new site's first-run window) or `login_attempts`.

The club's new database already has its tables, because the deploy ran the migrations. So export the old database's **data only**, for those tables, and import it into the new one. The old database must be on the same migrations (all 19): check with `npx wrangler d1 migrations list DB --remote`, and apply any missing ones to the old database first (`npm run db:migrations:apply`), with the old account's login and ids configured.

Wrangler finds the database by the binding in `wrangler.json`, which `npm run configure` writes from `account.local.json`. So the export needs the **old** database's id in that file and the old account's login, and the import needs the **new** ones. Do them one after the other and run `npm run configure` each time you change the file ([deploying.md](deploying.md), step 4 of the command-line path).

1. **Export, with the old account's login and old ids configured** (`--table` takes several names; put it last):

   ```sh
   npx wrangler d1 export slot-booker-db --remote --no-schema --output=./backup.sql --table events event_layout event_lanes event_fields breaks bookings event_templates event_template_layout event_template_lanes event_template_fields event_template_breaks site_settings site_logo site_icons
   ```

   Whether a data-only export of several tables imports cleanly, and in what order it writes the tables, is **unverified**: this is the reason for the scratch round trip in step 3. The flags are from `npx wrangler d1 export --help` (Wrangler 4.147.0).
2. Log in to the club's account (`npx wrangler login`, then `npx wrangler whoami`), put the club's ids in `account.local.json` and run `npm run configure`.
3. **Round-trip into a scratch database first.** The club's preview database (`slot-booker-db-preview`, made in the command-line path of `deploying.md`) can serve as the scratch one: apply the migrations to it (`npx wrangler d1 migrations apply DB --remote --env preview`), then import there. The migration that makes `site_settings` already inserts its one row (`migrations/0009_site_settings.sql`), so empty that table first or the import would collide with it:

   ```sh
   npx wrangler d1 execute DB --remote --env preview --command "DELETE FROM site_settings"
   npx wrangler d1 execute DB --remote --env preview --file=./backup.sql
   ```

4. **Check that the logo and the app icons came across.** The club logo (table `site_logo`) and the app icons made from it (tab, home screen and manifest icons, table `site_icons`) are stored as images, BLOBs (blocks of raw bytes), in the database. Cloudflare's import/export page and its limits page do not say how BLOBs are exported ([Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [Limits](https://developers.cloudflare.com/d1/platform/limits/): a row or BLOB is at most 2 MB). A closed report in the Wrangler issue tracker (workers-sdk #8226) describes a crash when exporting a local database containing a BLOB column; that was an older Wrangler and a local database, but it is the reason for this check. Compare the logo's and the icons' sizes and checksums in both databases:

   ```sh
   npx wrangler d1 execute DB --remote --command "SELECT sha256, length(bytes) AS size FROM site_logo"
   npx wrangler d1 execute DB --remote --command "SELECT size, sha256, length(bytes) AS bytes FROM site_icons ORDER BY size"
   npx wrangler d1 execute DB --remote --env preview --command "SELECT sha256, length(bytes) AS size FROM site_logo"
   npx wrangler d1 execute DB --remote --env preview --command "SELECT size, sha256, length(bytes) AS bytes FROM site_icons ORDER BY size"
   ```

   Run the first two with the old account's login and old ids, the last two with the club's. The rows should be identical (`sha256` is a checksum the app stored when each image was saved). No icon rows is normal if the club never uploaded a logo. Also compare the row counts of `events` and `bookings` (`SELECT count(*) FROM bookings`).
5. **If the logo or the icons did not survive**, finish the move without them, then sign in to Admin, open **Settings** and upload the logo again ([branding.md](branding.md)). The app works without a logo in the meantime, and with no icon rows it serves its bundled default icons (`migrations/0011_site_icons.sql`). I haven't run this.
6. When the scratch copy matches, import into the club's **production** database the same way, with the same `DELETE FROM site_settings` first, using `DB` and no `--env`:

   ```sh
   npx wrangler d1 execute DB --remote --command "DELETE FROM site_settings"
   npx wrangler d1 execute DB --remote --file=./backup.sql
   ```

   Repeat the checks of step 4 against it.
7. The scratch copy now holds real names. Empty it when you have finished checking (`npx wrangler d1 delete <name>` exists; recreate the preview database if you still want a preview).

### Step D: check, then switch the address

1. Open the new site on its `workers.dev` address. Check `/api/health`, the landing page, one event's booking link and the admin sign-in with the club's new admin secret. Look at one event's bookings against what the old site shows.
2. If the club's own address pointed at the old site, move it. Adding a custom domain to a Worker is done in the dashboard under the Worker's settings (labels **unverified**; follow Cloudflare's custom domains page for Workers). It needs the domain's nameservers to be managed by Cloudflare ([Cloudflare's notes](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/) say so). Whether the old deployment must give the hostname up first, and how Cloudflare handles a hostname moving between two accounts, is **unverified**: check in the dashboard and expect a short gap. Choose a quiet moment, not the day bookings open.
3. Keep the old site running until the new address works and has been checked by someone other than the maintainer. Bookings made on the old site after the export are not in the new database: for a clean move, stop taking bookings (or re-export and re-import) around the switch.

### Step E: retire the old one

Only after "Removing the maintainer's access" says you may. Do not delete anything in the old account until the new one has been in use for a while and the club has a verified copy of its data (see "Exporting before deleting").

## If the admin secret is lost

This applies to the default sign-in (the password provider, with the secret made on the first-run page). Under Cloudflare Access there is no admin secret to lose; to get back from Access to the password, see "Leaving Access" below.

There are three routes. Use the first one that works for you.

### 1. The recovery code, on `/recover`

If you kept the recovery code that was shown with the admin secret:

1. Open `/recover` on the site (add it to the end of the address).
2. Type or paste the recovery code and press **Continue**.
3. The page shows a **new admin secret and a new recovery code**, once. Save both in the password manager (two entries). Tick **I've saved both**, press **Go to sign in** and sign in.

The new secret works at once. The old admin secret and the old recovery code stop working, and every session made with the old secret stops too, because a new session secret is made with it. `/recover` works at any time, with or without the first-run window, and it leaves `/setup` closed.

Things that stop it working:

- **It answers "Not found"** if the site has no stored recovery code (an admin secret made on v1.1 has none, and so has a site whose recovery code was cleared by the statement in route 3), or if `ADMIN_PASSWORD_HASH` or `ADMIN_SESSION_SECRET` is set as a Worker secret. Those override the stored credentials, so there is nothing for `/recover` to replace. Delete those two secrets first (`npx wrangler secret delete <NAME>`), or, to keep using them, change them as described under "Override" in [Changing the admin secret, or signing everyone out](#changing-the-admin-secret-or-signing-everyone-out).
- **If your settings have `ADMIN_AUTH=access`**, remove that line first, redeploy, and only then use `/recover`. Otherwise the next Access sign-in puts the Access mode back and undoes the recovery. `/recover` says so when it sees the setting. When the Access mode is stored in the database, a successful recovery switches it back to the password sign-in.
- **5 wrong tries** from one address in 15 minutes: the page says "Too many attempts" and you must wait. There is no limit across all visitors, on purpose, so nobody else can block you; the limit is per address.
- A recovery code works once. A second use of the same code answers "That recovery code has already been used."

### 2. `SETUP_CODE`

If there is no recovery code, or it is lost, and you can set a Worker secret:

**If you have not signed in yet:** open `/setup` again. With a `SETUP_CODE` set, enter it: it makes a new secret and recovery code and the old ones stop working. With no `SETUP_CODE`, only the browser that pressed the button (within a day of doing so) can ask for a new pair.

**If you have signed in at least once, `/setup` is closed**, so the stored credentials must be deleted first. You need access to the club's Cloudflare account. Anyone who has it can do this, by design: account owners already control everything.

1. **Delete the credentials row.** Either:
   - In the dashboard: open the D1 database (`slot-booker-db`), then its **Console**, and run `DELETE FROM admin_credentials;` (the dashboard's menu names are **unverified**), or
   - From a terminal in the project folder, logged in to the club's account:

     ```sh
     npx wrangler d1 execute DB --remote --command "DELETE FROM admin_credentials"
     ```

2. **Set `SETUP_CODE`** as a Worker secret (any phrase of 12 or more characters). `/setup` needs it. In the dashboard: the Worker, **Settings**, **Variables and Secrets** (menu names **unverified**), or from a terminal:

   ```sh
   npx wrangler secret put SETUP_CODE
   ```

   You do not need an old code. Whether a changed secret applies at once is **unverified**: if `/setup` still says it is not ready, wait a minute and reload.
3. **Do the next step straight away.** Until `/setup` has been run, anyone who knows the setup code could make themselves the admin, and the admin pages redirect to `/setup`.
4. **Open `/setup`**, enter the setup code, and save the **new** admin secret **and the new recovery code** in the password manager. Tick **I've saved both**, press **Go to sign in** and sign in.

What happens next: the new secret works. Every session made with the old secret stops working, because a new session secret is made with it. Once you have signed in, `/setup` closes again. The `SETUP_CODE` may stay in place.

**If the page says "This site has already been set up" but you never saw your admin secret** (the connection dropped, say, or you think someone else pressed the button first), set `SETUP_CODE` as above and reload `/setup`, or run the full reopen statement in route 3.

### 3. The D1 console

If you cannot set a Worker secret, or you want the first-run page back with no code, run this in the D1 console (or with `wrangler d1 execute`, as above). **Delete the `admin_credentials` row first**, if an admin secret was made:

```sql
DELETE FROM admin_credentials;
UPDATE auth_settings SET setup_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), claim_token_hash = NULL, recovery_hash = NULL, recovery_created_at = NULL;
```

The second statement starts a new 30-minute first-run window, so open the site's address and make a new admin secret and recovery code. Run the **whole** statement, not a shorter one. It also clears the recovery code, and that matters: an old recovery code still works at any time (it does not need the window), and it can create a new admin in the empty site. So if the recovery code might be known to someone else, it must be cleared too. As soon as the new admin is made, the new recovery code replaces it.

If the site has been left with a stored Access mode and you need the password sign-in back, see "Leaving Access" below.

If `/setup` still answers 404 after you delete the row, one of `ADMIN_PASSWORD_HASH` or `ADMIN_SESSION_SECRET` is set as a Worker secret, or the stored mode is Access. Then the deployment is in the override mode described below, or on Access: change the secrets there instead, or see "Leaving Access".

## Changing the admin secret, or signing everyone out

Under Access none of this applies.

**Default (secret made on the first-run page).** To change the secret, or to sign everyone out, do the recovery above, with `/recover` and the recovery code if you have it, or else by deleting the row and running `/setup`. Either replaces both the secret and the session secret, so nobody stays signed in. Give the new admin secret to the people who stay. The admin session lasts 8 hours (`docs/admin-auth.md`, "Sessions"), so this is also how you remove one admin: there are no individual accounts, only one shared secret.

**Override (existing deployments, local development).** If either `ADMIN_PASSWORD_HASH` or `ADMIN_SESSION_SECRET` is set as a Worker secret, the deployment behaves as it did before `/setup` existed, and `/setup` and `/recover` answer 404. Both must be valid ([admin-auth.md](admin-auth.md)).

| Secret | What it is | Change it to |
| --- | --- | --- |
| `ADMIN_PASSWORD_HASH` | The stored form of the shared admin secret. | **Change the password.** Nobody can log in with the old one afterwards. |
| `ADMIN_SESSION_SECRET` | Signs the cookie that keeps an admin signed in (at least 32 random characters). | **Sign everyone out.** Every existing session stops working. |

Changing only the hash leaves existing sessions valid until they expire, up to 8 hours. To remove an admin, change **both**.

1. Generate a new admin secret. Its one-time output is printed on the terminal: copy the secret into the password manager straight away, because it can't be recovered from the hash. The hash is the line on standard output.

   ```sh
   npm run --silent generate-admin-secret
   ```

2. For `ADMIN_SESSION_SECRET`, make 32 or more random characters, for example `openssl rand -base64 48`.
3. Store each as a Worker secret. Each command asks for the value, so nothing secret goes on the command line. Paste the **hash line** (not the secret) for `ADMIN_PASSWORD_HASH`:

   ```sh
   npx wrangler secret put ADMIN_PASSWORD_HASH
   npx wrangler secret put ADMIN_SESSION_SECRET
   ```

   Secrets can't be viewed afterwards but are listed by name: `npx wrangler secret list`, or in the dashboard under the Worker's **Variables and Secrets** (**unverified** label).
4. Whether a changed secret applies at once, or only after a redeploy, is **unverified**. Test: the old secret is refused, the new one signs in, and an admin tab left open from before has been signed out. If not, redeploy (`npm run deploy`, or push to the club's repository).

## Switching to Cloudflare Access on a custom domain

> **Rule.** Access is for a deployment on a custom domain whose nameservers are managed by Cloudflare. See [admin-auth.md](admin-auth.md).

Access replaces the shared secret with each admin signing in by their own email, using a code Cloudflare sends them. It is optional, and the app works with the secret. What the app does: with `ADMIN_AUTH=access` the app checks the signed token that Access adds to each request (`src/server/auth/access.ts`) and ignores any password cookie. Both admin paths have their own guard (`src/worker/guards.ts`), and both refuse a request with no valid Access token. Cloudflare attaches the token only to requests on paths Access covers, so Access has to cover **both** `/admin/*` and `/api/admin/*` (and the bare `/admin` and `/api/admin`: Cloudflare says `/admin/*` does not cover `/admin` itself, see [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)). If it covers only one, the other part of the admin gets no token and answers 401.

The order matters. Exact variable names and the full click path are in [admin-auth.md](admin-auth.md); this is the sequence.

1. **Custom domain on the Worker first** (Step D). Whether an existing Access policy on a hostname blocks adding it to a Worker as a custom domain is **unverified**, so add the domain before you create the policy.
2. **Create the Access application.** In Zero Trust, "Access controls", "Applications", "Create new application", "Self-hosted and private", then "Add public hostname" with the paths `/admin`, `/admin/*`, `/api/admin` and `/api/admin/*` on the club's hostname ([Self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)). Never leave the path empty: that would put the public booking pages behind a login. That one application can hold several paths is the project's assumption, not something Cloudflare's page states, so check it in the dashboard.
3. **Add an Allow policy** listing the admins' email addresses. Access applications deny everyone by default until an Allow policy matches. Set a short session duration (8 hours or less).
4. **Turn on the one-time PIN login method**, which emails each admin a single-use code that expires after 10 minutes: "Zero Trust", "Integrations", "Identity providers", "Add new identity provider", "One-time PIN" ([One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)). Cloudflare says a new Zero Trust organisation does not get it automatically, and that an email must match an Access policy before a code is sent. If admins don't receive codes, Cloudflare says to allow mail from `notify.cloudflare.com`.
5. **Give the app the settings.** Copy the application's AUD tag (Configure the application, then "Additional settings", "Application Audience (AUD) Tag") and your team domain (`<your-team-name>.cloudflareaccess.com`) ([Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)). In the club's own copy of `wrangler.jsonc`, add a top-level `vars` block (the template has none) with `ADMIN_AUTH` = `access`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Config `vars` overwrite values set in the dashboard on every deploy unless `keep_vars` is set ([Wrangler docs](https://developers.cloudflare.com/workers/wrangler/commands/workers/)); secrets are never deleted by a deploy.
6. **Redeploy**: commit and push so Workers Builds redeploys (the button's form says "Every push to your production branch will be deployed automatically"; check the Deployments tab on the Worker's page after your first push), or run `npm run deploy`. Until you redeploy, the site is still using the secret.
7. **Test** with the checks in [admin-auth.md](admin-auth.md): the admin must ask for Access sign-in, an allowed email must get in, a non-allowed one must be refused, and the public booking pages must still open without any sign-in. It is **unverified** whether the `Cf-Access-Jwt-Assertion` header reaches a Worker that serves static assets (Cloudflare's docs say `ctx.access` is not available for such Workers, [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), and are silent on the header; the app validates the header itself). If a signed-in admin still gets 401, that is the first thing to suspect. A `503` on admin means a setting is missing or malformed; the logs say which ([deploying.md](deploying.md), "Troubleshooting").
8. **Let the site record Access, then leave the line or remove it.** Setting `ADMIN_AUTH=access` already stops the app using the password: the app never falls back to the other provider's settings, and an old password session cookie is ignored once the site is on Access (`src/server/auth/index.ts`). `/setup` becomes a 404. The first time an admin signs in through Access, the site also records the Access settings in its database (the `auth_settings` row), which is called pinning. From then on the `ADMIN_AUTH` line is no longer what keeps the site on Access. **Do not remove the line before that first sign-in**: until then, removing it drops the site back to the password sign-in with the old admin secret valid again. After a sign-in through Access, check that `/api/admin/session` shows provider `access`. That only shows the site is on Access: it says `access` even if saving the pin failed. So next, open an admin page (the admin pages call the session endpoint, and that call is what saves the pin) and run this in the D1 console, or from a terminal with `npx wrangler d1 execute DB --remote --env="" --command "SELECT mode, changed_by FROM auth_settings WHERE id = 1;"`:

   ```sql
   SELECT mode, changed_by FROM auth_settings WHERE id = 1;
   ```

   Expect `access` and `import`. Only when it shows that, remove the line if you want to. Keep the stored secret (the `admin_credentials` row, or the two Worker secrets in override mode) for a few days. Once you are sure, you can delete the row, or `npx wrangler secret delete <NAME>` for the two override secrets; then going back to the secret means making one again (see "If the admin secret is lost").

### Leaving Access

Because an unset or `password` `ADMIN_AUTH` leaves the stored mode in charge, editing the line back to `password` no longer leaves Access once the site has been pinned. The ways back:

- **`/recover`** with the recovery code (route 1 above). It sets the stored mode back to `password` and makes a new admin secret and recovery code. If your settings still have `ADMIN_AUTH=access`, remove that line first and redeploy, because it wins over the stored mode.
- **The D1 console**, after removing any `ADMIN_AUTH=access` line from your settings:

  ```sql
  UPDATE auth_settings SET mode = 'password', changed_by = 'owner' WHERE id = 1;
  ```

  The site then uses the admin secret that is stored. If there is none, or it is lost, follow with the routes in "If the admin secret is lost".

If Access itself is why you are leaving, also remove the Access application, or its paths, in Zero Trust: the application in front of `/admin*` and `/api/admin*` (if any) still sits in front of the custom domain after the mode is switched. This is how Cloudflare Access behaves, not something this code does (**unverified**).

Before step 6, make sure the Allow policy holds an email address that someone can actually receive mail on, or nobody will get in.

Free-plan user limits for Access: I couldn't find them in Cloudflare's documentation; check Cloudflare's pricing page.

## Adding and removing admins

### Under Access

- **Add** an admin: add their email to the Allow policy of the Access application ("Zero Trust", "Access controls", "Applications", the application, its policy). Cloudflare's policy page describes an "Emails" selector for specific addresses ([Policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)); its step-by-step editing instructions aren't there, so I couldn't verify the exact clicks. Check in the dashboard.
- **Remove** an admin: delete their email from the policy. Cloudflare says emails are checked when someone logs in, not continuously (same page), so removing someone does not necessarily end a session they already have open. The app itself accepts any validly signed, unexpired Access token for the club's application (`admin-auth.md`, "How the Worker checks the token"), so until that token runs out the person can still use the admin. What limits it is the session duration you set on the policy: keep it short.
- **Forcing a sign-out now.** I couldn't find a documented way to do this in Cloudflare's documentation: **unverified**; look in the Zero Trust dashboard. One heavy remedy follows from how the app checks tokens, and it is my reading of the code, not something I ran: delete the Access application and create a new one, which gives a new AUD tag (Cloudflare says the tag never changes unless you delete or recreate the application), then put the new tag in `ACCESS_AUD` and redeploy. Tokens issued for the old application then fail the app's `aud` check. Use it only if a real leak is suspected.

### Under the shared secret

There are **no individual admin accounts**: one shared secret and a signed cookie, and the identity is always the word `admin` (`src/server/auth/password.ts`). So you can't remove one person. Removing an admin means changing the secret everyone shares, **and** signing everyone out, because a session already open stays valid for up to 8 hours otherwise. Follow "Changing the admin secret, or signing everyone out", then give the new admin secret to the people who stay.

## Removing the maintainer's access

Do this only after the club's deployment has been checked (Step D) and the club holds a verified copy of its data (see "Exporting before deleting").

**In the club's account (done by a club Super Administrator).**

1. Remove the maintainer as a member: "Manage Account", "Members", expand the member, "Revoke", confirm ([Manage members](https://developers.cloudflare.com/fundamentals/manage-members/manage/)). Only a Super Administrator can do this. A member can also choose to leave themselves, on the same page.
2. If Access is on: delete the maintainer's email from the Allow policy (see "Adding and removing admins"). Revoking membership does not do this.
3. **The club's copy of the code.** The button copies the code into the GitHub or GitLab account used when pressing it. If that was the maintainer's own account, the club does not own its copy: the repository has to be moved into the club's account, and the Worker's connection to it re-made. How to move the repository is GitHub's or GitLab's own feature (not checked here), and how Workers Builds handles a changed repository or a revoked authorisation is **unverified**: check the Worker's build settings in the dashboard (where is also unverified), and test a deploy afterwards. The simplest safe route is to have the club press the button itself, from the club's own GitHub or GitLab account, as in Step B.
4. Check "Members" afterwards.

**By the maintainer, in their own account.**

1. Export a last copy of the old database (see "Exporting before deleting"). Keep it private; delete it once the club confirms its own copy is good.
2. Delete the old Worker (the dashboard, or `npx wrangler delete <name>`, listed in `--help`) and the old D1 databases (the dashboard, or `npx wrangler d1 delete <name>`). I couldn't find whether D1's Time Travel backups survive a deleted database ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)): **unverified**, so don't treat Time Travel as a substitute for the export in step 1.
3. Run `npx wrangler logout`. Wrangler's documentation is understood to say it invalidates the current login token and deletes the stored credentials; I didn't record the page, so treat that as unverified and check `npx wrangler whoami` afterwards (it should say you are not logged in).
4. Revoke any API tokens the maintainer created, for example the one for `CLOUDFLARE_API_TOKEN` ([deploying.md](deploying.md), command-line path). I couldn't find revocation steps in Cloudflare's documentation. **Unverified:** the API Tokens list in the dashboard under your profile is where I'd look. Tokens belonging to a user are understood to be tied to that user, while account-owned tokens are understood to persist after their creator leaves an account (both unverified), so check the club account for any tokens the maintainer made there too. What happens to the maintainer's OAuth login after being removed from an account is also not documented in what I found.
5. The maintainer should also delete local copies: exports, the maintainer's `account.local.json`, and the generated `wrangler.json`.

## Where the data lives

All data is in one Cloudflare D1 database, `slot-booker-db` by default (the maintainer's preview has its own, `slot-booker-db-preview`). The tables, from [`migrations/`](../migrations/):

| Table | Holds |
| --- | --- |
| `events` | One row per event: name, start and end time, session length, gap, cost, venue postcode, details, whether archived, whether listed, its secret link slug, and its own share message (a copy: empty means the default template's message, or the built-in one). |
| `breaks` | Periods within an event with no slots (for example lunch), each with an optional label. |
| `event_templates` | The saved templates (at most 20) an admin starts a new event from: name, whether it is the default, details, postcode, cost, start and end time (London, `HH:MM`), session length, gap and share message. Events keep their own copy, so deleting a template changes no event. |
| `event_template_breaks` | The breaks of a template (start, end, optional name); removed with their template. |
| `event_layout` | One row per event: how many places each lane has at each time (`capacity`, 1 to 50), how many bookings one identity (the values of the event's identity fields, such as one dog and handler) may hold in the event (`identity_limit`, 1 to 20) and `config_rev`, a counter that every edit of the lanes, capacity, limit or the form's fields that matter to a booking (how many, which identify a booking, which are required, how long) must increase so a booking made at the same moment notices the change. Every event has one; existing events have capacity 1 and limit 1. |
| `event_lanes` | The lanes (parallel rings) of an event, in order, each with an optional name (a single lane may have none). Every event has at least one; existing events have one unnamed lane. The app allows 10 lanes; the table allows positions 1 to 1000 so that a reorder can park lanes above 100 inside one batch. A lane that still has bookings cannot be deleted, and a booking's lane must belong to the booking's own event (the database checks the lane and the event together). |
| `event_fields` | The booking form's fields, one row each, `position` 1 to 4 (the order of the form, and the number of the `bookings` column that holds the value), a `label` (1 to 40 characters, unique within the event ignoring case), whether it is `required`, its `max_length` (1 to 80) and whether it is `in_identity`. Existing events have Dog (position 1) and Handler (position 2), both required, 80 characters and in the identity, so their bookings and identity keys are unchanged. The number of fields and the identity set can't change once the event has bookings (`src/server/admin-event-edit.ts`). |
| `event_template_layout`, `event_template_lanes`, `event_template_fields` | The same for each template (lanes, places, identity limit, fields). An event keeps its own copy, as with the rest of a template. |
| `bookings` | One row per booking: the event, its **lane**, slot start time and **place** (1 up to the capacity), the booking form's field values (**the value of field *n* of the event is in `value_n`**: for the Dog and Handler form, dog in `value_1` and handler in `value_2`; an unused column is empty), the identity key and its number (what stops the same identity booking more than the limit allows: the keys of the identity fields' values joined with U+001F, numbered from 1), when it was booked, the booking's private token (for its calendar link) and the booking form's idempotency key. The database refuses a second booking of the same place, of the same identity number, or with the same token or idempotency key. |
| `login_attempts` | Attempt counting (every attempt, right or wrong) for the admin sign-in, for `/setup` with a `SETUP_CODE`, and for `/recover`: a keyed hash of the client's network address, a count and a time. Never used with Access. |
| `site_settings` | One row: club name, privacy contact name and email, website address and theme colours. |
| `site_logo` | At most one row: the club logo as an image, with its type, size and checksum. |
| `site_icons` | Up to three rows (32, 180 and 512 pixels): the app icons drawn from the logo (or with no logo, the default mark) and theme colour, as PNG images. None means the bundled fallback icons are used. |
| `admin_credentials` | At most one row, made on `/setup`: `secret_hash` (a hash of the admin secret, never the secret), `session_secret`, `created_at` and `first_login_at`. Used only when neither `ADMIN_PASSWORD_HASH` nor `ADMIN_SESSION_SECRET` is set, and not when the stored sign-in mode is Access. |
| `auth_settings` | Exactly one row (`id = 1`): the sign-in `mode` (`password` or `access`) with the team domain, AUD and hostname used when it is `access`, and who last changed it (`changed_by`); `setup_opened_at`, the start of the 30-minute first-run window; `claim_token_hash`, a hash of the token in the claiming browser's cookie; and `recovery_hash`, a hash of the recovery code (never the code), with `recovery_created_at`. It outlives `admin_credentials`, because the recovery code must still work when that row is replaced or deleted. |

**Personal data.** What bookers enter in the booking form (by default a dog's and a handler's names, or whatever the event's fields ask for, up to four values) and the times of their slots in `bookings`; the privacy contact's name and email in `site_settings`; and the pseudonymous address hashes in `login_attempts`, which the app treats as personal data too (`admin-auth.md`, "Rate limiting"). Exports hold all of it. Deleting an event removes its bookings from the live database, but D1's Time Travel backups (see Backups below) can still hold them, and the rows of the old `bookings_legacy` table that migration `0017` dropped, until their retention period ends (7 days on the Workers Free plan, 30 on Paid); the app can't remove them from the backups.

**Secrets.** `SETUP_CODE`, if one was set, is a Worker secret in the Cloudflare account. So are `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET`, if the override is used. None is in the repository, and an export does not contain them or carry them to a new account. The admin secret and the recovery code themselves are nowhere: only their hashes are stored, in `admin_credentials` and `auth_settings`. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, and `ADMIN_AUTH` where a club sets it, are plain settings in the deployment's configuration (the `vars` in the club's `wrangler.jsonc`, which the template does not have), not secrets. Nothing sets `ADMIN_AUTH` for a password site: unset means `password`. With Access, the settings are also saved in `auth_settings` after the first Access sign-in.

**Retention.** Nothing is deleted automatically, except old `login_attempts` rows, which are removed as a side effect of later login attempts. Bookings and events are only removed by an admin (checked in `src/server/admin-event-lifecycle.ts`): **Archive** hides the event and keeps all its data; **Delete** removes an event with its bookings, breaks, lanes and layout, permanently; **Clear out past events** (`src/routes/api/admin/events/clear-past.ts`) does the same for the past events you pick, and asks you to type `DELETE`. The booking form's privacy notice says details are kept until an organiser deletes the event, which matches this. Delete old events when you no longer need them.

**Backups.** D1 Time Travel can restore a database to an earlier moment: 7 days back on the Workers Free plan and 30 on Paid ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)). `npx wrangler d1 time-travel info <DB>` shows the available range. A restore overwrites the database in place, so use it with care, and it is not a replacement for exports.

**Exports and backups are as sensitive as the admin secret.** A database export or backup (`wrangler d1 export`, the dashboard, a Time Travel copy) contains the `admin_credentials` row: the hash of the admin secret and the key that signs sign-in cookies. Anyone holding a copy could sign in as admin. It also holds the hash of the recovery code in `auth_settings`. Keep exports private and delete them when you are done. Deleting the row, or running setup again before the first sign-in, replaces that key and so ends every existing sign-in.

**Free-plan limits worth knowing.** Cloudflare's Workers Free plan allows 100,000 requests a day to the Worker (resetting at 00:00 UTC) and 10 ms of CPU per request. Static files served straight from `public/` are free and unlimited; the Worker handles `/`, `/e/*`, `/api/*`, `/admin`, `/admin/*`, `/setup` and `/recover`. Past the daily limit those requests get a 429 and static files keep working ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). D1 on the free plan allows 5 million rows read and 100,000 rows written a day, 5 GB of storage and 10 databases per account ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). Whether a login fits the 10 ms on real Workers is **unverified** (`admin-auth.md`, "What a login costs").

## Exporting before deleting

**One event, for a spreadsheet.** In Admin, open the event and select **Download CSV**. It contains the bookings only: time (London time), lane (only when the event has a named lane), one column for each field of the booking form (headed by its label: dog and handler for the Dog and Handler form) and when it was booked (`src/routes/api/admin/events/[slug]/export.csv.ts`). It does not contain the event's settings, the breaks, the logo or anything else.

**The whole database.** Logged in to the account that owns the database, with that database's id in `account.local.json` and `npm run configure` run:

```sh
npx wrangler d1 export slot-booker-db --remote --output=./backup.sql
```

This writes the database's structure and contents to a file, including `admin_credentials`, which is why the file must be kept private. To load only the data into the club's new database, use the data-only export in Step C instead. Both commands are from [Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/) and were checked against `--help`; neither was run for this document. Notes:

- Cloudflare says an export blocks other requests to that database while it runs, so the booking page may pause briefly: export at a quiet time. An export has limits (a database of at most 5 GiB, no virtual tables, an SQL statement of at most 100 KB) ([Limits](https://developers.cloudflare.com/d1/platform/limits/)); this app's database is far smaller.
- How BLOBs (the logo and the icons) are exported is not in Cloudflare's documentation. Check as in Step C. Always restore into a scratch database and look, before relying on a backup.
- An export file contains every name and the privacy contact, and the admin sign-in key (see "Backups" above). Keep it private (not in the repository, not in email or a shared chat) and delete it when it is no longer needed. Files named `*backup*.sql` are git-ignored in this repository, but an export with another name is not, so do not commit it.
- **Never delete a database before the new one is verified**, and not before there is at least one export you have restored successfully somewhere.

## If something goes wrong, and after the handover

- **Admin shows an error or answers 503 after a change.** A setting or secret is missing or malformed. The reason is in the Worker's logs: [deploying.md](deploying.md), "Troubleshooting", shows how to read them. With Access, if the site has never had a sign-in through Access, the quickest way back is to remove the `ADMIN_AUTH` line (or set it to `password`) in `wrangler.jsonc` and redeploy (the stored secret must still exist). Once a sign-in through Access has been recorded, that no longer leaves Access: see "Leaving Access".
- **The admin secret is lost.** Use the recovery code on `/recover`, or see "If the admin secret is lost".
- **The new database is wrong or empty.** Don't delete the old one. Import again into a fresh database and check as in Step C.
- **Something was deleted by mistake.** Time Travel may restore it, if it was within the window (see "Where the data lives"). Act quickly, and ask the maintainer or Cloudflare before restoring, because a restore overwrites the database in place.
- **Nobody can sign in to the club's Cloudflare account.** This is why more than one person should hold Super Administrator, and why the club's account email should be reachable by more than one person.
- **After the handover, the maintainer cannot see the club's data**, and can't reset the secret or fix the live site unless the club invites them again. That is the point of the move, and the club is then the only one who can change its admins, its secrets and its deployment. The maintainer can still help from the repository (code, documentation and issues), but only on what the club chooses to share. Keep this document up to date with anything the club learns while doing the move.

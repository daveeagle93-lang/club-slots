# Zero-config setup: a first-run claim window instead of `SETUP_CODE`

Status: **approved 21 October 2026, including the recovery code added in section 3.6 (C7, C8). The code is written on branch docs/zero-config-setup; the post-implementation Deploy run (section 8.2) is still to do. The Deploy button probe P1 was run on 22 October 2026 and passed (section 8); three design changes that followed from it are in section 3.7.** Written 21 October 2026 against `main` = `v1.1` (commit `f71189f`, migrations `0001` to `0018`).

Goal: a non-technical organiser presses the Deploy button, accepts every default, deploys, opens their site and saves a password. The password sign-in stays the default. Cloudflare Access stays optional.

## 1. Summary of the proposal

| | Today (v1.1) | Proposed |
|---|---|---|
| Deploy form | Asks for `SETUP_CODE` (12+ characters). | Asks for nothing but the Git account, names and the database. **No secret prompt.** |
| First run | Find the `workers.dev` address, open `/setup`, type the code, save the secret. | Open the site. `/` and `/admin` send you to `/setup`. Press one button, save the secret. |
| Who may make the first secret | Whoever knows the code. | The first visitor to press the button, **within 30 minutes of the database being created**, while no admin exists. |
| `SETUP_CODE` | Required. | **Optional.** If set, setup works exactly as in v1.1 (code required, no claim window). It is also the way to reopen setup after the window expires. |
| Closes | At the first successful sign-in. | At the first successful sign-in, or when the window expires with nothing claimed. |

Decisions I made, for you to check (details in the sections below):

| # | Call | Why | Section |
|---|---|---|---|
| C1 | Window **N = 30 minutes**, a constant in code, not a setting. | Covers a slow deploy plus a distracted organiser; short enough that a stranger has little time. | 3.1 |
| C2 | The window starts when **migration `0019` runs**, not at the first request. | Nothing an outsider does can start or extend it. | 3.1 |
| C3 | If `SETUP_CODE` is set, the claim window is **off** and v1.1 behaviour applies unchanged. | Gives anyone who wants the strict behaviour a way to keep it, and leaves every existing deployment as it is. | 3.2 |
| C4 | A claim is **one-shot**: a second visitor cannot replace it. The claimer's browser keeps a claim cookie, so a reload or a closed tab can show a new secret. | Stops an attacker overwriting the owner's secret between "saved" and "first sign-in". | 3.3 |
| C5 | A claim needs an explicit **POST** from a button. Visiting `/setup`, `/` or `/admin` never claims. | Crawlers, link previews and Cloudflare's own checks must not claim the site. | 3.3 |
| C6 | `.dev.vars.example` keeps `SETUP_CODE` as a **commented-out** line. | Keeps the documentation for developers; unverified whether the button prompts for commented lines (section 2). | 2, 4 |
| C7 | The "save these now" screen shows an admin secret **and a recovery code** (requested by the owner). The code is stored hashed. A `/recover` page uses it to reset the admin secret without the D1 console. | New deployments have no `SETUP_CODE`, so without this a non-technical admin has no way back in. | 3.6 |
| C8 | `/recover` works **in any sign-in mode**, including Access, and counts as the Access wizard's break-glass. The code is single-use: using it makes a new one. | The wizard needs a recovery route that does not depend on a Worker secret. | 3.6, 5 |

All decisions are recorded in section 9; nothing is open.

## 2. What Cloudflare's Deploy button docs say (checked 21 October 2026)

Method: a research agent read the official pages, and I re-fetched the main page myself. WebFetch summarises pages through a small model, so quotes below are what it returned, not a transcript. Re-read the pages before quoting them publicly.

| Question | Finding | Status | Source |
|---|---|---|---|
| Do `.dev.vars.example` / `.env.example` drive the form? | Secrets "can be defined in a `.dev.vars.example` or `.env.example` file", in dotenv format. The changelog says the values "appear in the dashboard so users can configure them". | **Verified** | [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) (header "Last updated Oct 12, 2026"); [changelog, July 2025](https://developers.cloudflare.com/changelog/post/2025-07-01-workers-deploy-button-supports-environment-variables-and-secrets/) |
| Where do the descriptions come from? | `package.json` under `cloudflare.bindings.<NAME>.description`, with inline Markdown. Not from comments in the example file. | **Verified** | Deploy buttons page |
| Are example values prefilled? | The docs say the repo should include default values for **resource** names and IDs. For secrets, only one third-party post says each entry is shown with its example value prefilled. | **Unverified** (official). Third party: [dev.to post](https://dev.to/ddyy/my-deploy-to-cloudflare-button-disabled-auth-2p67) | |
| Are commented-out lines ignored? | The official docs never say. The same post says the button "prompts for every UNCOMMENTED entry". | **Unverified** (official) | dev.to post |
| Can a secret be optional or left empty? | The docs have no word about optional secrets. The post says "there's no way to mark one optional" and that a blank entry is still prompted. Whether an empty field **blocks** the deploy is not stated anywhere I found. | **Unverified** | dev.to post |
| Can the platform generate a secret? | Nothing found. The docs' own example tells the user to run `openssl rand -hex 32` themselves. | **No evidence it exists** | Deploy buttons page |
| `secrets.required` in the Wrangler config? | Real, but unrelated to the button. It makes `wrangler deploy` **fail** if a listed secret is missing, so **we must not add it** for any optional secret. How the button treats it is untested. | Config key **verified**; button behaviour **unverified** | [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/); [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/); [changelog, March 2026](https://developers.cloudflare.com/changelog/post/2026-03-24-secrets-config-property/) |
| Does the button run migrations? | Not by itself. Run them inside the `deploy` script. The docs example is `wrangler d1 migrations apply DB_BINDING --remote` chained before `wrangler deploy`. Our `deploy` script already does this (`package.json:15`). | **Verified** | Deploy buttons page |
| Which command runs? | "If no `deploy` script is specified, Cloudflare will preconfigure `npx wrangler deploy`", and the fields are "detected and pre-populated". Whether the form runs `npm run deploy` exactly is not stated. We have one end-to-end run (6 October 2026, v1.0 era) that says it did. | Partly **verified** | Deploy buttons page; `README.md` ("Work in progress") |
| Does the user learn their URL afterwards? | The docs never mention `workers.dev` or a post-deploy page for the button. | **Unverified** | Deploy buttons page |
| Does removing the only prompted secret break the button? | No source says the button needs at least one secret. A template with no `.dev.vars.example` at all is the normal case for Workers templates. | **Unverified**, probably fine | |

**What this means for the design.**

1. Nothing in the docs lets us auto-generate a secret at deploy time. A first-run flow on the site itself is the only route to "no typing in the form". The proposal does not depend on any undocumented button behaviour **if** the button copes with a repo that has no live line in `.dev.vars.example`. That was the single thing to prove, and the P1 run proved it (2.1, 8.1).
2. **Resolved:** the button did not dislike zero entries (P1, 2.1), so the fallback, option B in section 6, is not needed.
3. The `SETUP_CODE` description in `package.json` has to go with its live line: `src/test/deploy-button.test.ts:96` demands a description for every live key, and `:100` fails if a description exists for a key that is not live.

### 2.1 What the P1 probe observed (22 October 2026, one run)

Run by the owner on their own Cloudflare account against a public scratch copy of v1.1 with **zero live lines** in `.dev.vars.example`, no `SETUP_CODE` entry in `package.json`, and unique Worker and database names (section 8). One run, so everything here is "observed once", not "documented".

| Row of the table above | Observed |
|---|---|
| Does a repo with **no live secret line** work? | **Yes.** The form showed **no secret field** and the deploy succeeded. Option B (section 6) is not needed. |
| Are commented-out lines ignored? | **Observed yes, once.** The file kept its commented lines (`# BOOKING_CUTOFF_OFFSET_MINUTES=-30`, `# ADMIN_AUTH=password`, and the rest) and none appeared on the form. |
| Optional or empty secrets, prefill | Not tested: there was no secret field to test. (P0, which would have tested a blank live line, was skipped because P1 passed.) |
| Are plain `vars` shown? | **New finding: yes, and editable.** `ADMIN_AUTH` from `wrangler.jsonc` appeared as a text field prefilled `password`. This drives section 3.7 (a). |
| Command fields | Build command empty; deploy command prefilled `npm run deploy`. So the form does run our `deploy` script, which applies the migrations. |
| Naming | Project name = Worker name = copy-repo name. The source repo and the target account were the same here, so the name clashed ("A repository with that name already exists") and Cloudflare suggested `-1`. A club deploying from the template into its **own** account has no clash; this is a maintainer-testing effect. |
| Does the user learn their URL afterwards? | **No.** The `workers.dev` address appeared **only in the build log**; nothing on the completion screen pointed at it. A non-technical user would have to hunt. |
| Form fields, in order | Git account; "Create private Git repository" checkbox; Project name; Select D1 database (Create new); D1 name; location hint; read replication checkbox; `ADMIN_AUTH`; Build command; Deploy command. The README's "Protect with Cloudflare Access" and "Enable Preview builds" switches (README item 5) were **not seen** in this run, so the README's form list is stale or conditional; it needs rewriting from a fresh run (section 7). |
| After deploy | `/` showed "Upcoming events / No events are open for booking right now."; `/admin` showed "Admin sign-in isn't set up."; `/setup` showed "Setup isn't ready: set SETUP_CODE …". These are the expected v1.1 answers with no code set. |

## 3. The proposal

### 3.1 The claim window

A new migration, `0019_auth_settings.sql` (the next free number on `main`; the Access wizard takes `0020`, section 5). It creates the **one shared settings row** for everything about first-run setup, recovery and the sign-in mode, on the `site_settings` pattern (`migrations/0009_site_settings.sql`: a singleton, `id = 1`, snake_case columns):

```sql
CREATE TABLE auth_settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  -- sign-in mode (shared with the Access wizard, 3.8)
  mode                TEXT NOT NULL DEFAULT 'password' CHECK (mode IN ('password', 'access')),
  access_team_domain  TEXT,
  access_aud          TEXT,
  access_hostname     TEXT,
  changed_at          TEXT,
  changed_by          TEXT CHECK (changed_by IS NULL OR changed_by IN ('wizard', 'recovery', 'import', 'owner')),
  -- first-run claim window and claim (3.1, 3.3)
  setup_opened_at     TEXT NOT NULL,   -- ISO 8601, UTC
  claim_token_hash    TEXT,            -- set by the claim; empty until then
  -- recovery code (3.6)
  recovery_hash       TEXT CHECK (recovery_hash IS NULL OR substr(recovery_hash, 1, 12) = 'hmac-sha256$'),
  recovery_created_at TEXT,
  CHECK (mode <> 'access' OR (access_team_domain IS NOT NULL AND access_aud IS NOT NULL AND access_hostname IS NOT NULL))
);
INSERT INTO auth_settings (id, setup_opened_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
```

(An earlier draft had two tables, `setup_window` and `recovery_code`. They are columns of this row instead, so the whole first-run and sign-in state is one read, and the wizard extends one table. The recovery hash lives here and not in `admin_credentials` because recovery and the manual recovery steps replace or delete the `admin_credentials` row and the recovery code must outlive that.) The wizard's own columns (`access_app_id`, `access_policy_id`, `admin_emails`, `verify_nonce`, `verify_nonce_expires_at`, `verified_at`, `verified_config_hash`) are added by its migration `0020` with `ALTER TABLE ... ADD COLUMN`; `0019` already carries the columns and the `CHECK` the wizard's design asks for.

- On a **fresh Deploy button run** the migrations run in the build, so `opened_at` is the moment the database is built, about a minute before the code goes live.
- `N = 30` minutes lives in code (`CLAIM_WINDOW_MINUTES`). Expiry is computed on read (`now - opened_at`), so no scheduled job is needed. It is not a variable: another setting is another thing to explain, and the old `SETUP_CODE` path covers anyone who needs longer.
- A later push to the repo redeploys but does not re-run `0019`, so a redeploy does **not** reopen the window.
- **Existing v1.1 deployments** get the migration when they update. The window opens only for a site with no admin and no `SETUP_CODE`, which is a site that today answers 503 on every admin page. Under Access, with env credentials, or with an admin already signed in, `setupState` is `closed` and the window is irrelevant. Note this in "Upgrading".
- **Reopening** with no `SETUP_CODE`: someone with the club's Cloudflare account runs one statement in the D1 console (documented in `handover.md`):
  `UPDATE auth_settings SET setup_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), claim_token_hash = NULL, recovery_hash = NULL, recovery_created_at = NULL;`
  Delete the `admin_credentials` row first if an admin had been made. Run the full statement, after deleting that row, whenever the recovery code may be compromised, because an old recovery code still works at any time and can create a new admin in the empty site. This is the same trust level as the existing recovery steps.

### 3.2 States

`setupState` (`src/server/setup.ts:22`) today returns `closed | not_ready | open`. It gains two states. Decision order:

| Condition (checked in this order) | State | `/setup` | `POST /api/setup` | `/admin*` when signed out |
|---|---|---|---|---|
| Not the password provider, or env credentials set, or `first_login_at` set | `closed` | 404 | 404 | as today |
| `SETUP_CODE` set and 12+ characters | `open` (v1.1, unchanged) | page asks for the code | code flow, unchanged | 302 to `/setup` |
| `SETUP_CODE` set but too short | `not_ready` | 503, as today | 503 | 503 |
| No `SETUP_CODE`, no `admin_credentials` row, within the window | **`claim`** | page with one button | claim (3.3) | 302 to `/setup`; `/` too (3.4) |
| No `SETUP_CODE`, a row exists, `first_login_at` empty | **`claimed`** | with the claim cookie: page offers a new secret. Without it: "This site has already been set up. Sign in." | with the cookie: replace the secret. Without: 409 | `/admin/login` |
| No `SETUP_CODE`, no row, window expired | `not_ready` | 503 with new wording (3.5) | 503 | 503 |

C3 in this table: a set `SETUP_CODE` wins, so the strict behaviour is one Worker secret away and every existing deployment is untouched. The cost is that "code **and** window" is not offered; that would mean explaining two ways in.

### 3.3 The claim

- `GET /setup` in state `claim` serves a page that says what is about to happen and has one button, "Create my admin secret". **Nothing is created by a GET** (C5). `GET /` and `GET /admin` only redirect.
- The button sends `POST /api/setup` with a `{}` JSON body. The handler, in order: state is `claim`; same-origin (`hasSameOrigin`); then one atomic statement:

  ```sql
  INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at)
  SELECT 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admin_credentials)
  RETURNING id
  ```

  together with setting `claim_token_hash` in the same `db.batch`. If it returns no row, someone else won the race: answer 409 "already set up". Today's two concurrent setups both succeed and the last write wins (`src/server/auth/credentials.ts:25-31`, no test for it), so this is stricter than v1.1 on purpose.
- The response returns the secret **and a recovery code (3.6)** once, exactly as now, and sets a cookie `__Host-sb_claim` (random 256-bit token, `HttpOnly; Secure; SameSite=Strict; Path=/`, same attributes as `__Host-sb_admin`). Only the token's hash is stored.
- State `claimed` with a matching cookie lets the same browser ask for a replacement secret (a closed tab, a reload, a lost clipboard). Without it, nobody can replace the claim without `SETUP_CODE` or the D1 console. This is C4. The price: if an attacker claims first, the owner is locked out and must use the recovery routes.
- Sign-in with the claimed secret works at any time, **even after the window expires**. The window limits only the creation of a first secret. The first successful sign-in sets `first_login_at`, which is `closed`, as now.
- No per-client or global attempt limit on the claim: there is no code to guess. The cap on `POST /api/setup` for the code flow is unchanged. (Note `setupClientKey` is keyed by `SETUP_CODE`, `src/server/auth/ratelimit.ts:75-77`, so it cannot be used when none is set; it does not need to be.)

### 3.4 Redirects

- `/admin` and `/admin/*` pages: extend the existing branch in `src/worker/guards.ts:53` (`awaitingSetup && state === "open"`) to `open | claim`. This stays authoritative: it reads D1 every time (via `adminAuthFor`, `src/server/auth/index.ts:33`).
- `/`: in `serveLandingPage` (`src/worker/static.ts:14`), for `GET`/`HEAD` of the exact path `/`, state `claim` gives `302 /setup` with `Cache-Control: no-store`. `/e/*`, `/api/*` and everything else are untouched, so a link already shared still works. `/` already reads D1 for the page tags (`serveWithTags` takes `env.DB`), so I expect to fold the check into that read; **I have not verified the statement count**, and `src/test/statement-counts.test.ts` should be checked. A per-isolate memo of "no longer claimable" is a fallback; it is safe because it only affects this convenience redirect, never `/admin`.

### 3.5 Wording

- Expired with nothing claimed: "Setup is closed. The first-run window ended, so nobody can create an admin secret from the web any more. To reopen it, set SETUP_CODE as a Worker secret (any phrase of 12 or more characters) and reload this page, or follow the handover guide (docs/handover.md in your copy of the project)." (This replaces the text at `src/worker/static.ts:46`, which today names only `SETUP_CODE`.)
- Claim page, in plain words: "This site has no admin yet. Press the button to make your admin secret and a recovery code. Both are shown once. Save both in a password manager before you leave this page."

### 3.6 Recovery code and `/recover` (added at approval)

**Made with the secret.** The claim (3.3) and the code flow (state `open`) both generate, in one batch with the admin credentials, a recovery code of the same kind as the admin secret (32 random bytes, 43 characters, `generateAdminSecret`) and store only its hash (`hashAdminSecret`, the `hmac-sha256$<salt>$<mac>` form) in `auth_settings.recovery_hash`. One screen shows both with a copy button each and a single "I've saved both" tick before "Go to sign in". Both flows use one shared function, so the screen is the same. A re-shown claim (the claim cookie, 3.3) replaces both, as it replaces the secret now. The pair is written in one batch, ordered so a lost race leaves no orphan row; the plan must specify the ordering, and a test must show concurrent claims leave exactly one matching pair.

**Use.** `GET /recover` serves a page (`public/recover.html`, `recover.js`) with one field, "Recovery code". `POST /api/recover` (same-origin JSON), in order:

1. 404 if `auth_settings.recovery_hash` is empty (nothing to recover with), or if `ADMIN_PASSWORD_HASH` or `ADMIN_SESSION_SECRET` is set (the env override mode has no stored credentials to replace).
2. Per-client attempt limit only, no global cap, as the wizard decided for recovery (`access-wizard.md` lines 171-184), because a global cap would let anyone block the owner from the one route meant for the worst day. The key is domain-separated from sign-in and setup, and keyed with the stored recovery hash (`recoveryClientKey`, `src/server/auth/ratelimit.ts`), so it changes when the code does. A 256-bit code makes guessing hopeless; the limit is there to bound cost and noise.
3. Constant-time check against the stored hash.
4. On a match, **one guarded batch**: replace the recovery code hash (compare-and-set on the old hash, so a second concurrent use of the same code fails), then replace `admin_credentials` with a new secret hash and a new session secret (which signs out every existing session). `first_login_at` is left as it is, so `/setup` stays closed. Under Access, the same step also does what the wizard's break-glass does (`access-wizard.md` lines 166-169): switch the mode back to the password and record `changed_by = 'recovery'`. The old secret is never reused.
5. The response returns the **new admin secret and a new recovery code**, once, on the same "save these now" screen. The old recovery code no longer works.

**Reach.** `/recover` is a new path, so `run_worker_first` in `wrangler.jsonc` gains `"/recover"` (and `/api/recover` is already covered by `/api/*`); `src/test/wrangler-config.test.ts:39` pins that list and changes. It is served on both `workers.dev` and the custom domain, and passes through Access's four admin paths untouched (as `/setup` does in the wizard design, line 202). The claim window plays no part: a recovery code works at any time.

**Deployments that already have an admin and no recovery code** (every v1.0 and v1.1 site that has signed in): none exists until one is made. Proposed small addition, **needed only for the wizard**: `POST /api/admin/recovery-code`, a signed-in password-mode admin action (CSRF-protected like the other admin writes) that makes and shows a recovery code once, replacing any earlier one. It gets a button on the admin settings page. It is not in the first release unless the wizard ships with it.

**Relation to `SETUP_CODE`.** Both can exist. `SETUP_CODE` keeps its v1.1 meaning (C3); the recovery code is the default for people who never chose one. The wizard's break-glass requirement is met by either: "`SETUP_CODE` set and 12+ characters, **or** `auth_settings.recovery_hash` is set".

### 3.7 Three changes that followed from the probe (approved by the owner on 22 October 2026)

**(a) `ADMIN_AUTH` leaves `wrangler.jsonc` and is defaulted in code.** The form shows every plain `vars` entry as an editable field (2.1), so `"vars": { "ADMIN_AUTH": "password" }` puts a technical-looking box in front of a non-technical organiser. Remove it, in the production block and in `env.preview`, and let the Worker treat a variable that is **not set at all** (`undefined`) as `"password"`.

- Code: three places read it (`src/server/setup.ts:23`, `src/server/auth/index.ts:22` and `:27`, with the error text at `:39`). They are replaced by the resolution rule in 3.8, which writes the default once and also puts the sign-in mode in D1.
- **Only `undefined` defaults.** A misspelt or empty value (`Password`, `none`, ` access`, an empty string) still fails closed with the same 503, as `docs/admin-auth.md:8` promises. That sentence changes from "if `ADMIN_AUTH` is unset, misspelt … every admin page … fails" to "if it is **set** to anything but `access` or `password`".
- **Cost, and how 3.8 removes it.** With only a code default, a site on Access whose `ADMIN_AUTH=access` line is lost would silently fall back to the password sign-in, and an admin secret made before the switch (still in D1, `docs/admin-auth.md:171`) would be accepted. 3.8 stores the mode in D1 and pins an env-configured Access site there the first time an admin signs in through it, so the lost line no longer changes anything. A site that has never had an admin sign in through Access is not pinned; for it the downgrade is still possible, and the docs say so.
- **Existing deployments.** Anyone on Access has `ADMIN_AUTH=access` in their own copy of `wrangler.jsonc` (that is how `docs/deploying.md:172` told them to do it). Updating from the template then conflicts on the `vars` line; "Updating your copy" must say: keep your `vars`, nothing else changes. Everyone on password mode can delete the line or keep it; both work.
- `configure` (`scripts/configure-core.ts`): `buildConfig` must create `vars` when a club's `account.local.json` supplies some, because the template no longer has any. I have not read that code, so how much of `src/test/configure.test.ts` changes is **unknown**; see section 7.
- **Not verified:** that removing `vars` removes the field from the form. It follows from "plain vars are shown", but only the implemented branch's run can prove it (8.2, step 1).

**(b) The window clock.** In the probe, the migrations ran from about 07:22:27 to 07:22:53 and the Worker was live at 07:23:09, **about 16 seconds after the migrations**; the whole deploy took 45 seconds. `0019` stamps `opened_at` while the migrations run, so the window starts about 16 to 40 seconds before the site answers. 30 minutes (C1) is ample for the deploy itself. The real risk to the window is **not finding the address** (next point), not the deploy.

**(c) `/` is the entry point; the README says where the address is.** Nothing on the completion screen shows the address (2.1), so an organiser has to find it. The README and `docs/deploying.md` say, in this order: the address is at the end of the build log; or, in the Cloudflare dashboard, open **Workers & Pages**, then your Worker (named as you named the project); its page shows the `workers.dev` address (menu names **unverified**; check them on the next run). Open that address, not `/setup`: `/` redirects to the claim page (3.4) while the window is open. If the window has run out, the page says how to reopen it (3.5).

### 3.8 Sign-in mode in D1, shared with the Access wizard (added 22 October 2026)

The owner's requirement: the sign-in mode is stored in D1, and the env variable is only an override, so an Access site cannot silently fall back to the password sign-in if a config line is lost. This is the wizard's own model (`access-wizard.md` lines 13 and 53-66), brought forward into `0019` so the two designs share **one** table, `auth_settings`, and one resolution rule.

| env `ADMIN_AUTH` | D1 `mode` | Result |
|---|---|---|
| `access` | any | Access, with `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` **from env**, exactly as today (fails closed if invalid). D1 is not read for the decision. |
| unset, or `password` | `access` | Access, with the three values **from D1**. |
| unset, or `password` | `password` | Password, as today (env credentials, else `admin_credentials`). |
| anything else, including an empty string | any | 503 `not_configured`, as today. |

- **Source chosen whole.** Values are never mixed field by field between env and D1.
- **D1 beats env password credentials.** If `mode = 'access'`, leftover `ADMIN_PASSWORD_HASH` or `ADMIN_SESSION_SECRET` secrets are not used. This changes the sentence in `docs/admin-auth.md:50` ("D1 is never read" in the override mode): D1 is now read for the mode, and only the mode.
- **Pinning.** The first time an admin is authenticated through an env-configured Access (`ADMIN_AUTH=access`), the `GET /api/admin/session` handler copies the env values and the request's hostname into `auth_settings` (`mode = 'access'`, `changed_by = 'import'`), only if D1 does not already hold exactly those values. From then on a lost env line changes nothing. This does the job of the wizard's "Import" button automatically, and only after a real Access sign-in has reached the Worker, which is the wizard's own evidence that the settings work.
- **Exit from Access.** Because "unset or `password`" defers to D1, editing `ADMIN_AUTH` back to `password` no longer leaves Access. The ways back are `/recover` (3.6, which sets `mode = 'password'` and `changed_by = 'recovery'`), the D1 statement `UPDATE auth_settings SET mode = 'password', changed_by = 'owner' WHERE id = 1;` in the handover, and later the wizard's "Switch back to password". If the env still says `access`, `/recover` says so and tells the owner to remove that line too, because env wins.
- **Cost.** Admin requests in password or unset mode read `auth_settings` and `admin_credentials` in one `db.batch` (today one read). Env-Access requests read nothing, as today. Public pages are not touched: `/`'s claim check is cached per isolate for 60 seconds (the wizard states the same rule for its own redirect).
- **The preview environment** has its own database, so its own row, and stays on its own settings.

## 4. Threat model

**What is being protected.** The first admin secret of a brand-new, empty site. An attacker who claims it controls the club's admin pages: events, bookings and, from then on, the booker details entered later.

**The attack.** Between database creation and the owner's first visit, anyone who can guess the `workers.dev` address presses the button first.

| Fact | Basis |
|---|---|
| The address is `<worker-name>.<account-subdomain>.workers.dev`. | `docs/deploying.md` ("Deploy with the button", step 4). |
| The Worker name is almost always the suggested default (`slot-booker`), so the attacker must find the **account subdomain**. | The form suggests the name; the README says "The suggested name is fine". |
| Whether the account subdomain can be enumerated (guessing, DNS data, Certificate Transparency, scanners) is **unverified**. | I did not research this. Treat the address as guessable by a motivated attacker and as not listed anywhere obvious. |
| The window is at most 30 minutes, and the site has no data in it. | Design. |

**Impact if it happens.** Medium, bounded. No booker data exists yet. The attacker can sign in and the owner is locked out. The owner finds out quickly: their own visit shows "already set up" instead of the claim page. They then recover with `SETUP_CODE`, the D1 console, or by deleting the Worker and deploying again with a different Worker name (a few minutes, no data lost).

**Mitigations, in the order they matter**

1. **Short, fixed window, started by the migration (C1, C2).** An outsider can neither start nor extend it. A redeploy does not reopen it.
2. **One-shot claim with an atomic gate (C4).** Exactly one winner. A second visitor cannot overwrite the owner's saved-but-not-yet-used secret, which is the nastiest variant (a silent swap). It fails loudly instead.
3. **Claim by POST only, same-origin (C5).** Crawlers, link unfurlers and uptime checks that `GET /` cannot claim the site.
4. **Claim cookie.** Only the browser that claimed can ask for a replacement.
5. **Opt-out.** Set `SETUP_CODE` before the first visit and the window is off (C3). Anyone worried about the risk keeps v1.1's behaviour. The README says how, in one line.
6. **Visibility.** The owner sees a failure at once. I propose to also show the claim time on the first admin page ("Admin secret created on <time>") so an attacker's early claim shows even to an owner who signs in with a stolen-then-reused secret. That needs a column; **not in this design, offered as a possible extra.**
7. **No leakage in the redirect.** Only `/` (GET/HEAD) and the admin pages redirect, `no-store`. The public API and event pages are untouched. GET /api/setup is a new public read-only status route; it says which form to show and nothing more than /setup itself shows.

**What this does not fix.** An attacker who is already watching the account's `workers.dev` address and reacts within the window still wins a race the owner is not aware of. That is the price of "no code to type". Mitigation 5 exists for them.

**The recovery code is a second bearer credential (3.6).** Whoever holds it can reset the admin secret, which is as powerful as holding the secret, and it works at any time, with or without the window. It is stored only as a hash, shown once, and is single-use: using it makes a new one, so a code that has been used is worthless. The cost is the same as for the secret: if it leaks, the owner is locked out until they recover by other means, and because the attacker's use consumes the code, the owner's copy stops working too. The screen and the docs say to keep the two apart if the password manager allows. `/recover` is limited per client, never by a global cap, so nobody can block the owner from it; the code has 256 bits, so guessing is not the risk. A stolen recovery code is still a full takeover; it cannot be made safer without a second factor, which this design does not add.

Also, `session_secret` is stored in plaintext in D1 (`migrations/0013:13`); it is pre-existing and unchanged here.

**Why not weaker or stronger.** No window at all (claim open until first sign-in) is worse: a Worker left alone for days is a standing invitation. A longer window helps slow organisers and hurts everyone else. A code is the safest and is exactly what this removes.

## 5. Interaction with `docs/design/access-wizard.md`

That file is **not on `main`**. It lives on the branch `docs/access-wizard-design` (commit `791f358`, design only), so links to it from this branch would dangle; I read it with `git show` and cite its line numbers.

| Wizard assumption | Effect of this design | What to do |
|---|---|---|
| "`SETUP_CODE` is already a required Worker secret (the Deploy button prompts for it)" (line 164). | **No longer true** for new deployments. | Rewrite that sentence. |
| "`SETUP_CODE` stays as break-glass, always on in v1" (line 16); D5: "always on whenever `SETUP_CODE` is set and valid" (line 29). | Still consistent, and this design keeps the same rule (C3). But most new deployments will have **no** `SETUP_CODE`, so break-glass will not exist for them. | **Resolved by the recovery code (C7, C8).** Break-glass is "`SETUP_CODE` set and 12+ characters, **or** `auth_settings.recovery_hash` is set". The wizard **requires one of them before it lets the owner turn on Access**. A new deployment has a recovery code from its first screen. An older site with neither is sent to the signed-in "make a recovery code" action (3.6) first. No Worker secret has to be set, so the open question of whether the wizard's API token could set one no longer matters. |
| Recovery deletes the `admin_credentials` row so `/setup` issues a new secret (lines 166-167). | Under this design the same effect is available without `SETUP_CODE`: `/recover` with the recovery code replaces the secret and, under Access, switches back to the password (3.6, steps 4-5). The `SETUP_CODE` route (state `open`) is unchanged. | Wizard text: add `/recover` as the main route; `SETUP_CODE` becomes the alternative. The wizard's rate-limit rule (per client only, lines 171-184) is the one `/recover` uses. |
| Last resort: a D1-console statement (lines 190, 285). | Still the final fallback, now for the day the recovery code is lost as well. | Add the `auth_settings` reset from 3.1 to the handover text so the console route also reopens the claim. |
| Migration `0019` (line 35) and the `auth_settings` table (lines 35-47). | **Decided: zero-config takes `0019` and creates `auth_settings` with the mode columns, their `CHECK`, `changed_at` and `changed_by`, plus the claim and recovery columns (3.1).** The wizard's migration becomes `0020` and only adds its own columns with `ALTER TABLE ... ADD COLUMN`. | Wizard text: say the table already exists and list only the columns `0020` adds; renumber its test to `migration-0020.test.ts`. |
| "First-run `/setup` keeps its present limits, global cap included" (line 184). | Still true for the code flow; the claim flow has none. | One sentence. |
| The wizard drops `vars.ADMIN_AUTH` from `wrangler.jsonc` too (line 13, 71), resolves the mode from env plus D1 (the table at line 55), and has an "Import" button for env-Access sites. | **Decided: the two designs share one model, and zero-config ships it first (3.8).** Zero-config removes the `vars` line, creates `auth_settings`, implements the table at line 55, and pins env-Access sites automatically after a verified sign-in (so the Import button is not needed for them). | Wizard text: say the resolution rule and the table already exist; keep its Import button only if it still has a use (an env-Access site that nobody has signed in to yet). |
| The wizard's `/setup` "Recover sign-in" form under Access mode (line 166). | Independent of the claim window: under Access the state is `closed`. | None; keep in mind the page serves both. |

## 6. Options considered

- **A. Claim window (this proposal).** Zero typing. Costs a short race (section 4).
- **B. One honest field: "Choose an admin password".** An `ADMIN_PASSWORD` secret typed in the form, hashed by the Worker at first use. Works with documented button behaviour only if the form lets you proceed, and still makes the organiser invent and remember something. Also a bigger code change (the override path takes a pre-hashed value). **Not needed: P1 showed the button accepts a repo with no secret field (2.1).**
- **C. Keep `SETUP_CODE`, add a placeholder default.** Weakest: a published default is a published password.
- **D. `secrets.required` or platform-generated secrets.** Not documented for the button; `secrets.required` would fail the build when unset (section 2).
- **E. Cloudflare Access by default.** Needs a custom domain and an Access app first, which is the barrier we are removing (`docs/admin-auth.md`).

## 7. Every doc and test that would change

Produced by a search of the repo (`grep -rn` for `SETUP_CODE`, `/setup`, "setup code", "first run" in `README.md`, `docs/`, `public/`, `src/`, `scripts/`, `package.json`, `.dev.vars.example`). Line numbers are from `main`. A final sweep with the same search is part of the implementation checklist.

**Documentation**

| File | What changes |
|---|---|
| `README.md` "What the form asks for" (l.16-31) | Remove item 4 and renumber. Add a line: "There is no password to choose here." |
| `README.md` "First run: `/setup`" (l.33-45) | Rewrite: open your site, press the button, save the secret **and the recovery code**. Explain the 30 minutes, what "already set up" means, `/recover`, and `SETUP_CODE` as the opt-out and as the way to reopen. |
| `README.md` l.92 "Work in progress" | Update the end-to-end run record after the new run. |
| `docs/deploying.md` | "Before you start" (l.30, delete the code paragraph); step 4 prompts (l.40); step 7 (l.44-56); "Check that it works" (l.65); CLI step 6 and 7 (l.147-155) and local dev (l.157, 192); troubleshooting sections `/setup says "Setup isn't ready"` (l.235), `"Admin sign-in isn't set up"` (l.244), `already been completed` (l.256), `"That setup code isn't right."` (l.260), local `/setup` 404s (l.297); "Upgrading" (add what the window means for an existing site; add a "Upgrading from v1.1"). |
| `docs/admin-auth.md` | Settings table row for `SETUP_CODE` (l.25: "yes" becomes "no"); "First-run setup" section (l.35-53), a full rewrite; the "closed" and "replaces" rules; `/setup` under Access (l.51) unchanged; the rate-limit and 503 wording. |
| `docs/admin-guide.md` (l.31-42) | The "first time" steps for a non-technical admin, now without a code. |
| `docs/handover.md` | The secrets table (l.26-27), Step B (l.52-54), "If the admin secret is lost" (l.110-138, especially steps 2-4), the tables of what lives where (l.239-247). Lead the recovery section with `/recover`; add the `auth_settings` reset and the Access exit statement (3.8); list `auth_settings` in the tables of what lives where; add "keep the recovery code" to "What the club must keep safe" (l.18-29). |
| `docs/development.md` (l.21, 29-31) | `.dev.vars` no longer needs a code; say the local database also gets a 30-minute window, then needs a code, and where the local reset is. |
| `docs/configuration.md` (l.3) | A pointer sentence only. |
| `docs/sign-in.md` (l.5) | Describe the default without "the setup code". |
| `docs/known-limits.md` (l.12) | The rate-limit sentence; add a "claim race" limit. |
| `docs/costs.md` | Only if the `/` check adds a D1 read (3.4). |
| `wrangler.jsonc` | Remove `"vars": { "ADMIN_AUTH": "password" }` in the production block and in `env.preview` (3.7 (a)), and rewrite the comment above it (l.32-35). `account.local.example.json` (l.8, 11) keeps its examples. |
| `README.md` "What the form asks for" | Besides item 4 going: **rewrite the whole list from a fresh look at the form** (2.1). The observed form has no "Protect with Cloudflare Access" or "Enable Preview builds" switches (README item 5), and has a private-repo checkbox, a D1 location hint, a read-replication checkbox and the build and deploy commands. Add the project-name rule (project = Worker = repo name) and where to find the address (3.7 (c)). |
| `docs/admin-auth.md` (l.8, 22, 31, 85, 171) | Fail-closed wording for `ADMIN_AUTH` (3.7 (a)); settings table (l.22: "`wrangler.jsonc` sets `password`" becomes "unset means `password`"); l.31 (plain variables and deploys); l.85; the Access downgrade note. |
| `docs/deploying.md` (l.52, 124, 172) | `wrangler.jsonc` no longer sets `ADMIN_AUTH`; the Access steps say to **add** it, and "Updating your copy" says to keep it. |
| `docs/configuration.md` (l.3, 30, 43-44), `docs/sign-in.md` (l.5), `docs/handover.md` (l.187), `.dev.vars.example` (l.14-15) | Same wording change: nothing sets `ADMIN_AUTH` for a password site any more. |
| `src/server/auth/index.ts`, `src/server/setup.ts`, new `src/server/auth/settings.ts` | The resolution rule and the D1 settings row (3.8); `src/server/env.ts` unchanged. |
| `.dev.vars.example` | Comment `SETUP_CODE=` out, reword it ("optional: recovery and strict setup"), keep every other comment line. |
| `package.json` `cloudflare.bindings.SETUP_CODE` (l.40-42) | Remove, if the live line goes (the test requires it). |
| `docs/design/access-wizard.md` | On its own branch, per section 5. |

**Code**

`src/server/setup.ts` (new states, window check, `now` injected for tests); `src/routes/api/setup.ts` (claim branch, cookie); `src/server/auth/credentials.ts` (an atomic claim function); `src/worker/guards.ts:53`; `src/worker/static.ts:14` and `:43-50`; `public/setup.html` and `public/setup.js` (claim page, "already set up" page); `migrations/0019_auth_settings.sql`; and `scripts/configure-core.ts:48` (the `SECRET_VARS` set keeps `SETUP_CODE`, which is still a secret).

**Tests**

| Test file | Change |
|---|---|
| `src/test/deploy-button.test.ts` (`:76-79`), `src/test/configure.test.ts` (`:82-84, :199-206, :219-238, :284-288, :299-323, :345-358`) | The two `vars` equal `{ ADMIN_AUTH: "password" }` tests become "no `vars`" (and "the form shows no plain variable"). `configure.test.ts` pins the template's `vars` in many places; **how much changes depends on `buildConfig`, which I have not read**. |
| `src/server/auth/index.test.ts`, `src/server/setup.test.ts`, `src/worker/guards-*.test.ts`, `src/worker/worker.test.ts` | New: `ADMIN_AUTH` unset behaves as `password`; set to `Password`, `none`, an empty string or ` access` still fails closed; `access` unchanged. These files already inject `ADMIN_AUTH` through the harness (`src/server/auth/test-harness.ts:22, 27, 46`). |
| `src/test/deploy-button.test.ts` | `:83-85` ("exactly one live line, `SETUP_CODE`") becomes zero live lines. `:96` and `:100` (descriptions match live keys) still hold, for `DB` only. `:115` (SETUP_CODE description mentions 12, private, `/setup`) is deleted. `:25-27` (deploy order) unchanged. |
| `src/server/setup.test.ts` | New states and decision order; window edges (29:59, 30:00); `SETUP_CODE` wins over the window. Existing cases (`:47-60` and the rest) stay for the code path. |
| `src/routes/api/setup.test.ts` | New: claim wins once; concurrent claims, exactly one 200; GET never claims; same-origin; claim cookie replace and refuse; sign-in after window expiry works. The code-flow cases stay. |
| `public/setup.test.ts` | Claim markup and POST shape; "already set up" page. Existing code-form tests stay. |
| `src/worker/guards-pages.test.ts` (`:95-117`) | Redirect in `claim`; 503 with no redirect when expired. |
| `src/worker/worker.test.ts` (`:532-690`) | `/setup` 503 text no longer says only `SETUP_CODE`; `/` redirect in `claim` only; HEAD, 405s, `no-store`. |
| `src/worker/routes.test.ts` (`:11, :47, :76`), `src/test/wrangler-config.test.ts` (`:39`) | **Change** (this was "no change" before the recovery code): `/recover` and `POST /api/recover` are new routes, and `run_worker_first` gains `"/recover"`. The claim itself reuses `/setup` and `POST /api/setup`. |
| New: `src/routes/api/recover.test.ts`, `public/recover.test.ts`, `src/server/recovery.test.ts` | `/recover`: 404 with no code row; wrong code 401; per-client limit and **no** global cap; a right code replaces the secret and the session secret, makes a new code, and the old code then fails; two concurrent uses of one code, exactly one wins; works after the window, under Access (mode switched back, `changed_by = 'recovery'`) and in password mode; the secret and the code never reach `console.*` or a D1 write unhashed. Shared "save these now" page markup and the single tick. |
| `src/test/migration-0019.test.ts` | Covers `auth_settings`: one row at most, `id = 1`, the `mode` and `changed_by` checks, the `access` row refused unless team domain, AUD and hostname are set, the recovery hash prefix check, `setup_opened_at` a valid ISO time, the row present after a fresh migrate. |
| `docs/design/access-wizard.md` (other branch) | Its break-glass requirement test is "`SETUP_CODE` valid **or** a recovery row exists". |
| New code | `src/server/recovery.ts`, `src/routes/api/recover.ts`, `public/recover.html`, `public/recover.js`, a `recoveryClientKey` next to `clientKey`, and a shared "save these now" renderer used by `public/setup.js` and `public/recover.js`; later, `POST /api/admin/recovery-code` and its settings button. |
| `src/server/auth/test-harness.ts`, `src/server/auth/credentials.test.ts`, `src/server/auth/index.test.ts` | Add a no-`SETUP_CODE` environment helper; atomic claim races; `awaitingSetup` unchanged. |
| `src/server/auth/ratelimit.test.ts` (`:213`), `src/test/configure.test.ts` (`:119, :137`) | Should not change (the code flow and secret refusal stay). Re-run to confirm. |
| `src/routes/api/admin/login.test.ts` (`:256-284`), `src/test/migration-0013.test.ts`, `src/test/global-setup.ts` | Should not change. `global-setup.ts` applies the real migrations, so `0019` is exercised implicitly. |
| `src/test/statement-counts.test.ts` | Check whether the landing route is covered; if the `/` check adds a statement, update the ceiling and `docs/known-limits.md`. |

I list as "should not change" only what I could reason about from the agent's map and a few reads. Running the full suite after the change is the real check.

## 8. Deploy button runs

### 8.1 Probe P1: done, passed (22 October 2026)

Question: does the button work, with no secret field, for a repo whose `.dev.vars.example` has **zero live lines** and whose `package.json` has no `SETUP_CODE` binding?

Setup: a throwaway **public** repo under the owner's GitHub account, a copy of v1.1 (`git archive v1.1`) with only these differences: `SETUP_CODE=` commented out in `.dev.vars.example`; the `SETUP_CODE` entry removed from `cloudflare.bindings`; unique Worker and database names in `wrangler.jsonc` (`sb-probe-p1`, `sb-probe-p1-db`, `sb-probe-p1-db-preview`). The owner ran it on their own Cloudflare account, accepting the defaults. P0 (v1.1 unchanged) and P2 (no example file) were not needed and were not run.

Result, as reported by the owner (07:21 to 07:25 AWST, 22 October 2026):

| Item | Result |
|---|---|
| Secret field on the form | **None.** |
| Commented-out names on the form | None. |
| Build | Deploy pressed about 07:22:27; migrations `0001` to `0018` all applied (one `wrangler d1 migrations apply` run) by 07:22:53; Worker deployed 07:23:09; **45 seconds in total**. |
| Bindings | `DB`, `ASSETS`, `ADMIN_AUTH="password"`. No `SETUP_CODE`. |
| Address | Only in the build log. |
| `/`, `/admin`, `/setup` | As expected for v1.1 with no code (2.1). |

**Decision (rule from the earlier draft of this section): P1 passes, so implement as designed. No example-file fallback (P2) and no option B.** Section 2.1 records everything else the run showed, and 3.7 the three design changes it caused.

**Not covered by P1**, because it ran v1.1 code: the claim, `/recover`, the redirect, window expiry. Those are proved by the post-implementation run.

### 8.2 After implementation: one run on the real branch

On a fresh database (new Worker and database names, so nothing is reused), accepting every default:

1. The form has **no `ADMIN_AUTH` field** and no secret field (this proves 3.7 (a)'s unverified step).
2. `/` redirects to the claim page; `/setup` GET does not claim; one press of the button shows the secret **and** the recovery code on one screen.
3. A second browser is refused ("already set up"); the first browser, with its claim cookie, can ask for a replacement before signing in.
4. Sign-in works; `/setup` is then 404.
5. `/recover`: a wrong code is refused; the right code gives a new secret and a new code, and the old code and old sessions stop working.
6. Window expiry: age `opened_at` in the D1 console (do not wait 30 minutes), check the page says how to reopen, then reopen with the statement in 3.1.
7. A push to the copy repo redeploys without reopening the window.
8. Write down where the README's menu names for finding the address were right or wrong (3.7 (c)), and what the form's switches look like (2.1: the README's Access and Preview switches were not seen).

Clean-up of anything created is part of each run: the source repo, the copy repo, the Worker and the database. Do not paste any secret into notes; record only that it was shown once.

## 9. Decisions (approved 21 and 22 October 2026)

1. **N = 30 minutes** (C1). Approved.
2. **`SETUP_CODE` set means the window is off** (C3). Approved. The code can still reopen setup after expiry, because setting it moves the state to `open`.
3. **Claim cookie and one-shot claim** (C4). Approved.
4. **Run the probe before implementing.** Approved and done: P1 passed (8.1).
5. **Migration number:** zero-config takes `0019`; the wizard branch renumbers to `0020`. Approved.
6. **No "Admin secret created at <time>" line** on the first admin page. Approved as left out.
7. **Recovery code and `/recover`** (C7, C8), added by the owner at approval: section 3.6. Whether the signed-in "make a recovery code" action (for existing sites) ships in the first release or with the wizard is **left to the plan**; it is needed only by the wizard.
8. **P1 passed: implement as designed** (22 October 2026), with the three changes in 3.7: `ADMIN_AUTH` out of `wrangler.jsonc` and defaulted in code (only when unset), the window clock left at 30 minutes, and `/` plus README guidance for finding the address.
9. **Shared settings model** (22 October 2026, requested with the plan): the sign-in mode lives in D1 with env as an override (3.8); `auth_settings` also holds the claim window and recovery hash; `0019` creates it, the wizard's `0020` extends it.

## 10. What I did not verify

- Section 2 rows still marked **Unverified**: prefilled or optional secrets and a blank live line (not tested: no secret field existed in P1; P0 was not run). "Commented lines are ignored" and "zero live lines works" are **observed once** (P1), not documented.
- That removing `vars` removes the `ADMIN_AUTH` field from the form (3.7 (a)); the dashboard menu names in 3.7 (c).
- How `buildConfig` (`scripts/configure-core.ts`) copes with a template that has no `vars`.
- Whether the `workers.dev` account subdomain can be enumerated (section 4).
- Whether a tag or branch can be named in the button URL.
- That the extra `/` check keeps within the D1 statement counts.
- That "should not change" tests really do not change; no code was run, no tests were run, and no change was made outside this file.
- The code facts come from a read of `src/server/setup.ts`, `src/routes/api/setup.ts`, `src/server/auth/credentials.ts`, `src/server/auth/index.ts`, `src/worker/guards.ts`, `src/worker/static.ts`, `migrations/0013_admin_credentials.sql`, `package.json`, `wrangler.jsonc`, `src/test/deploy-button.test.ts` and `src/server/auth/ratelimit.ts` (by me), plus a map by a subagent for the rest (test inventory line numbers in particular).

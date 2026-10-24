# Admin sign-in

Everything under `/admin/*` (the pages) and `/api/admin/*` (the API) is for the club's organisers. People who book can't move or cancel bookings; only an admin can. Sign-in is pluggable: one `AdminAuth` interface (`src/server/auth/types.ts`) with two providers, chosen by configuration:

- **`access`**: Cloudflare Access sits in front of the site and the Worker verifies the signed token Access adds. The admin's identity is the verified email address. It needs a custom domain (see the hard rule below).
- **`password`**: one shared, generated admin secret, checked by the Worker, which then issues a signed session cookie. The identity is the fixed string `admin`. It is the default (an unset `ADMIN_AUTH` means `password`), and the option for local development, for previews and for deployments reachable only on `*.workers.dev`. A new deployment makes its secret, and a recovery code, on the `/setup` page (see "First-run setup").

It fails closed. An **unset** `ADMIN_AUTH` is fine: it means `password`. But if `ADMIN_AUTH` is **set** to anything other than `access` or `password` (misspelt, such as `Password`, `none` or ` access`, or an empty value), or the chosen provider's settings are missing or malformed, **every** admin page and `/api/admin/*` request, including paths that don't exist, gets a 503 and a line in the logs saying which setting is wrong. The other provider's settings are never used as a fallback. With the password provider and no admin secret yet, the answer is the same 503, except that a request for an admin page is sent to `/setup` while setup is open (see "First-run setup").

### Which sign-in a site uses

The site stores its sign-in mode in the database (the `auth_settings` table, one row), and the `ADMIN_AUTH` variable is only an override. In plain words:

| `ADMIN_AUTH` | Stored mode | What the site does |
| --- | --- | --- |
| `access` | anything | Access, with `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` taken from the variables, as before (a 503 if they are not usable). The database is not read for this decision. |
| unset, or `password` | `access` | Access, with the three values (team domain, AUD and hostname) taken from the database. |
| unset, or `password` | `password` | The password sign-in, as before: the secrets in `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` if set, otherwise the admin secret made on `/setup`. |
| anything else, including an empty value | anything | A 503 on every admin request. |

The three Access values are taken from one place or the other, never mixed. If the stored mode is `access`, a leftover `ADMIN_PASSWORD_HASH` or `ADMIN_SESSION_SECRET` is not used. A preview environment has its own database, so its own stored mode.

## Hard rule: Access needs a custom domain; `*.workers.dev` uses the password

**`ADMIN_AUTH=access` is only for a deployment served on a custom domain, on a Cloudflare zone you control (one that uses Cloudflare's nameservers). A deployment reachable only on `*.workers.dev`, and every preview deployment, uses the password sign-in (leave `ADMIN_AUTH` unset, or set it to `password`).**

Why: Cloudflare's self-hosted application guide lists "An active domain on Cloudflare" as a prerequisite and says "Domains must belong to an active zone in your Cloudflare account". A `workers.dev` hostname is not a zone in your account. I haven't found a documented way to put an Access application scoped to `/admin/*` and `/api/admin/*` on one, and I haven't checked whether Cloudflare offers a switch for `workers.dev` hostnames as a whole (the guide was read on 4 October 2026 and does not mention `workers.dev`). A whole-hostname policy would put the public booking pages behind a login too, so it would not be a substitute anyway. (Sources and what was checked: "Cloudflare claims" at the end.)

This is a project rule, not something the Worker checks: with `ADMIN_AUTH=access` on a `workers.dev`-only deployment the Worker starts normally and then answers 401 to every admin request, because no token ever arrives (see "What `workers.dev` does under Access"). The default configuration already follows the rule, because with `ADMIN_AUTH` unset the site uses the password, so a new deployment is safe until someone changes it.

## Settings

| Name | Secret? | Used by | Meaning |
| --- | --- | --- | --- |
| `ADMIN_AUTH` | no | both | `access` or `password`, exactly. Unset means `password`, and `wrangler.jsonc` sets nothing. A value that is **set** to anything else, an empty one included, locks admin out (a 503). `access` wins over the stored mode; unset or `password` leaves the stored mode in charge (see "Which sign-in a site uses"). |
| `ACCESS_TEAM_DOMAIN` | no | access | Your team's host, such as `your-team.cloudflareaccess.com`. Must match `<name>.cloudflareaccess.com`, because it decides where the signing keys are fetched from. |
| `ACCESS_AUD` | no | access | The Access application's AUD (audience) tag. |
| `SETUP_CODE` | **yes** | password | **Optional.** A phrase you choose, at least 12 characters (counted after trimming). Set, it replaces the 30-minute first-run window: `/setup` then asks for it, to make the admin secret. It also reopens setup after the window has run out. Not used once the first sign-in has happened, or when the two settings below are set. Set but shorter than 12 counts as not ready: `/setup` answers 503. |
| `ADMIN_PASSWORD_HASH` | **yes** | password, override | Optional. `hmac-sha256$<salt>$<mac>`, the hash line from `npm run --silent generate-admin-secret`. Anything else, including the earlier `pbkdf2-sha256$...` format, locks admin out. If this or `ADMIN_SESSION_SECRET` is set, the environment settings apply and `/setup` is 404 (see "First-run setup"), unless the stored mode is `access`, which beats them. |
| `ADMIN_SESSION_SECRET` | **yes** | password, override | Optional. At least 32 random characters. Signs the session cookie and keys the login rate-limit hashes. Shorter counts as not configured. |

The three secrets must never be committed or put in `wrangler.jsonc`. Set them as Worker secrets (`npx wrangler secret put <NAME>` asks for the value, so nothing secret goes on the command line). The Deploy button asks for none of them. A deploy never deletes or replaces Worker secrets (`npx wrangler deploy --help`: "secrets are never deleted by deployments").

`ADMIN_AUTH`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are plain variables, and they behave differently: by default a deploy replaces every variable set in the dashboard with the ones in the config file (`--keep-vars` in `npx wrangler deploy --help`). So set them in the config, not the dashboard. In a club's own copy of the repo that means the `vars` block of `wrangler.jsonc`, which the template does not have, so you add it. In the maintainer's copy they go under `productionVars` (they belong to production, not preview) in the git-ignored `account.local.json`, followed by `npm run configure` (see `docs/deploying.md`). Locally, put them in `.dev.vars` (see `.dev.vars.example`) and restart `npm run dev`; only the password provider can be tried locally.

## Password provider

### First-run setup

A new deployment has no admin secret, and nobody has to generate one by hand. The site makes the secret, and a recovery code, on a page of its own. There are two ways in. With no `SETUP_CODE` set (the default), the site has a **first-run window**; with a `SETUP_CODE` set, `/setup` asks for it instead.

**The first-run window (no `SETUP_CODE`).**

1. Open the site's address (not `/setup`). While the window is open, `/` and any admin page send you to `/setup`.
2. The page says the site has no admin yet. Press "Create my admin secret". Nothing is created by just opening the page: only that button (a `POST`) makes an admin, so a link checker or a preview fetching the address cannot claim the site.
3. The page shows the **admin secret** and a **recovery code** (the same kind of value, 43 characters), **once**. Only a hash of each is stored: the secret's, with a new session secret, in the `admin_credentials` table (migration `0013`), and the recovery code's in `auth_settings`. They can't be shown again.
4. Save both in a password manager (two entries, if it allows), tick "I've saved both", then tap "Go to sign in". The button stays disabled until the box is ticked.

Rules for the window:

- **30 minutes**, counted from when the database was created (the migration that makes `auth_settings`), not from the first visit. The time is computed when read, so nothing runs in the background. A redeploy does not reopen it. The length is fixed in the code and is not a setting.
- **One winner.** The claim is a single atomic write: if two visitors press the button together, one gets the secret and the other gets 409 "This site has already been set up". No setup is counted or rate-limited, because there is nothing to guess.
- **The claimed state.** Once the button has been pressed and nobody has signed in yet, the site is in the claimed state. A second visitor sees "This site has already been set up. Sign in instead." The browser that pressed the button holds a claim cookie (`__Host-sb_claim`: a random 256-bit token, `HttpOnly; Secure; SameSite=Strict; Path=/`, valid for 24 hours; only its hash is stored), and with it the page offers a new pair that replaces the first (a closed tab, a lost clipboard). Without the cookie nobody can replace the claim except through `SETUP_CODE`, `/recover` or the database console.
- **Signing in works after the window has ended.** The window limits only making a first secret. The first successful sign-in on `/admin/login` sets `first_login_at`, and from then on `/setup` and `POST /api/setup` answer 404.
- **After the window, with nobody claimed.** The site says "Setup is closed" (503) and admin pages answer 503. Reopen it by setting `SETUP_CODE`, or by the database statement in [handover.md](handover.md#if-the-admin-secret-is-lost).
- **The claim race.** Until the owner presses the button, anyone who finds the site's address within the 30 minutes can press it first (see "Known limits"). Setting `SETUP_CODE` before the first visit turns the window off.
- Under Access, or with `ADMIN_PASSWORD_HASH` or `ADMIN_SESSION_SECRET` set, `/setup` is 404 and the window does not apply.
- A site that updates from v1.1 and has no admin and no `SETUP_CODE` gets a window when the new migration runs. A site with an admin who has signed in, or a `SETUP_CODE`, is unaffected.

**With a `SETUP_CODE` (the strict way, and the way to reopen setup).**

1. Set `SETUP_CODE` as a Worker secret: a phrase of at least 12 characters that you keep to yourself. A set code wins over the window. Set but shorter than 12 characters, `/setup` answers 503 with a line saying so, and the admin pages answer 503.
2. Open `/setup`. With no admin secret yet, any admin page sends you there.
3. Type the code into "Setup code" and tap "Continue". The page shows the admin secret and the recovery code once, as above.

Rules for the code:

- `/setup` stays open until the first successful sign-in. Running it again before then makes a new secret and a new recovery code and replaces the old ones, which stop working. The page says so.
- A wrong code gets 401 "That setup code isn't right." After 5 attempts from one client in 15 minutes the next gets 429 with `Retry-After`. The attempts are counted before the code is checked, in the `login_attempts` table with keys of their own (the sign-in count is separate), and a right code clears them. Client addresses are treated as in "Rate limiting".
- There is also one cap across all visitors together: 30 attempts per 15 minutes, counted under a single fixed key in the same table (it is not derived from `SETUP_CODE` and holds no address). Once it is reached, setup answers 429 to everyone, the right code included, until the window passes (15 minutes after its first attempt). A visitor already refused for passing their own limit adds nothing to it, and a correct setup clears only that visitor's own count, never this one. It exists because someone who changes address between guesses would otherwise get 5 guesses per address.

**Recovery.** `/recover` is a page on the site where the recovery code makes a new admin secret and a new recovery code. It works at any time, with or without the window, and the old secret and the old recovery code then stop working. Every session made with the old secret stops too, because a new session secret is made. It answers 404 when:

- the site has no stored recovery code (an admin secret made before this version has none, and neither does a site whose recovery hash was cleared), or
- `ADMIN_PASSWORD_HASH` or `ADMIN_SESSION_SECRET` is set as a Worker secret. They override the stored credentials, so there is nothing for `/recover` to replace. Delete those secrets first, or use the database statement in [handover.md](handover.md#if-the-admin-secret-is-lost).

A wrong code gets 401 "That recovery code isn't right." Attempts are limited to 5 per 15 minutes per client, counted before the check, and there is **no** cap across all clients, on purpose: a global one would let anyone block the owner from the one route meant for the worst day (see "Known limits"). A recovery code can be used once. Using it makes the next one, and of two simultaneous uses of the same code one gets 409 "That recovery code has already been used."

A recovery code exists only for an admin secret made on this version's `/setup`. A site made on v1.1 that has signed in has no recovery code: it keeps whatever recovery it has today (`SETUP_CODE` or the database console).

**Under Access.** If the site has `ADMIN_AUTH=access` in its settings, remove that line first and then use `/recover`. Otherwise the next Access sign-in puts the Access mode back and undoes the recovery. `/recover` itself tells you so when it sees the setting. When the Access mode is stored in the database, a successful recovery switches it back to the password sign-in (`changed_by = 'recovery'`).

Other rules:

- If `ADMIN_PASSWORD_HASH` or `ADMIN_SESSION_SECRET` is set as a Worker secret, the older behaviour applies instead: both settings must then be valid, one alone is a 503, and `/setup` is 404. The database is read only for the sign-in mode: a stored `access` mode beats these secrets, and the stored credentials are never used. See "Setting the secrets by hand".
- `/setup` is only for the password provider. With `ADMIN_AUTH=access`, or with the Access mode stored in the database, it is 404.
- **A database export or backup is as sensitive as the admin secret.** `wrangler d1 export`, the dashboard and Time Travel copies all contain the `admin_credentials` row: the hash of the admin secret and the key that signs sign-in cookies. Anyone holding a copy could sign in as admin (with the key they can sign a cookie for themselves). Keep exports private and delete them when you are done. Deleting the row, or running setup again before the first sign-in, replaces that key, so every existing sign-in stops working. (This is read from the table definition and the code; I haven't looked at an export.) The `auth_settings` row also holds the hash of the recovery code, which is as strong as the code but is another reason to keep exports private.
- A lost secret can't be read back. Use the recovery code on `/recover`; if that is lost too, deleting the `admin_credentials` row and reopening setup is the last resort. The steps are in [handover.md](handover.md#if-the-admin-secret-is-lost), section "If the admin secret is lost".

**Reopening the claim page by hand.** Someone with the club's Cloudflare account can run this in the D1 console. **Delete the `admin_credentials` row first**, if an admin had been made:

```sql
DELETE FROM admin_credentials;
UPDATE auth_settings SET setup_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), claim_token_hash = NULL, recovery_hash = NULL, recovery_created_at = NULL;
```

The second statement starts a new 30-minute window and clears the recovery code too. That matters: an old recovery code still works at any time and can create a new admin in the empty site, so run the whole statement, not a shorter one, whenever the recovery code might be known to someone else.

### Why a generated secret, not a password

The password provider has one shared credential and nothing slows a guesser down except the rate limit (below). Workers have no strong password-hashing function: the only native one is PBKDF2, capped at 100,000 iterations (below the OWASP recommendation) and costing CPU time on every login. So the credential is not a password a person chooses. It is a **generated admin secret**: 32 random bytes from `crypto.getRandomValues`, written as 43 base64url characters (`A-Z a-z 0-9 - _`), which is 256 bits. Nobody can guess or brute-force 256 random bits, whether through the login form or from a stolen stored value, so the stored value needs no slow hash. It is `hmac-sha256$<salt>$<mac>`, where `mac` is HMAC-SHA-256 keyed with a random 16-byte salt over the secret, and the login compares in constant time.

What that protects against: online guessing (rate limited, and hopeless against 256 bits anyway) and a leak of the stored hash (`ADMIN_PASSWORD_HASH`, or the `secret_hash` column made by `/setup`; it can't be reversed into the secret, or attacked offline in any practical way). What it doesn't: the secret itself being stolen (a keylogger, a phished or shoulder-surfed secret, a screenshot, a shared note), someone with the Cloudflare account reading or replacing the settings, or a stolen session cookie (see "Sessions"). There is no second factor and no per-person identity (the identity is always `admin`); Access provides both. The secret is meant to live in a password manager and be filled in by it, not typed from memory: it is 43 characters of noise.

Only a value in exactly the generated form is accepted: 43 characters from that alphabet that decode to 32 bytes and are the spelling the generator would print. (The last character of 43 base64url characters carries only 4 bits, so a few other spellings decode to the same bytes; they are refused, so each secret has one accepted spelling.) Any other value that reaches the check is refused with the same 401 as a wrong secret, before any hashing. Two cases never reach it and get 400 `invalid_input` instead: a value longer than 256 UTF-16 code units, and one that is empty, or only whitespace and zero-width characters, after trimming. Those are not counted toward the rate limit, which is harmless because no secret check happens. The form check reveals nothing that isn't already public, because the form is documented here. Whitespace and zero-width characters (spaces, tabs, line breaks, non-breaking spaces, zero-width spaces and joiners, soft hyphens) at the start or end of what is sent are ignored, because copying from a chat app or PDF often adds them; anything inside the secret is not ignored.

### Setting the secrets by hand

This is the override, for an existing deployment that already has these two secrets and for local development. A new deployment doesn't need it: use `/setup`.

1. Generate the secret and its stored value. The script takes no arguments and reads no input:

   ```sh
   npm run --silent generate-admin-secret
   ```

   It prints the **secret** on stderr, once, labelled "shown once", and only the **hash** (`hmac-sha256$...`) on stdout. Put the secret in your password manager straight away: it is not stored anywhere else and can't be recovered from the hash. Because the two go to different streams, `npm run --silent generate-admin-secret > hash.txt` keeps the secret out of the file (it still appears on the terminal). Use `--silent`: without it `npm run` writes its own two header lines to stdout, which would land in the file.
2. Make the session secret: `openssl rand -base64 48`.

   Use a **different** generated admin secret and a different `ADMIN_SESSION_SECRET` for preview and for production (run `generate-admin-secret` twice). With identical values, a session cookie minted on a preview would also validate on production if stolen and replayed, and preview code from another branch would handle the production admin secret.
3. Set the two secrets on the Worker. `npx wrangler secret put <key>` asks for the value, so nothing secret goes on the command line (`npx wrangler secret put --help`, Wrangler 4.147.0). Paste the hash line from step 1 for `ADMIN_PASSWORD_HASH`:

   ```sh
   npx wrangler secret put ADMIN_PASSWORD_HASH
   npx wrangler secret put ADMIN_SESSION_SECRET
   ```

   For the preview Worker add `--env preview` to both commands (`-e, --env` is in the help). Without it the secret goes to the production Worker, so don't leave it out. Set both: with only one of them set, admin answers 503, and `/setup` is already closed. Check in the dashboard afterwards that the secrets are listed on the Worker you meant (I haven't checked what the dashboard calls that page).
4. Nothing sets `ADMIN_AUTH` for a password site: unset means `password`, so there is nothing more to set unless you set it yourself. In the maintainer's copy it can also come from `vars` (or `previewVars`) in `account.local.json` followed by `npm run configure` (see `docs/configuration.md`). `vars` are not inherited by `env.preview`, so the script writes `vars` into **both** the top-level block and `env.preview` of the generated `wrangler.json`; `previewVars` goes into `env.preview` only. Secrets are separate from `vars`, and each goes to the Worker named by its `--env`.

To replace the secret, run the script again and set the new `ADMIN_PASSWORD_HASH`. Existing sessions stay valid until they expire or `ADMIN_SESSION_SECRET` is rotated. A stored value in the earlier `pbkdf2-sha256$...` format is refused as malformed: admin answers 503 and the log line says to run `npm run generate-admin-secret`.

### What a login costs (measured locally only)

Workers Free gives a request 10 ms of CPU ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). Measured on this machine in local `workerd` (via `wrangler`), **not on real Workers**, and local workerd does not enforce that limit:

- **The check itself.** A scratch worker ran the real `verifyAdminSecret` (shape check, HMAC key import, HMAC, constant-time compare) in a loop and read `performance.now()` around it. workerd's clock only advances at I/O boundaries and at awaits of crypto operations, so the figure was cross-checked against the wall time of the whole HTTP request, measured by `curl`; the two agreed. 10 runs of 10,000 verifications took 80 to 112 ms (median about 90 ms), about **9 microseconds each**. A secret refused by the shape check took under 1 microsecond.
- **The whole request.** Measured locally with an earlier build (not measured again on the Worker), with a throwaway local D1 and the password provider, 30 `POST /api/admin/login` requests with the correct secret took a median of **3.5 ms** and a p95 of 4.2 ms by `curl`'s `time_total` (a 401 for a well-formed wrong secret: median 2.7 ms; for a malformed one: median 2.6 ms). That is wall time including HTTP, JSON parsing and the D1 rate-limit write and read (local SQLite, so a real D1 will be slower, in time spent waiting on I/O rather than CPU), not CPU time. I didn't measure the CPU of the rest of the request separately.

So the HMAC is about three orders of magnitude below 10 ms. Whether the whole login fits the free plan's CPU limit on real Workers is **not verified**; the local wall time of the entire request being about a third of the limit is encouraging but isn't a CPU measurement.

### Sessions

On a correct admin secret the Worker sets `__Host-sb_admin` with exactly `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` (8 hours, no `Domain`). Its value is `v1.<payload>.<signature>`: the payload is base64url JSON `{sid, iat, exp}` (a 128-bit random session id and times in seconds) and the signature is HMAC-SHA-256 over it with `ADMIN_SESSION_SECRET` (or, when the admin secret came from `/setup`, the session secret stored beside its hash). Each request verifies the signature first, then the claims (not expired, issued no later than a minute ahead, lifetime at most 24 hours, exactly those three fields).

Sessions are **stateless**. Logout clears the cookie in the browser but cannot revoke a stolen copy before it expires. Rotating `ADMIN_SESSION_SECRET` invalidates every session at once; do that if a cookie may have leaked, and generate a new admin secret if the secret or its hash may have leaked. With a secret made on `/setup` there is no setting to rotate: see [handover.md](handover.md#if-the-admin-secret-is-lost), section "If the admin secret is lost".

`SameSite=Strict` means the browser doesn't send the cookie on a cross-site navigation, such as a link to `/admin/` in a chat app. The first request then looks signed out and is redirected to the login page, whose script asks `/api/admin/session` (a same-origin request, which does carry the cookie) and continues to `/admin/` if already signed in.

### Rate limiting

`POST /api/admin/login` allows 5 attempts per client per 15 minutes. Each attempt is counted atomically **before** the secret is checked, so parallel guesses can't exceed the limit, and a client over the limit gets 429 with `Retry-After` without any hashing. A correct secret clears the client's count. The counts are in the `login_attempts` table (migrations `0006` and `0007`).

- **Who a client is.** The `CF-Connecting-IP` header (set by Cloudflare). An IPv4 address counts as itself. An IPv6 address counts as its **/64 prefix**, because one subscriber normally owns a whole /64 (2^64 addresses) and a per-address limit could be sidestepped by rotating through them. An IPv4-mapped IPv6 address (`::ffff:203.0.113.9`) counts as that IPv4 address, a zone id (`%eth0`) is ignored, and a value that can't be parsed counts as itself. Without the header (local development) all requests share one client.
- **What is stored.** The key is the hex HMAC-SHA-256, keyed with the session secret (`ADMIN_SESSION_SECRET`, or the one stored by `/setup`), of that client bucket (the message is domain-separated from the session signatures). It is keyed because an unkeyed hash of an IPv4 address can be reversed in minutes by hashing every address. The rows are therefore pseudonymous but **still personal data**: whoever holds the secret and the table can test a guess at an address. Rotating the session secret makes old rows match nobody. Rows whose window ended more than a day ago are deleted as a side effect of later login attempts, at most 100 per attempt, so they stay until someone attempts a login. Rows written before migration `0007` were plain SHA-256 hashes; they match no client now and go the same way. With the Access provider the table is never touched.
- **Shared addresses.** Anyone sharing the admin's address (carrier-grade NAT, venue wifi, the same /64) shares the count: they can use up the five attempts and lock the admin's address out for up to 15 minutes. That is a known property of limiting by address.
- **No global lockout.** A limit across all clients would let anyone lock the real admin out from anywhere. So this limits one client, and does **not** stop a distributed attack that spreads guesses across many addresses; that is why the secret is 256 random bits rather than something a person chose.
- **Cost of the purge.** `0007` indexes `window_start`. Without it the purge scanned the whole table on every attempt, so attempts from many addresses could read enough rows to use up D1's free daily read allowance and break the public booking page too.

## Access provider

### Setting it up (custom domain)

Prerequisite: the hard rule above. You need a domain whose zone is active in your Cloudflare account, using Cloudflare's nameservers, and the Worker to serve the site on a hostname of that domain, such as `book.example.com`. The Access application is scoped to the paths `/admin/*` and `/api/admin/*` on that hostname, so the public booking pages stay public.

The Access labels below are the ones on Cloudflare's pages when this was written (sources under "Cloudflare claims"). Nobody has run this against a real account here, so the dashboard itself may word things differently. The Worker side (steps 1 and 5) was written for the move from Pages to a Worker and I have not read Cloudflare's Workers pages for it, so check it against their current docs.

1. **Put the custom domain on the Worker first.** Cloudflare's Workers settings have a place for custom domains (I believe "Settings", then "Domains & Routes", but I haven't verified the labels). In the config file the same thing is a `routes` entry with `custom_domain` set to `true` and the hostname as the `pattern` (`custom_domain` is in Wrangler's config schema; `npx wrangler deploy --help` also lists `--domains`). Do this before step 2, in case Cloudflare refuses to add a custom domain once an Access policy is already enabled on it (an earlier Cloudflare hosting product had that restriction; I haven't checked whether it holds for Workers), but doing it in this order costs nothing.
2. **Create the Access application.** In the Cloudflare dashboard go to "Zero Trust" > "Access controls" > "Applications", select "Create new application", then "Self-hosted and private". Select "Add public hostname". In the "Domain" dropdown choose your domain (it must belong to an active zone), set the subdomain if you use one, and set the **Path** as below. Never leave the path empty: that protects the whole site, including the booking pages.

   Cloudflare's application-paths page says a wildcard in the Path field "does not cover the parent path": its example is that `example.com/alpha/*` covers `example.com/alpha/one` but not `example.com/alpha`. So `/admin/*` does **not** cover `/admin` itself, and you need an entry for each of these four paths on your hostname:

   | Path | Covers |
   | --- | --- |
   | `/admin` | the bare `/admin` (no trailing slash) |
   | `/admin/*` | `/admin/` and everything below it: the admin pages |
   | `/api/admin` | the bare `/api/admin` |
   | `/api/admin/*` | everything below `/api/admin/`: the admin API |

   Select "Add public hostname" again for each further entry. The Cloudflare page documents the single-entry flow; adding several by repeating it is my assumption, so check it in the dashboard. A second application per path would work too but would give a second AUD tag, and the Worker accepts only one.
   The Worker guards bare `/admin` and `/api/admin` itself (checked in the Worker's tests, see "What `workers.dev` does under Access"), so the two bare entries are belt and braces, not the only protection. Entries with a `?` query string, a port or a `#` are not supported by Access application paths, so don't add any.
3. **Add an Allow policy.** Under "Access policies" add an existing policy or create a new one that allows the organisers' email addresses. Cloudflare: "All Access applications are deny by default -- a user must match an Allow policy before they are granted access." (How to pick emails, such as an "Emails" selector, is not on the page fetched; check the dashboard.) Choose the identity providers you accept, and set "Session Duration" short (say 8 hours or less), so a token that leaks expires soon. Cloudflare: "Cloudflare checks every HTTP request to your application for a valid application token." Select "Create".
4. **Copy the AUD tag and team domain.** Go to "Zero Trust" > "Access controls" > "Applications", select "Configure" for your application and, from "Additional settings", copy the "Application Audience (AUD) Tag" (Cloudflare: it "will never change unless you delete or recreate the Access application"). Your team domain is `<your-team-name>.cloudflareaccess.com`; Cloudflare says the team name is shown in Cloudflare One under "Settings".
5. **Give the Worker the settings and redeploy.** Use the config file, not the dashboard: a deploy overwrites dashboard variables with the ones in the config (see "Settings"). The values are strings, with the host only for the team domain, no `https://`.

   In a club's own copy of the repo, add a `vars` block to `wrangler.jsonc` (the template has none):

   ```jsonc
   "vars": {
     "ADMIN_AUTH": "access",
     "ACCESS_TEAM_DOMAIN": "<your-team-name>.cloudflareaccess.com",
     "ACCESS_AUD": "<the AUD tag from step 4>"
   },
   ```

   Then run `npm run deploy` (it applies any new migrations, then deploys). Only the top-level `vars` is changed, so a preview environment, if you have one, stays on the password provider.

   In the maintainer's copy, add the Access settings to `productionVars` in `account.local.json` (see `docs/deploying.md`) and keep previews on the password provider with `previewVars`:

   ```jsonc
   "productionVars": {
     "ADMIN_AUTH": "access",
     "ACCESS_TEAM_DOMAIN": "<your-team-name>.cloudflareaccess.com",
     "ACCESS_AUD": "<the AUD tag from step 4>"
   },
   "previewVars": {
     "ADMIN_AUTH": "password"
   }
   ```

   `productionVars` goes into the top-level (production) block only and `previewVars` into `env.preview` only; anything in `vars` goes into both, and an environment's own value wins over `vars`.

   Run `npm run configure`. It refuses an `account.local.json` that has a database ID that is not a UUID or is a placeholder, the two IDs equal, an unknown key, a variable name that isn't a plain identifier, a value that isn't a string, or a secret (`ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`: the Access provider uses neither), in `vars`, `productionVars` or `previewVars`. It does not check `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD`; the Worker does at run time and answers 503 on every admin request, logging which setting is wrong, if the team domain isn't a `<name>.cloudflareaccess.com` host or the AUD is empty. Then redeploy production (`npx wrangler deploy`, with no `--env`). With the example above, the preview Worker keeps the password provider, so you can test one before and after switching production to `access`. If you put the Access settings under `vars` instead, the script writes them into `env.preview` too, the preview Worker also expects Access, and admin does not work on it (401).

   Admin secrets made by `/setup` stay in the database after the switch and are simply not used: with `ADMIN_AUTH=access`, or with the Access mode stored (see "After the first Access sign-in: pinning"), the password provider is not consulted.
6. **Verify.** Replace the hostnames with yours.

   ```sh
   curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://<custom-domain>/api/admin/events
   curl -s -i https://<worker>.<subdomain>.workers.dev/api/admin/events
   curl -s -i https://<worker>.<subdomain>.workers.dev/admin
   ```

   - The first request has no Access session, so Access should turn it away before the Worker sees it. The Worker's own answer is the JSON `unauthenticated` body shown below, so if you see that body here, Access isn't in front of this path. The status Access itself returns (I'd expect a redirect to your team's login page) is not stated on the pages fetched and is **not verified**.
   - The second and third go to `workers.dev`, where no Access token is attached, so they reach the Worker and are refused by it: 401 with `{"error":{"code":"unauthenticated","message":"Sign in to continue."},"provider":"access"}`, and 401 with the text "Sign in with Cloudflare Access to use the admin pages." (the Worker's tests send these requests with a made-up Access configuration; not seen on Cloudflare). A 503 instead means a setting is missing or malformed (the Worker's logs say which: see [Troubleshooting](deploying.md#troubleshooting)).
   - In a browser, open `https://<custom-domain>/admin` (no trailing slash) in a private window: you should reach Access's sign-in. Sign in with an allowed email and the admin list should load. A non-allowed email should be refused by Access. Also open `https://<custom-domain>/` and a booking link `/e/<slug>`: they must load without any sign-in. "Sign out" in the admin list sends the browser to `/cdn-cgi/access/logout`.
   - **Unverified: whether Access's `Cf-Access-Jwt-Assertion` header reaches a Worker that serves static assets.** Cloudflare's docs are silent on it. The Worker validates the header itself (see "How the Worker checks the token"), so if the header does not arrive, every admin request after the Access login gets the 401 above and admin cannot be used. Test it as soon as you enable Access: the browser step above is the test. If you are signed in to Access and the admin list still answers 401, the header is not arriving, so remove the `ADMIN_AUTH` line (or set it to `password`) and redeploy (and see Troubleshooting). That works because the site records the Access settings only after a sign-in that reached the Worker, and in this case none did. Once a sign-in has been recorded, those two steps no longer leave Access: see "Leaving Access".

### After the first Access sign-in: pinning

With `ADMIN_AUTH=access` in the settings, the first time an admin signs in through Access, `GET /api/admin/session` copies the team domain, the AUD and the request's hostname into the `auth_settings` row (`mode = 'access'`, `changed_by = 'import'`), unless the database already holds exactly those values. This is called pinning. From then on a lost `ADMIN_AUTH` line changes nothing: with the variable unset, the stored mode keeps the site on Access.

**A site that has never had an admin sign in through Access is not pinned,** and is not protected against losing the line. Without the line it falls back to the password sign-in, and an admin secret made before the switch, still in the database, is accepted again. So when you move an existing site that has `"vars": { "ADMIN_AUTH": "access" }` in its own `wrangler.jsonc`, do these in this order:

1. Deploy the new code with the `ADMIN_AUTH` line still in your own `wrangler.jsonc`. The template no longer has any `vars`, so an update shows a conflict on that line: keep yours.
2. Sign in once through Cloudflare Access. This first sign-in records the Access settings in the database (the mode is "pinned").
3. Check that `/api/admin/session` shows provider `access`.
4. Only then remove the `ADMIN_AUTH` line.

Removing the line before that first sign-in drops the site back to password mode, with the old admin secret valid again.

### Leaving Access

Because an unset or `password` `ADMIN_AUTH` leaves the stored mode in charge, setting it back to `password` no longer leaves Access once the site is pinned. The ways back:

- `/recover`, with the recovery code. It sets the stored mode to `password` (`changed_by = 'recovery'`) and makes a new admin secret and recovery code. **If your settings still have `ADMIN_AUTH=access`, remove that line first,** because it wins over the stored mode and the next Access sign-in would put the Access mode back. `/recover` says so when it sees the setting. It answers 404 if the site has no recovery code, or if `ADMIN_PASSWORD_HASH` or `ADMIN_SESSION_SECRET` is set (delete those secrets first).
- The database statement, in the D1 console (remove any `ADMIN_AUTH=access` line first, for the same reason):

  ```sql
  UPDATE auth_settings SET mode = 'password', changed_by = 'owner' WHERE id = 1;
  ```

  This returns to the password sign-in with whatever admin secret is stored. If there is none, or it is lost, follow with the steps in [handover.md](handover.md#if-the-admin-secret-is-lost).

### What `workers.dev` does under Access

Access is only in front of the custom domain. The Worker verifies the Access token itself and reads it only from the `Cf-Access-Jwt-Assertion` header, so a request to `<worker>.<subdomain>.workers.dev` has no token unless the caller adds one by hand. With `ADMIN_AUTH=access` and a valid configuration (the Worker's tests, `src/worker/guards-pages.test.ts` and `guards-api.test.ts`):

- `/admin`, `/admin/`, `/admin/login` and every other path under `/admin/` answer 401, `text/plain`, "Sign in with Cloudflare Access to use the admin pages." (the login pages are served unauthenticated only with the password provider).
- `/api/admin` and everything under it answer 401 JSON `unauthenticated` with `"provider":"access"`. `POST /api/admin/login` answers 404 `not_found`, because that route doesn't exist with Access.

So the `workers.dev` hostname is not an authentication bypass, but:

- It still serves the public booking pages and API.
- Admin cannot be **used** on `workers.dev`, previews included, while `ADMIN_AUTH=access`.
- The Worker accepts any validly signed, unexpired token for its AUD, whichever hostname the request arrives on, and the signing keys are per team, not per hostname. Someone who holds a token stolen from a signed-in organiser could add the header by hand on `workers.dev`, where Access is not there to enforce session revocation. A short session duration limits that.

#### Optional: closing the `workers.dev` hostname

This is not needed for the admin to work or be secure. `wrangler.jsonc` sets `workers_dev` explicitly to `true` (in Wrangler's config schema: "Whether we use <name>.<subdomain>.workers.dev to test and deploy your Worker"), which is what keeps the button's `workers.dev` address working. Setting it to `false` in the club's copy should turn that hostname off once the custom domain works. I haven't tried turning it off.

### How the Worker checks the token

The Worker doesn't trust that Access is in front: it verifies the token itself, following [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/):

- The token is read only from the `Cf-Access-Jwt-Assertion` header (the docs recommend that over the `CF_Authorization` cookie). `Cf-Access-Authenticated-User-Email` is never read, because it is not signed. A request with only that header, or only the cookie, is unauthenticated.
- Checks, in order: three base64url segments (at most 8 KB); header `alg` exactly `RS256` and a string `kid` (so `none`, HS256 and every other algorithm are refused); the RSASSA-PKCS1-v1_5 SHA-256 signature, against the key in Access's key set with that `kid`. Only then is the payload read: `iss` equals `https://<team domain>`, `aud` (a string or a list) contains `ACCESS_AUD`, `exp` is a number and in the future (no leeway), `nbf` if present is not more than 30 seconds ahead, and `email` is a non-empty string containing `@`. Service tokens carry no email and are refused.
- Keys come from `https://<team domain>/cdn-cgi/access/certs` (the `keys` list; `public_cert` is not used). Access rotates them about every 6 weeks with a 7-day overlap, so the key is chosen by `kid`. The set is cached for an hour; an unknown `kid` forces one refetch, at most once a minute, so junk tokens can't hammer the endpoint. A failed or malformed fetch denies the request, waits a minute before trying again, and logs the reason (never token contents).

Access can't be tried locally: the token only exists behind Cloudflare. Use the password provider for local development, for previews and for `*.workers.dev`-only deployments.

### Logout

`POST /api/admin/logout` returns `{ "logoutUrl": "/cdn-cgi/access/logout" }`, and the page sends the browser there. Ending an Access session is Access's job.

## Requests from the admin pages

One guard, `guardAdminApi` in `src/worker/guards.ts`, runs in `src/worker.ts` before any route is matched. It covers everything under `/api/admin/`, including paths no route handles yet, so a new route is protected by default:

1. Provider not configured: 503 `admin_not_configured`.
2. Not authenticated: 401 `unauthenticated` (the body names the `provider`, so the login page knows whether to offer a password form).
3. A state-changing method (anything other than GET, HEAD and OPTIONS) must also pass the CSRF checks below, or it gets 403 `csrf_failed` (415 for a non-JSON Content-Type).
4. Otherwise `data.admin` is set to `{ identity, csrfBinding }` and the request continues. Handlers read `data.admin.identity`; type them as `RouteHandler<"param", AdminData>` (`RouteHandler` is in `src/server/env.ts`, `AdminData` is exported from `src/server/auth`).

The one exemption is `POST /api/admin/login` with the password provider: it gets the Origin check but no token (there is no session yet). With the Access provider that route does not exist (404).

**CSRF** applies to every state-changing request, with either provider:

1. The `Origin` header must be present and equal this site's origin. (Admin is browser-only, so a missing Origin is refused.)
2. If `Sec-Fetch-Site` is present it must be `same-origin`.
3. `X-CSRF-Token` must equal the session's token, compared in constant time. The token is `base64url(SHA-256("slot-booker-csrf-v1:" + csrfBinding))`, where the binding is a secret the page's JavaScript never sees: the session id in the HttpOnly cookie (password) or the Access JWT in the header (access). No separate CSRF secret is needed.
4. `Content-Type` must be `application/json`, which a cross-site form can't send.

`GET /api/admin/session` returns `{ identity, provider, csrfToken }`. A client fetches it once, sends the token as `X-CSRF-Token` on writes, and **re-fetches `/session` and retries once on a 403 `csrf_failed`**: under Access the JWT is refreshed periodically, which changes the token.

The pages (`guardAdminPage` in the same file) are guarded too: signed out, the password provider redirects to `/admin/login` (only `/admin/login`, `/admin/login.html` and `/admin/login.js` are served without signing in), the access provider answers 401 text, and an unconfigured site answers 503, or redirects to `/setup` when the only thing missing is the admin secret and setup is open. The pages hold no data and the API is protected on its own, so this is defence in depth.

`run_worker_first` in `wrangler.jsonc` makes the Worker see `/`, `/e/*`, `/api/*`, `/admin`, `/admin/*`, `/setup` and `/recover` before the static files, so none of these can be served around the guards. `src/test/wrangler-config.test.ts` pins that list. Every other static file (scripts, styles, icons) is served straight from `public/`.

## Checking the security headers after deployment

Every response the Worker returns (the API, redirects, errors and the files it fetches through the `ASSETS` binding) gets a `Content-Security-Policy` (including `frame-ancestors 'none'`), `Strict-Transport-Security` (`max-age=31536000`: one year, no `includeSubDomains`, no `preload`), `Referrer-Policy`, `X-Content-Type-Options` and `X-Robots-Tag` from `withSecurityHeaders` in `src/worker/headers.ts`. `public/_headers` carries the same set for the static files Cloudflare serves itself, and `src/worker/headers.test.ts` fails if the two differ. After deploying, check that they reach the admin pages:

```sh
curl -sI https://<your-worker-url>/admin/login
```

The output should include a `Content-Security-Policy` with `frame-ancestors 'none'` and a `Strict-Transport-Security` header. The tests check the headers on the Worker's own responses; I have not seen them on a deployed site, so check there rather than assume. (The icon and logo routes set their own stricter `Content-Security-Policy`, which is kept.)

The Worker also refuses plain `http://` before it does anything else, on every host except `localhost` and IP addresses (local development, so `wrangler dev` still works, including from a phone on the same network): a GET or HEAD gets a 308 redirect to the same address over `https://`, and any other method gets a 403 with the code `https_required` (it is not redirected, so a request body is never sent a second time). The `Strict-Transport-Security` header then keeps browsers on https. That `request.url` shows the scheme the visitor used is assumed from Cloudflare's documentation, not tested here, and I have not seen the redirect on a deployed `workers.dev` address or custom domain, so check it there: `curl -sI http://<your-worker-url>/` should answer 308.

## Known limits


- **Unusual paths to the static admin files are not checked against the real asset service.** Earlier, measured locally with an earlier build, paths such as `//admin/x.js`, `/%2fadmin/x.js` and `/%61dmin/x.js` returned the admin static files without signing in. The Worker runs its guard first for `/admin` and `/admin/*` (`run_worker_first`), and `src/worker/worker.test.ts` sends a long list of such variants (double slashes, encoded letters and slashes, dot segments, other cases) at it with a stand-in for the static files: each is guarded, or goes to the static files for a path outside `/admin`, or ends in a JSON 404 or 405, and none reaches an admin handler. That stand-in is not Cloudflare's asset service, and I haven't tried the variants on a deployed Worker, so whether it serves one of them without calling the Worker is unverified. Only the admin HTML and JavaScript, which hold no data (every API call is checked), could be exposed that way.
- **The `workers.dev` hostname keeps serving the public site.** Under Access, admin cannot be used there and gets 401, but the booking pages are still reachable (see "What `workers.dev` does under Access" for the optional way to close it).
- Whether a login fits in the free plan's 10 ms of CPU is unverified on real Workers; only local numbers exist (see "What a login costs").
- Per-client login limiting doesn't stop a distributed attack, and clients sharing an address share the lockout (see "Rate limiting").
- Logout can't revoke a password session before it expires (see above).
- **Recovery attempts are limited per visitor, and not across all visitors, on purpose.** `/recover` allows 5 attempts per 15 minutes for each address (an IPv6 address counts as its /64). So anyone on the same network address as the owner can keep that address blocked, and the owner can try from another network. A cap across everyone would let anyone block the owner from the one route meant for the worst day. Guessing a 256-bit recovery code is not feasible. The attempts are counted in the database, so someone rotating addresses can cause database writes without limit, as with the sign-in page.
- **The claim race.** Until the owner presses "Create my admin secret", anyone who finds the site's address within the 30 minutes can claim it first. Setting `SETUP_CODE` before the first visit turns the window off.
- **The recovery code is a second secret.** Whoever holds it can make a new admin secret, with or without the window, so keep it as carefully as the admin secret.
- No second factor with the password provider. Access can provide one.

## Cloudflare claims

Each was read from the live page on 4 October 2026 (the pages' own "Last updated" dates are in brackets). The dashboard itself was not checked: nobody has a Cloudflare account configured here.

- Access needs an active zone, and the path rules: [Self-hosted public application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) (17 April 2026): prerequisite "An active domain on Cloudflare"; "Domains must belong to an active zone in your Cloudflare account"; the steps "Create new application", "Self-hosted and private", "Add public hostname", "Session Duration".
- Paths: [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) (17 April 2026): for `example.com/alpha/*`, "Does not cover" `example.com/alpha`; "At most one wildcard in between each slash in the Path"; query strings, port numbers and `#` are not supported.
- Header, keys and AUD tag: [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) (6 May 2026).
- **Not read for the move to a Worker:** Cloudflare's Workers pages on custom domains, `workers.dev`, and Access in front of a Worker. Everything above about the Worker side of Access is from Wrangler's help and config schema (4.147.0) and the code, not from Cloudflare's documentation.
- **Not on any of those pages:** the `Emails` selector for an Allow policy, the status code Access returns to an unauthenticated `curl`, whether several public hostnames can be added by repeating "Add public hostname". None of these is claimed as verified above.

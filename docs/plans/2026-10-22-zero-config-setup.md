# Zero-config setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A club presses the Deploy button with no secret to type, opens its site, and gets an admin secret and a recovery code from a 30-minute first-run claim window; the sign-in mode lives in D1 so an Access site cannot silently fall back to the password.

**Architecture:** Migration `0019` creates one singleton `auth_settings` row (sign-in mode, claim window, claim token, recovery hash). `adminAuthFor` and `setupState` read it with `admin_credentials` in one batch. `/setup` gains `claim` and `claimed` states; a new `/recover` page resets the secret with the recovery code. The Access wizard (separate design) extends the same table in `0020`.

**Tech Stack:** TypeScript on one Cloudflare Worker, D1 (SQLite), static pages in `public/` (plain JS modules), Vitest with happy-dom, Wrangler 4.

**Spec:** `docs/design/zero-config-setup.md` (sections 3.1 to 3.8 are the contract; 2.1 is the observed Deploy form). Read it first. Wizard design (other branch): `git show docs/access-wizard-design:docs/design/access-wizard.md`.

## Global Constraints

- Branch `docs/zero-config-setup` (from `main` = `v1.1`, `f71189f`). Migration number **`0019`**; the wizard takes `0020`.
- Claim window **30 minutes** (`CLAIM_WINDOW_MS = 30 * 60 * 1000`), a constant, not a setting. Open iff `-60_000 <= now - setup_opened_at < CLAIM_WINDOW_MS`; an unparseable or null time is closed.
- Claim cookie `__Host-sb_claim`: `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`. Only the SHA-256 hex of its token is stored.
- Admin secret and recovery code: 32 random bytes, 43 characters (`generateAdminSecret`), stored as `hmac-sha256$<salt>$<mac>` (`hashAdminSecret`). Shown once, never logged, never stored plain.
- `ADMIN_AUTH`: only **unset** defaults to password. Set to anything but `access` or `password` (including `""`, `Password`, ` access`, `none`) is 503 `not_configured`.
- `/recover` is limited per client only (5 attempts per 15 minutes via `countAttempt` defaults), **no global cap**. `/setup` code-flow limits are unchanged.
- A GET never creates credentials. Claim and recovery are `POST`, same-origin (`hasSameOrigin`), `Cache-Control: no-store`.
- `SETUP_CODE` set (valid, 12+ characters after `trimAdminSecret`) means v1.1 behaviour: the window is off.
- D1 Free-plan limit is 50 queries per invocation; keep `/` at zero extra D1 reads once cached (60 s per isolate).
- Code style: match the surrounding files (British spelling in user-facing text and comments, `// why` comments only, no emoji). Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Never run `wrangler deploy`, `delete` or `d1 ...` from the repo root**: the git-ignored `wrangler.json` there holds real database ids and wins over `wrangler.jsonc`. Tests are safe (`npm test`).
- Verification commands: `npx vitest run <file>`, `npm test`, `npm run typecheck`. Nothing is "done" without running them and showing the output.

## Review Focus

Failure modes the spec implies that no single task's happy path exercises; each is pinned by a named test below.

1. **Two simultaneous claims** (or two uses of one recovery code): exactly one wins, no orphan or mismatched hash pair. Tasks 5, 6, 9.
2. **A crawler or link preview**: `GET /setup`, `GET /api/setup`, `HEAD /` and `GET /e/<slug>` never create credentials or redirect; only `GET /` in state `claim` redirects. Tasks 6, 8.
3. **Upgrading an existing site**: signed-in site, a site with `SETUP_CODE`, and an env-Access site all behave as before; an env-Access site pins itself and then survives losing its `ADMIN_AUTH` line. Tasks 2, 4.
4. **Clock edges**: exactly 30:00, a garbage `setup_opened_at`, a slightly future one, a claim made at minute 29 and signed in at minute 31. Tasks 2, 4, 6.
5. **Recovery oddities**: a recovery code with stray whitespace or invisible characters, `/recover` with env credentials set, with `ADMIN_AUTH=access` pinned in env, and the sixth wrong attempt. Task 9.

## File Structure

| File | Responsibility |
|---|---|
| `migrations/0019_auth_settings.sql` (create) | The singleton row (design 3.1). |
| `src/server/auth/settings.ts` (create) | `AuthSettings`, `loadAuthState`, `envAuthSetting`, `windowOpen`, `pinAccess`. No HTTP. |
| `src/server/auth/claim.ts` (create) | Atomic `claimAdmin`, `reissueClaim`, `recoverAdmin`; claim-cookie helpers. No HTTP routing. |
| `src/server/auth/index.ts` (modify) | `adminAuthFor` applies the resolution rule (design 3.8). |
| `src/server/auth/credentials.ts` (modify) | `saveCredentials` can also store a recovery hash. |
| `src/server/setup.ts` (modify) | `readSetup`, `setupState` with the five states; `claimOpenCached`. |
| `src/routes/api/setup.ts` (modify) | `POST /api/setup` (code flow, claim, reissue), new `GET /api/setup` state. |
| `src/routes/api/recover.ts` (create) | `POST /api/recover`. |
| `src/routes/api/admin/session.ts` (modify) | Pins env-Access into D1. |
| `src/worker/{guards,static,routes}.ts` (modify) | Redirects, `/recover` page and routes. |
| `public/save-screen.js`, `recover.html`, `recover.js` (create); `setup.html`, `setup.js` (modify) | The pages. |
| `wrangler.jsonc`, `.dev.vars.example`, `package.json` (modify) | No `vars`, no secret prompt, `/recover` in `run_worker_first`. |
| `docs/**`, `README.md` (modify) | Task 11. |

---

### Task 1: Migration `0019_auth_settings.sql`

**Files:**
- Create: `migrations/0019_auth_settings.sql`
- Test: `src/test/migration-0019.test.ts` (follow `src/test/migration-0013.test.ts`)

**Interfaces:**
- Produces: table `auth_settings` exactly as in design 3.1 (columns `id, mode, access_team_domain, access_aud, access_hostname, changed_at, changed_by, setup_opened_at, claim_token_hash, recovery_hash, recovery_created_at`), one seeded row.

- [ ] **Step 1: Write the failing tests** (names and assertions)
  - `"seeds one row: mode password, every optional column null, setup_opened_at an ISO time within a minute of now"`
  - `"refuses id 2, mode 'both' and changed_by 'someone'"` (each `rejects.toThrow(/CHECK constraint failed/)`)
  - `"refuses mode 'access' unless team domain, aud and hostname are all set, and accepts it when they are"`
  - `"refuses a recovery_hash without the hmac-sha256$ prefix and accepts null"`
- [ ] **Step 2: Run** `npx vitest run src/test/migration-0019.test.ts` → FAIL (`no such table: auth_settings`).
- [ ] **Step 3: Write the migration** with the SQL block from design 3.1, plus a header comment in the style of `0013` (what writes it, that deleting `admin_credentials` does not touch it).
- [ ] **Step 4: Run** the test file → PASS; then `npm test` to confirm `global-setup` still migrates.
- [ ] **Step 5: Commit** `git add migrations/0019_auth_settings.sql src/test/migration-0019.test.ts && git commit -m "Add migration 0019: auth_settings"`.

### Task 2: Settings module and the resolution rule

**Files:**
- Create: `src/server/auth/settings.ts`, `src/server/auth/settings.test.ts`
- Modify: `src/server/auth/index.ts`, `src/routes/api/admin/session.ts`, `src/server/auth/test-harness.ts`
- Test: `src/server/auth/index.test.ts`, `src/routes/api/admin/session.test.ts` (create if absent)

**Interfaces:**
- Produces (`settings.ts`):
  - `interface AuthSettings { mode: "password" | "access"; accessTeamDomain: string | null; accessAud: string | null; accessHostname: string | null; changedAt: string | null; changedBy: string | null; setupOpenedAt: string | null; claimTokenHash: string | null; recoveryHash: string | null; recoveryCreatedAt: string | null }`
  - `const NO_SETTINGS: AuthSettings` (mode `password`, all others null)
  - `loadAuthState(db: D1Database): Promise<{ settings: AuthSettings; credentials: StoredCredentials | null }>` — **one `db.batch`** of the two selects; a missing row gives `NO_SETTINGS`.
  - `envAuthSetting(env: AppEnv): "access" | "password-or-unset" | "invalid"`
  - `CLAIM_WINDOW_MS`, `windowOpen(setupOpenedAt: string | null, nowMs: number): boolean`
  - `pinAccess(db, v: { teamDomain: string; aud: string; hostname: string }, nowIso: string): Promise<boolean>` — one `UPDATE ... WHERE id = 1 AND (mode IS NOT 'access' OR access_team_domain IS NOT ? OR access_aud IS NOT ? OR access_hostname IS NOT ?)` setting `mode='access'`, the three values, `changed_at`, `changed_by='import'`; true iff a row changed.
- Produces (`test-harness.ts`): `claimEnv(db: D1Database, over?: Partial<AppEnv>): AppEnv` (`{ DB }` only: no `ADMIN_AUTH`, no `SETUP_CODE`); `setOpenedAt(db, iso: string): Promise<void>`; `ageWindow(db, ms: number): Promise<void>` (sets `setup_opened_at` to now minus `ms`).
- Consumes: `StoredCredentials`, `loadCredentials` SQL (`credentials.ts`), `parseAccessConfig`, `envCredentialsSet`.

- [ ] **Step 1: Failing tests**
  - `settings.test.ts`: `windowOpen` true at 0 ms and 29:59.999, **false at exactly 30:00.000**, false for `null` and `"not a date"`, true at -60 s, false at -61 s; `loadAuthState` returns `NO_SETTINGS` and `credentials: null` after the row is deleted, and issues a single batch (use `interceptBatches` from `src/test/db.ts`); `pinAccess` returns true the first time (row has `mode access`, values, `changed_by import`), false for identical values, true when the AUD differs; `envAuthSetting` for `undefined`, `"password"`, `"access"`, `""`, `"Password"`, `" access"`, `"none"`.
  - `index.test.ts` (`adminAuthFor`), one test per row of design 3.8: env `access` + valid config resolves **with a `DB` whose `prepare` throws** (proves no D1 read); unset + D1 `access` → access from D1 values; `"password"` + D1 `access` → access; **unset + D1 `access` + env password credentials set → still access** (D1 beats env creds); unset + D1 `password` + no `admin_credentials` → `{ error, awaitingSetup: true }`; the five invalid values above → `error: "not_configured"`.
  - `session.test.ts`: with `accessEnv(db)` the `GET /api/admin/session` handler writes the pin (`mode access`, hostname from the request URL); a second call changes nothing; **then calling `adminAuthFor` with `ADMIN_AUTH` removed from env resolves to Access from D1** (Review Focus 3); with password env it never writes.
- [ ] **Step 2: Run** `npx vitest run src/server/auth src/routes/api/admin/session.test.ts` → FAIL.
- [ ] **Step 3: Implement** `settings.ts` as above; rewrite `adminAuthFor` (same signature) to the rule in design 3.8, building Access config from D1 via `parseAccessConfig({ ACCESS_TEAM_DOMAIN, ACCESS_AUD })`; keep every existing reason string except the awaiting-setup one (reword to `"no admin credentials yet: open /setup"`). In `session.ts` add `request` to the destructuring and call `pinAccess` only when `env.ADMIN_AUTH === "access"` and `parseAccessConfig(env)` is non-null; swallow nothing (a failed pin must not fail the session read: catch, `console.error` the message, continue).
- [ ] **Step 4: Run** the same command → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `"Resolve the sign-in mode from env and auth_settings; pin env Access into D1"`.

### Task 3: `ADMIN_AUTH` leaves `wrangler.jsonc`

**Files:**
- Modify: `wrangler.jsonc` (remove `"vars": { "ADMIN_AUTH": "password" }` in the top level and in `env.preview`; rewrite the comment at l.32-35 to say a fresh site needs no variable and Access users add `ADMIN_AUTH` to their own copy), `src/test/deploy-button.test.ts:76-79`, `src/test/wrangler-config.test.ts`, `src/test/configure.test.ts:342-358` (the test "keeps the committed template's own vars…")
- Depends on Task 2 (unset must already mean password).

**Interfaces:** Produces: a template with **no `vars` key** in either block.

- [ ] **Step 1: Update tests first**
  - `deploy-button.test.ts`: replace the `vars` equal-`{ ADMIN_AUTH: "password" }` test with `"has no plain variables, so the form shows none"` (`config().vars` and `config("preview").vars` both `undefined`).
  - `wrangler-config.test.ts`: add `"has no ADMIN_AUTH variable in production or preview"`.
  - `configure.test.ts`: rename the test at l.342 (it no longer "keeps the template's own vars"); the committed template's `vars` expectations become `toBeUndefined()` (l.345-346, 349-350); l.358's preview expectation becomes `{ BOOKING_CUTOFF_OFFSET_MINUTES: "-30" }`; l.357 stays. Read `buildConfig` (`scripts/configure-core.ts:114-125`): it already tolerates absent template vars, so no code change is expected there; if a test shows otherwise, fix `buildConfig` minimally.
- [ ] **Step 2: Run** `npx vitest run src/test/deploy-button.test.ts src/test/wrangler-config.test.ts src/test/configure.test.ts` → FAIL.
- [ ] **Step 3: Edit `wrangler.jsonc`.**
- [ ] **Step 4: Run** the same command, then `npm test` → PASS (other tests inject `ADMIN_AUTH` through the harness and are unaffected).
- [ ] **Step 5: Commit** `"Remove ADMIN_AUTH from the template: the form shows no variable"`.

### Task 4: `setupState` with the claim window

**Files:**
- Modify: `src/server/setup.ts`, `src/server/setup.test.ts`

**Interfaces:**
- Consumes: `loadAuthState`, `windowOpen`, `envAuthSetting`, `envCredentialsSet`, `expectedSetupCode` (existing).
- Produces:
  - `type SetupState = "closed" | "not_ready" | "open" | "claim" | "claimed"`
  - `readSetup(env: AppEnv, nowMs?: number): Promise<{ state: SetupState; settings: AuthSettings; reason: "short_code" | "expired" | null }>` (`nowMs` defaults to `Date.now()`)
  - `setupState(env, nowMs?): Promise<SetupState>` (calls `readSetup`)
  - `claimOpenCached(env: AppEnv, nowMs?: number): Promise<boolean>` — true iff state is `claim`; **only `false` is memoised**, 60 s, in a `WeakMap<D1Database, number>` keyed by `env.DB`.

Decision order (design 3.2): env setting not `password-or-unset` → `closed`; then load; D1 `mode access`, env credentials set, or `firstLoginAt` set → `closed`; valid `SETUP_CODE` → `open`; `SETUP_CODE` trimmed non-empty but short → `not_ready` (`short_code`); no code and a credentials row → `claimed`; no code, no row, `windowOpen` → `claim`; else `not_ready` (`expired`).

- [ ] **Step 1: Failing tests** (table-driven, one case per row of design 3.2, built with `claimEnv`/`d1Env`): the seven outcomes above; **window exactly 30:00 → `not_ready/expired`**; `setup_opened_at` garbage → `not_ready/expired`; valid `SETUP_CODE` with the window open → `open` (not `claim`); `ADMIN_AUTH=access` in env → `closed` without touching D1; D1 mode `access` → `closed`. `claimOpenCached`: after one `false`, a second call within 60 s issues **no statement** (count with `interceptBatches` or a prepare spy); a `true` is never cached (flip the row, next call sees it).
- [ ] **Step 2: Run** `npx vitest run src/server/setup.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Keep `expectedSetupCode`, `setupCodeMatches`, `MIN_SETUP_CODE_LENGTH` unchanged.
- [ ] **Step 4: Run** the file → PASS; `npx vitest run src/routes/api/setup.test.ts src/worker` and fix any callers broken by the new return type (the old `not_ready` for a missing code is now `claim` or `not_ready/expired`).
- [ ] **Step 5: Commit** `"setupState: add claim and claimed, driven by the claim window"`.

### Task 5: Atomic claim, reissue and recovery storage

**Files:**
- Create: `src/server/auth/claim.ts`, `src/server/auth/claim.test.ts`
- Modify: `src/server/auth/credentials.ts` (`saveCredentials` gains optional `recoveryHash`), `src/server/auth/credentials.test.ts`

**Interfaces:**
- Produces (`claim.ts`):
  - `CLAIM_COOKIE = "__Host-sb_claim"`; `claimCookie(token: string): string`; `readClaimToken(cookieHeader: string | null): string | null`; `newClaimToken(): string` (base64url of 32 random bytes); `hashClaimToken(token: string): Promise<string>` (SHA-256 hex).
  - `interface NewAdmin { secretHash: string; sessionSecret: string; recoveryHash: string; nowIso: string }`
  - `claimAdmin(db, a: NewAdmin & { claimTokenHash: string }): Promise<boolean>` — one `db.batch`: `INSERT INTO admin_credentials ... SELECT 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admin_credentials)`, then `UPDATE auth_settings SET claim_token_hash, recovery_hash, recovery_created_at WHERE id = 1 AND EXISTS (SELECT 1 FROM admin_credentials WHERE secret_hash = ?)` (the secret hash carries a random salt, so it proves the first statement was **this** caller's). True iff the insert changed one row.
  - `reissueClaim(db, a: NewAdmin & { claimTokenHash: string }): Promise<boolean>` — replaces credentials and recovery only `WHERE claim_token_hash = ?` and `first_login_at IS NULL`.
  - `recoverAdmin(db, a: NewAdmin & { oldRecoveryHash: string }): Promise<boolean>` — batch: (1) `UPDATE auth_settings SET recovery_hash = new, recovery_created_at, mode = 'password', changed_at, changed_by = 'recovery' WHERE id = 1 AND recovery_hash = old` (compare-and-set); (2) upsert `admin_credentials` (new secret hash and session secret) `WHERE EXISTS (SELECT 1 FROM auth_settings WHERE recovery_hash = new)`, **leaving `first_login_at` untouched**. True iff (1) changed one row.
  - `saveCredentials(db, { secretHash, sessionSecret, createdAt, recoveryHash? }): Promise<boolean>` — when `recoveryHash` is given, a second statement in the same batch sets it `WHERE EXISTS (SELECT 1 FROM admin_credentials WHERE secret_hash = ? AND first_login_at IS NULL)`.

- [ ] **Step 1: Failing tests**
  - cookie helpers: `claimCookie("t")` equals `"__Host-sb_claim=t; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400"`; `readClaimToken` finds it among other cookies and returns null when absent; `hashClaimToken` is 64 hex characters and deterministic.
  - `"claimAdmin succeeds once; a second claim returns false and changes nothing"`.
  - **`"two concurrent claimAdmin calls: exactly one true, one credentials row, and recovery_hash/claim_token_hash are the winner's"`** (`Promise.all`; compare against which `secretHash` is stored).
  - `reissueClaim`: right token replaces secret and recovery; wrong token false; after `first_login_at` is set false.
  - `recoverAdmin`: right old hash → true, new recovery stored, `mode password`, `changed_by recovery`, credentials replaced, **`first_login_at` preserved**; wrong old hash → false, nothing changed; **two concurrent calls with the same old hash: exactly one true**; works when no credentials row exists (inserts one); resets `mode` from `access` to `password`.
  - `saveCredentials` with `recoveryHash` stores both; without leaves `recovery_hash` unchanged; existing tests still pass.
- [ ] **Step 2: Run** `npx vitest run src/server/auth/claim.test.ts src/server/auth/credentials.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Use `db.batch` results (`meta.changes`, or `RETURNING` rows) to decide the boolean. Note D1 batches are transactional.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `"Atomic claim, reissue and recovery storage"`.

### Task 6: `/api/setup`: code flow, claim, reissue, state

**Files:**
- Modify: `src/routes/api/setup.ts`, `src/worker/routes.ts` (register `GET /api/setup`), `src/worker/routes.test.ts:11,47,76`-style pins, `src/routes/api/setup.test.ts`

**Interfaces:**
- Consumes: `readSetup`, `claimAdmin`, `reissueClaim`, `saveCredentials`, cookie helpers, `generateAdminSecret`, `hashAdminSecret`, `base64urlEncode`.
- Produces: `POST /api/setup` → 200 `{ secret: string; recoveryCode: string }`. State `open`: today's code flow, now also generating and storing a recovery code. State `claim`: body `{}` (no code), `claimAdmin`, then `Set-Cookie: claimCookie(token)`; lost race → 409 `already_set_up`, "This site has already been set up. Sign in instead." State `claimed`: `reissueClaim` with the cookie's hash; false → same 409. `closed` → 404; `not_ready` → 503 with `reason`-specific text (short code: "Setup isn't ready: SETUP_CODE must be at least 12 characters."; expired: the 3.5 wording). `createSetupStatusHandler(deps)`: `GET /api/setup` → 200 `{ state: "code" | "claim" | "reissue" | "taken" }` (`claimed` with a matching cookie hash is `reissue`, else `taken`), 404 when closed, 503 when not ready; **never writes**. All responses `no-store`.

- [ ] **Step 1: Failing tests** (extend `src/routes/api/setup.test.ts`; use `claimEnv` for claim cases and the existing harness for code cases)
  - claim: `POST {}` → 200, `secret` and `recoveryCode` both 43 characters, the stored hashes verify with `verifyAdminSecret`, `Set-Cookie` exactly as in Global Constraints.
  - **`"a second claim without the cookie is 409 and changes nothing"`**; with the cookie → 200 with a new secret, the old secret no longer verifies (reissue).
  - **`"two concurrent claims: one 200, one 409"`** (Review Focus 1).
  - cross-origin POST → 403; invalid JSON → 400; nothing from either response reaches `console.*` (spy).
  - **`"a claim at minute 29 can sign in at minute 31"`**: claim, `ageWindow(db, 31 * 60_000)`, then the login handler with the secret → 200 and `first_login_at` set; `/api/setup` then 404.
  - expired window, no code → POST 503 with the expired text; short `SETUP_CODE` → 503 short-code text.
  - code flow: right code → 200 with `recoveryCode`, `recovery_hash` stored; wrong code → 401 unchanged; per-client and global limits unchanged (existing tests keep passing).
  - **`"GET /api/setup never creates credentials"`**: for each of `code`, `claim`, `reissue`, `taken`, assert the returned state and `SELECT count(*) FROM admin_credentials` unchanged (Review Focus 2). `routes.test.ts` gains the new public route.
- [ ] **Step 2: Run** `npx vitest run src/routes/api/setup.test.ts src/worker/routes.test.ts` → FAIL.
- [ ] **Step 3: Implement**, reusing the existing gate order (state, same-origin, body size, JSON) and the existing error helpers; the `claim` branch skips the code and the rate-limit counters (there is nothing to guess).
- [ ] **Step 4: Run** → PASS; `npm run typecheck`. **Step 5: Commit** `"/api/setup: claim window, claim cookie, recovery code, state endpoint"`.

### Task 7: The setup page and the shared "save these now" screen

**Files:**
- Create: `public/save-screen.js`, `public/save-screen.test.ts`
- Modify: `public/setup.html`, `public/setup.js`, `public/setup.test.ts`

**Interfaces:**
- Produces: `showSaveScreen(doc: { document: Document; navigator: Navigator; navigate: (url: string) => void }, v: { secret: string; recoveryCode: string; signInUrl?: string }): void` — reveals `#secret-step`, fills `#secret` and `#recovery`, wires `#copy` and `#copy-recovery` (each copies its own value and writes `#copy-status`), and enables `#sign-in` only after the **single** `#saved` tick ("I've saved both"); `#sign-in` navigates to `signInUrl ?? "/admin/login"`.
- Consumes: `GET /api/setup` and `POST /api/setup` (Task 6).
- `setup.html` gains `#claim-step` (heading, explanation text from design 3.5, one `button#claim`) and `#taken-step` (message and a "Sign in" link to `/admin/login`); the existing code form stays as `#setup-form`. **No new `<input>`** (the existing test asserts exactly two).

- [ ] **Step 1: Failing tests** (happy-dom, scripts stripped, `init` called with a `vi.fn` fetch, as `setup.test.ts` does)
  - state `code` shows `#setup-form` and hides the others; `claim` shows `#claim-step` only; `reissue` shows it with the button text "Show me a new secret"; `taken` shows `#taken-step` with the sign-in link.
  - pressing `#claim` POSTs `{}` to `/api/setup` once (double press ignored) and shows both values; a 409 shows the taken step; a 404 shows the existing "already completed" text; a network error shows the generic error.
  - `save-screen.test.ts`: `#sign-in` disabled until `#saved` is ticked; `#copy` copies the secret and `#copy-recovery` copies the code (assert `navigator.clipboard.writeText` calls); neither value is written anywhere but its element (no `location`, `localStorage` or `sessionStorage` writes).
  - the `<input` count assertion still holds (two).
- [ ] **Step 2: Run** `npx vitest run public/setup.test.ts public/save-screen.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `setup.js` `init` first `GET`s `/api/setup`, then shows the right step; move the existing step-2 code into `save-screen.js`.
- [ ] **Step 4: Run** → PASS; `npm run typecheck`. **Step 5: Commit** `"Setup page: claim step and a save screen for the secret and the recovery code"`.

### Task 8: Redirects and messages

**Files:**
- Modify: `src/worker/guards.ts:53`, `src/worker/static.ts` (`serveLandingPage` at l.14, `serveSetupPage` at l.43-51), tests `src/worker/guards-pages.test.ts:95-117`, `src/worker/worker.test.ts:532-690`

**Interfaces:**
- Consumes: `setupState`/`readSetup`, `claimOpenCached` (Task 4).
- Produces: `guardAdminPage` redirects to `/setup` (302, `no-store`) when `awaitingSetup` and the state is `open` **or** `claim`; otherwise unchanged (503 when not ready). `serveLandingPage` returns `302 /setup` (`no-store`) for `GET` of `/` when `claimOpenCached` is true, else today's behaviour; `HEAD` and every other path never redirect. `serveSetupPage` serves the page in `open | claim | claimed`, 404 for `closed`, 503 for `not_ready` with the `reason` texts of Task 6.

- [ ] **Step 1: Failing tests**
  - guards: `claim` → 302 `/setup`; `claimed` → 302 `/admin/login`; expired → 503 and **no** redirect; `open` unchanged.
  - worker: `GET /` in `claim` → 302 `/setup` with `Cache-Control: no-store`; **`HEAD /` in `claim` → 200, no redirect**; `GET /e/anything` and `GET /api/events` unaffected; after a claim `GET /` is 200; `GET /setup` returns the page in `claim` and `claimed`; the two 503 texts; **two `GET /` in a row on an unclaimable site read `auth_settings` once** (statement spy, Review Focus 2).
- [ ] **Step 2: Run** `npx vitest run src/worker` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm test`. **Step 5: Commit** `"Send / and the admin pages to the claim page while the window is open"`.

### Task 9: `/recover`

**Files:**
- Create: `src/routes/api/recover.ts`, `src/routes/api/recover.test.ts`, `public/recover.html`, `public/recover.js`, `public/recover.test.ts`
- Modify: `src/server/auth/ratelimit.ts` (+ `ratelimit.test.ts`), `src/worker/static.ts`, `src/worker/routes.ts`, `src/worker/routes.test.ts`, `wrangler.jsonc:25` (`run_worker_first` gains `"/recover"` at the end), `src/test/wrangler-config.test.ts:37-41`

**Interfaces:**
- Produces: `recoveryClientKey(ip: string | null, recoveryHash: string): Promise<string>` (HMAC keyed with the stored recovery hash, message `slot-booker-recover-ratelimit-v1:<bucket>`); `createRecoverHandler(deps: AuthDeps = {}): RouteHandler` and `onRequestPost`; `serveRecoverPage: RouteHandler` (404 unless `recovery_hash` is set and `envCredentialsSet(env)` is false; otherwise `public/recover.html`, `no-store`); routes `GET /recover` and `POST /api/recover`, both public.
- `POST /api/recover` body `{ code: string }`, in order: availability (404), same-origin (403), body size and JSON (as setup), `trimAdminSecret`, per-client `countAttempt` (429 with `Retry-After`), constant-time check (`parseAdminSecretHash`, `verifyAdminSecret`; 401 `invalid_recovery_code`), then new secret and new recovery code, `recoverAdmin`; false → 409 `recovery_code_used`. Success: 200 `{ secret, recoveryCode, envPinned }` where `envPinned = env.ADMIN_AUTH === "access"`; `clearAttempts` for the client. `recover.js` shows the Task 7 save screen, plus a notice when `envPinned` ("Sign-in is still set to Access in your deployment settings: remove `ADMIN_AUTH` there too").

- [ ] **Step 1: Failing tests**
  - handler: no recovery hash → 404; env credentials set → 404; wrong code → 401; **the sixth wrong attempt from one client → 429**, and a different client is unaffected, **and 31 attempts across clients never produce a global 429**; right code → 200, old code then 401, old secret no longer verifies, new secret does, `first_login_at` preserved so `/api/setup` stays 404; **a code typed with leading/trailing whitespace and zero-width characters is accepted** (client and server trim alike; assert `public/recover.js` trims with the same `trimAdminSecret` as `setup.js`); **two concurrent requests with one code: one 200, one 409**; from D1 `mode access` it switches to `password`; with `ADMIN_AUTH=access` in env the response has `envPinned: true`; neither secret reaches `console.*`.
  - `ratelimit.test.ts`: `recoveryClientKey` differs from `clientKey` and `setupClientKey` for the same address and from itself under a different recovery hash.
  - `recover.test.ts` (page): one input `#recovery-code`; success shows the save screen; 401, 429 (with minutes), 404 and `envPinned` texts.
  - config pins: `run_worker_first` equals `["/", "/e/*", "/api/*", "/admin", "/admin/*", "/setup", "/recover"]` for production and preview; `routes.test.ts` gains `"/recover"` in `PAGE_PATTERNS` (l.11) and `"POST /api/recover"` in its route list (l.76 region); Task 6 adds `"GET /api/setup"` there.
- [ ] **Step 2: Run** `npx vitest run src/routes/api/recover.test.ts public/recover.test.ts src/server/auth/ratelimit.test.ts src/test/wrangler-config.test.ts src/worker/routes.test.ts` → FAIL. **Step 3: Implement** (model the handler on `createSetupHandler`). **Step 4: Run** → PASS; `npm test`. **Step 5: Commit** `"Add /recover: reset the admin secret with the recovery code"`.

### Task 10: Deploy-button files

**Files:** Modify `.dev.vars.example`, `package.json` (`cloudflare.bindings`), `src/test/deploy-button.test.ts:83-85,96-119`.

- [ ] **Step 1: Update tests**: `"has no live line, so the button asks for no secret"` (`liveLines` length 0); the description tests keep `DB` only; delete the `SETUP_CODE` description test (l.115-119); keep a test that `# SETUP_CODE=` is present as a comment (design C6).
- [ ] **Step 2: Run** `npx vitest run src/test/deploy-button.test.ts` → FAIL.
- [ ] **Step 3: Edit** `.dev.vars.example`: comment `SETUP_CODE=` out and reword its comment ("Optional. Set it as a Worker secret to require a code on /setup, to reopen setup after the first-run window, and as recovery for the Access wizard"); reword l.14-15 (nothing sets `ADMIN_AUTH` for a password site); remove the `SETUP_CODE` entry from `package.json`.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `"Deploy button: no secret prompt"`.

### Task 11: Documentation

**Files:** the table in design section 7 ("Documentation" and the added rows) is the checklist: `README.md`, `docs/deploying.md`, `docs/admin-auth.md`, `docs/admin-guide.md`, `docs/handover.md`, `docs/development.md`, `docs/configuration.md`, `docs/sign-in.md`, `docs/known-limits.md`, `docs/costs.md`.

- [ ] **Step 1: README "What the form asks for"**, rewritten from the real form (design 2.1). The list, in order, with no password and no `SETUP_CODE`:
  1. **Your Git account** and the **"Create private Git repository"** checkbox (tick it if you want your copy private).
  2. **Project name.** The suggestion is fine. It is also your Worker's name, your copy's repository name and part of your site's address. If your account already has a repository of that name Cloudflare suggests the same name with `-1`; accept it.
  3. **Database.** Leave "Create new", and leave the suggested name, location hint and the read-replication checkbox as they are.
  4. **Build command** (empty) and **Deploy command** (`npm run deploy`): leave both.
  5. Add: "If Cloudflare shows a switch for Cloudflare Access or for preview builds, leave it off. Neither appeared on 22 October 2026."
  Then "Press **Deploy**. It takes about a minute."
- [ ] **Step 2: README "First run"**, replacing the `/setup` steps: find the address (below), open it, press **Create my admin secret**, copy **both** the admin secret and the recovery code into a password manager (ideally as two entries), tick **I've saved both**, go to sign-in. State the **30 minutes** from the database being created, that a second visitor is refused, and what to do after 30 minutes (set `SETUP_CODE`, see `docs/handover.md`). Remove the "Allow about 15 minutes" claim unless the next real run supports it.
- [ ] **Step 3: "Find your site's address"** (README and `docs/deploying.md`), in this order: (a) it is the `https://….workers.dev` line near the end of the build log; (b) in the Cloudflare dashboard open **Workers & Pages**, then your Worker (named as the project); its page shows the address (menu names **unverified**: verify on the post-implementation run and correct). Say "open that address, not `/setup`".
- [ ] **Step 4: the rest** per design section 7: `docs/admin-auth.md` (fail-closed wording for `ADMIN_AUTH`, the settings table, "First-run setup" rewritten, the D1-beats-env-credentials change at l.50, pinning, the exit statement, `/recover`); `docs/deploying.md` (remove the code paragraph and steps, troubleshooting entries, "Updating your copy" with an **Upgrading from v1.1** section: keep your own `vars`; a site with no admin and no `SETUP_CODE` gets a 30-minute window when the migration runs); `docs/handover.md` (lead recovery with `/recover`, the `auth_settings` reset and Access exit statements from design 3.1 and 3.8, "keep the recovery code"); `docs/admin-guide.md` (the first-time steps without a code); `docs/development.md`, `docs/configuration.md`, `docs/sign-in.md`; `docs/known-limits.md` (rate-limit sentence, the claim race); `docs/costs.md` (add `/recover` to the paths that reach the Worker; one cached read of `auth_settings` per isolate per minute on `/`).
- [ ] **Step 5: Check** with a script, not by eye: `grep -rn "SETUP_CODE" README.md docs .dev.vars.example package.json | grep -v "docs/design\|docs/plans"` — every remaining hit must describe the **optional** meaning; `grep -rn "workers.dev" README.md docs/deploying.md` shows the address guidance; run `npm test` (a docs test, if one exists, must pass).
- [ ] **Step 6: Commit** `"Docs: zero-config setup, recovery code, sign-in mode in D1, finding the address"`.

### Task 12: Reconcile the Access wizard design (other branch)

**Files:** `docs/design/access-wizard.md` on branch `docs/access-wizard-design`.

- [ ] **Step 1:** `git worktree add ../slot-booker-wizard docs/access-wizard-design` (never switch this tree's branch).
- [ ] **Step 2: Edit** in the worktree, per the rows added to design section 5: the migration is **`0020`** and only `ALTER TABLE auth_settings ADD COLUMN` for `access_app_id`, `access_policy_id`, `admin_emails`, `verify_nonce`, `verify_nonce_expires_at`, `verified_at`, `verified_config_hash`; section 1's table splits "created by zero-config `0019`" from "added by `0020`"; the resolution table and `vars.ADMIN_AUTH` removal are "already done by zero-config"; the Import button is only for env-Access sites nobody has signed in to (zero-config pins the rest); break-glass (lines 16, 29, 164-169, 202) is "`SETUP_CODE` valid **or** `auth_settings.recovery_hash` set", with `/recover` as the main route and the wizard refusing to enable Access without one; line 35's "`main` ends at `0018`" becomes "`0019` is `auth_settings`"; test names `migration-0020.test.ts`.
- [ ] **Step 3: Verify** `grep -n "0019\|SETUP_CODE" docs/design/access-wizard.md` in the worktree and read each hit; then `git add docs/design/access-wizard.md && git commit -m "Wizard design: build on the shared auth_settings table (0019), take 0020"` there, and `git worktree remove ../slot-booker-wizard`.

### Task 13: Verification and the real Deploy run

- [ ] **Step 1:** `npm test`, `npm run typecheck`, `npm run test:webkit` if it runs offline. Paste the summary lines. Fix before going on.
- [ ] **Step 2:** `git log --oneline main..HEAD` and `git diff --stat main..HEAD` read through once for stray files; no secrets, no `wrangler.json`.
- [ ] **Step 3 (owner runs it; the agent records the answers): design section 8.2**, on a fresh Worker and database with unique names (for example copy the branch to a scratch public repo as in 8.1: `git archive HEAD` into an empty directory, `git init`, push, use its Deploy URL). The form must show **no `ADMIN_AUTH` and no secret field**. Then the steps in 8.2: `/` redirects; GET `/setup` does not claim; one press shows both values; a second browser is refused; sign-in; `/recover` (wrong code, right code, old code dead); window expiry by aging `setup_opened_at` in the D1 console; a push does not reopen the window. Also confirm the dashboard menu names in the README's "Find your address" text and fix them. Clean up everything afterwards: Worker `wrangler delete --name <n> --force` and `wrangler d1 delete <db> -y` **from an empty directory**, then both repos.
- [ ] **Step 4:** record the result in design section 8.2 and commit `"Record the post-implementation Deploy button run"`.

---

## Decisions I made while planning (check these)

| # | Call | Where |
|---|---|---|
| P1 | Claim window, claim hash and recovery hash are **columns of `auth_settings`**, not separate tables, so the wizard extends one table. The design doc was changed to match (`8a92eb1`). | Task 1 |
| P2 | An env-Access site **pins itself** into D1 on its first authenticated `GET /api/admin/session`, which is what stops a lost `ADMIN_AUTH` line from downgrading it. Sites that never had an admin sign in through Access stay unprotected; the docs say so. | Task 2 |
| P3 | **D1 `access` beats leftover env password credentials**, a small change to the "D1 is never read" sentence in `docs/admin-auth.md`. | Task 2 |
| P4 | `/`'s claim check is memoised only when **false**, 60 s, per isolate, keyed by `env.DB`. | Task 4 |
| P5 | Claim cookie lives 24 hours. | Global Constraints |
| P6 | `GET /api/setup` is a new read-only route that tells the page which step to show, instead of rewriting the HTML. | Task 6 |
| P7 | `/recover` rate-limit key is keyed with the stored recovery hash. | Task 9 |
| P8 | The signed-in "make a recovery code" action for **existing signed-in sites** is **not** in this plan. A v1.1 site that kept its `SETUP_CODE` still has break-glass; one that did not has the D1 console route. It belongs to the wizard plan, which must require one of the two before enabling Access. | Task 12 |
| P9 | Exit from Access before the wizard exists is `/recover` or one D1 statement; editing `ADMIN_AUTH` back to `password` no longer does it (design 3.8). | Task 11 |

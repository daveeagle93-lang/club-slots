# Changelog

Tags v1.0 and v1.1 exist and have no entries here.

## v1.2 (unreleased: dated when it is tagged)

The Deploy to Cloudflare form no longer asks for any secret or variable. An organiser deploys, opens the site's address, and a 30-minute first-run window lets the first visitor press one button to create the admin secret and a recovery code. Both are shown once, on a single screen.

### Added

- First-run claim window. Migration `0019_auth_settings.sql` creates a one-row table, `auth_settings`. The window is 30 minutes from when that migration ran, so a redeploy does not reopen it.
  - While the window is open, `/` and the admin pages send visitors to the claim page.
  - Only pressing the button claims. Merely visiting the page, or a link preview fetching it, creates nothing.
  - A claim cookie lets the same browser replace the secret and code before the first sign-in (within a day).
  - A second visitor is refused.
- Recovery code and `/recover`. The code is shown once, with the secret. `/recover` makes a new secret and a new code, and the old code and sessions stop working.
- Sign-in mode stored in D1 (`auth_settings.mode`), with the `ADMIN_AUTH` environment variable as an override.
  - `access` in the environment wins.
  - Unset, or `password`, defers to the stored mode.
  - The first admin sign-in through Access set in the environment "pins" the Access settings into D1 (`changed_by = 'import'`).
  - To leave Access, use `/recover` or the documented SQL statement.
- `GET /api/admin/session` now returns `storedMode` (`access`, `password` or `null`) next to `identity`, `provider` and `csrfToken`.

### Changed

- `wrangler.jsonc` no longer has `vars` or `ADMIN_AUTH`. An unset `ADMIN_AUTH` means `password`. A value that is set to anything but `access` or `password` (an empty string included) still locks admin out with a 503.
- `SETUP_CODE` is optional. Setting it turns the claim window off, and `/setup` asks for the phrase, as in v1.1.
- The Deploy form therefore shows no secret or variable field (observed on a real run, 31 October 2026).
- `worker-configuration.d.ts` regenerated, and a test updated to be date-independent.
- Docs: README, deploying, admin-auth, sign-in, handover, known-limits and the design and plan docs updated.

### Fixed

- Saved theme colours seemed to revert to the default blue. The colours were stored correctly, but the browser kept serving its cached copy of `/api/theme.css` (for the minute after the change, and then once more because of `stale-while-revalidate`) on every page except the Settings page itself. The stylesheet now has `Cache-Control: public, max-age=60` with no `stale-while-revalidate`, and the Settings page replaces the browser's cached copy after a save or reset. Checked in Chromium only.

### Upgrading from v1.1

This is a summary. The full steps are in [docs/deploying.md](docs/deploying.md#upgrading-from-v11).

- Migration 0019 applies automatically on deploy: the `deploy` script runs migrations before `wrangler deploy`. Do not deploy the code first.
- A site whose admin has already signed in, or that has `SETUP_CODE` set, is unaffected. A site with no admin and no `SETUP_CODE` gets a 30-minute window starting when the migration runs.
- Sites on Cloudflare Access via `ADMIN_AUTH`: keep the `ADMIN_AUTH` line (and `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`) in your own `wrangler.jsonc`. Merging the template shows a conflict on `vars`: keep yours. Then:
  1. Deploy.
  2. Sign in once through Access.
  3. While signed in, open `/api/admin/session` and wait until it shows `"storedMode":"access"`.
  4. Only then remove the `ADMIN_AUTH` line.

  If `storedMode` is `password` or `null`, do not remove it. Removing it earlier drops the site back to the password sign-in and re-accepts any old admin secret.
- A copy configured through the git-ignored `account.local.json` and `npm run configure` (the maintainer's setup): leave `productionVars.ADMIN_AUTH` (and the Access values) there until `storedMode` is `access`. Then remove it, run `npm run configure` and deploy again. This comes from docs/admin-auth.md and docs/configuration.md, and I have not run it on a deployed copy.
- Password-mode sites can delete or keep the `ADMIN_AUTH` line.

### Known limits and not yet verified

- On the 31 October 2026 Deploy-button run, only part of the checklist was observed: the form, the build, the claim page with the secret and recovery code, and sign-in.
- `/recover`, window expiry and redeploy-on-push have not been run on a deployed copy.
- The v1.1 to v1.2 upgrade has not been run on a deployed copy.
- The Deploy form shows an "Enable Preview builds" switch that is on by default. I found no way to default it to off from the repository (see docs/deploying.md), so switch it off.

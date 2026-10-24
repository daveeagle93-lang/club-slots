# What it costs

A club's use should fit the free plans. Figures read from Cloudflare's documentation in September and October 2026; check the pages if it matters ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)).

- **Workers Free:** 100,000 requests a day to the Worker script and 10 ms of CPU per request. Static files served straight from `public/` (scripts, styles, icons) are free and unlimited.
- **What reaches the Worker:** `/`, `/e/*`, `/api/*`, `/admin`, `/admin/*`, `/setup` and `/recover`. On `/`, while the site is not open for its first-run claim, the Worker is expected to do at most one read of the `auth_settings` table per Worker instance per minute (a short cache; expected from the code, **not measured** on a deployed Worker). So one view of a booking page costs about one Worker request plus a few API calls (settings, `theme.css`, events, icons and the manifest; the browser caches each for minutes).
- **If the daily limit is passed,** those requests get a 429 until the day resets, and static files keep working.
- **D1 Free:** 5 million rows read a day, 100,000 rows written a day, 5 GB of storage and 10 databases per account.

Whether a real admin sign-in fits the 10 ms of CPU is **unverified**: the timings in the docs were taken locally, and local `workerd` does not apply the limit. The paths the docs flag are the admin login, the logo read and the logo and app-icon uploads (see [admin-auth.md](admin-auth.md) and [branding.md](branding.md)).

If visitors see a 429 error, see [Troubleshooting](deploying.md#visitors-get-a-429-error).

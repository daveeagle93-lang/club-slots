# Club settings, logo and theme

An admin can set the club's name, a privacy contact, a website, a logo and two theme colours at `/admin/settings` (the **Settings** button on the admin list). Nothing here needs a redeploy or an environment variable. This page says what each setting does, what is checked, what the public can read, and what has not been verified.

## Where the settings live

- **D1, two singleton tables** (`id` is always 1), created by `migrations/0009_site_settings.sql`, and a third, `site_icons`, created by `migrations/0011_site_icons.sql`:
  - `site_settings`: club name, privacy contact name and email, website, and the two theme colours (NULL means the default theme). The migration inserts the row, so a read always finds one. The table has its own CHECKs as a backstop behind the application's rules, with deliberate headroom because the application counts code points: club name at most 320 characters, privacy contact name 400, privacy contact email 254, website 300 and either empty or starting with `https://` (the `GLOB` is case-sensitive, and the application stores the lower-case normalised form). The theme colours must be NULL or lower-case `#rrggbb`.
  - `site_logo`: no row means no logo. The image bytes are in a BLOB column. The logo has its own table so that reading the text settings, which every public page does, never pulls the image.
  - `site_icons`: one row per app icon size (32, 180 and 512 px), each a PNG BLOB with the theme colour and the digest of what it was drawn from (the logo, or a fixed "default mark" marker when there is no logo). No rows means the bundled fallback icons are served. See "App icons".
- **Admin API**: `GET` and `PUT /api/admin/settings` (name, contact, website), `PUT` and `DELETE /api/admin/settings/logo`, `PUT` and `DELETE /api/admin/settings/theme`, and `PUT /api/admin/settings/icons/<size>` (app icons, below). `GET` also returns `logo` (with its `sha256`, which the page sends back with each icon), `theme` and `icons` (what the stored icons were drawn from, `{ background, logoSha256 }`, where `logoSha256` is 64 zeros for icons drawn from the default mark, or `null` unless all three sizes are stored and agree). They sit under `/api/admin/*`, so they get the same protection as the rest of the admin API: the sign-in check, then the same-origin and CSRF-token checks on every write (`docs/admin-auth.md`). Each handler also refuses a request with no signed-in identity (401).
- **Public API**: `GET /api/settings`, `GET /api/logo`, `GET /api/theme.css`, `GET /api/events`, `GET /api/icon/<size>`, `GET /api/manifest.webmanifest` and `GET /favicon.ico` (below).

## The fields and their rules

The rules are in `src/server/settings.ts`; the browser form adds nothing the server doesn't check. `PUT /api/admin/settings` replaces all three parts together: `clubName`, `privacyContact` (`name` and `email`) and `website` must all be sent, and any of the text can be empty, which means "not set". A refusal is a 400 `invalid_input` with a message per field (`clubName`, `website`, `privacyContact`, `privacyContact.name`, `privacyContact.email`).

Every text field is text, trimmed, at most the number of Unicode code points below, and can't contain unpaired surrogates, control characters, line or paragraph separators (U+2028, U+2029) or any Unicode format character (general category Cf, the same check the booking names use): soft hyphen, zero-width space, zero-width joiner and non-joiner, left-to-right and right-to-left marks, the Arabic letter mark (U+061C), bidi controls, word joiner, invisible operators, BOM and the tag characters. An emoji joined with a zero-width joiner, and a Persian or Indic word that needs a zero-width non-joiner, is therefore refused; a plain emoji is fine.

| Field | Limit | Extra rule |
| --- | --- | --- |
| Club name | 80 | None. |
| Privacy contact name | 100 | A name with no email is refused ("A privacy contact needs an email address."). |
| Privacy contact email | 254 | One plain address: letters and digits (any script) and `. _ + -` before the `@`, a domain with at least one dot, nothing else. No spaces, quotes, angle brackets, commas, semicolons or parentheses, so it can't be a list or a `Name <a@b.c>` form. |
| Website | 200 (after normalising) | Must start with `https://` (any case) and have no whitespace; `http:`, `javascript:`, `data:`, `//host` and a bare host are refused. It must parse as a URL with a host, and may not contain a user name or password. It is stored in the parser's normalised form (`url.href`, so a bare host gains a trailing `/`). |

The privacy contact counts as **set once it has an email**. The name alone is never enough, and `/api/settings` returns `privacyContact: null` until there is an email.

## Where each setting is used

- **Club name**
  - The header band at the top of every public and admin page (the name links to `/` on public pages and to `/admin/` on admin pages), and the page title (`<page> – <club>`; the page alone if no name is set; "Slot booker" is the fallback name in the header).
  - The first line of the calendar entry's description in the booking's `.ics` download (`src/core/ics.ts`, `src/server/ics.ts`).
  - The first line of the **Copy lineup** text (`src/core/lineup.ts`, built in `src/server/admin-event-edit.ts`).
  - The first line of the shared message (the Share button on the admin events list and schedule pages, and the new-event page; `buildShareMessage` in `public/share-message.js`). If the settings haven't loaded when the message is built, it has no club line.
  - With no name set, all three texts are as they were before this feature.
- **Logo**: in the header band next to the name. The browser tab icon, touch icon and manifest icons are drawn from it too (see "App icons"; with no logo they show the default mark on the theme's main colour). The header image has an empty `alt`, because the club name sits next to it.
- **Website**: a footer link on the public and admin pages showing the host name, opening in a new tab with `rel="noopener noreferrer"`. `public/branding.js` re-checks that it is an `https:` URL before using it.
- **Privacy contact**: a line at the end of the booking form's "Privacy" section, after the privacy notice: "Questions about your details, or want them deleted? Contact <name>, <email>." The email is a `mailto:` link, encoded so nothing in it can add a header or body.
- **Landing page** (`/`, `public/index.html`, `public/landing.js`): the heading is "Upcoming events", followed by the list. The club name is in the header band and in the page title, not in the heading.
- **Theme colours**: every page, through `/api/theme.css` (below).

If `/api/settings` can't be read, pages carry on without branding (default name, no logo, no contact).

### The admin warning when no contact is set

Until a privacy contact has an email, the booking page shows an "Admin notice" at the top, with a link to Settings, saying bookers aren't told who to contact about their details. Only an admin should see it, and the page decides that this way (`warnAdmin` in `public/booking.js`):

1. The page loads `/api/settings`. If that failed, it doesn't know, so it shows nothing. If a contact is set, it shows nothing and does nothing else.
2. If no contact is set, it makes **one** request to `/api/admin/session` with the browser's cookies. The banner is shown only if the answer is a `200` that was not redirected **and** whose JSON body has a non-empty string `identity`. A `401`, any redirect, a network failure, or a `200` with anything else (for example an HTML page from something in front of the site) shows nothing.
3. No contact is shown to anyone else. Visitors who aren't admins see no warning and no placeholder.

**Slow settings.** The booking form waits at most about 2 seconds for `/api/settings` (`settingsTimeoutMs` in `init`, default 2000 ms) before it appears, so a slow settings request cannot hold up booking. If the settings arrive after that, the header band is still added, the page title is corrected and the privacy contact (if one is set) is appended to the Privacy section without redrawing the form; but the admin banner is skipped for that page view, because the page no longer waits to find out. A page view where the settings failed or were late therefore never shows the banner.

Consequences:

- While the contact is unset, **every visitor's browser makes that request** on every booking-page view. Under the password provider it is answered with `401` (`503` on a new site that has no admin secret yet), visible in the browser's network tab and counted as a Worker request. Setting the contact removes it.
- Under Cloudflare Access, an unauthenticated visitor's request is redirected to the team's `cloudflareaccess.com` sign-in host. That is a different origin, and the page's CSP (`connect-src 'self'`) blocks it, so the request fails and the failure is swallowed. The `redirected` check covers the case where a redirect is followed within the same origin. I have not run this against a real Access deployment.
- The probe only decides whether to show a banner. It grants nothing: the session endpoint and the rest of the admin API still enforce their own checks.

## What the public can read

`GET /api/settings` (`Cache-Control: no-store`) returns exactly these keys:

- `clubName`: string or `null`
- `website`: string or `null`
- `privacyContact`: `{ name, email }` or `null` (`null` until there is an email)
- `logo`: `{ url, width, height }` or `null`

No timestamps, theme values or hashes (the `?v=` in the logo URL is the first 16 hex characters of the logo's SHA-256). Note that the privacy contact's email address is readable by anyone who requests this URL, not only people on the booking page: it is meant to be shown to bookers, but it is not hidden from others.

`GET /api/events` (`Cache-Control: no-store`) returns `{ "events": [ ... ] }` where each event has exactly `slug`, `name`, `startUtc` and `endUtc`. It lists events that are listed, not archived and have not started yet, soonest first, at most 50. It has no venue, details, cost, counts or ids.

**Privacy trade-off.** Before the landing page, an event's booking link (`/e/<slug>`) was known only to people who were given it. Now the booking links of all upcoming, non-archived, listed events can be discovered by anyone who opens `/` or requests `/api/events`. This was a decision by the maintainer, for a page that lists what is open. An event that should stay reachable only by link can be unticked "Listed on the home page" when it is created or edited: it then stays off `/` and `/api/events` (the admin pages mark it "Not listed") but its link, bookings and calendar file work as before; the public API does not say whether an event is listed. Every response the Worker sends, including `/`, carries `X-Robots-Tag: noindex` (`SECURITY_HEADERS` in `src/worker/headers.ts`, which the Worker's tests keep in step with `public/_headers`), which asks search engines not to index them; that is a request, not access control. The tests check the header on the Worker's responses; I have not seen it on a deployed site.

**Link previews.** When a link is pasted into a chat, the app that shows the preview reads the first HTML it is served and runs no scripts, so the pages that carry tags cannot wait for their own JavaScript. The Worker therefore writes a title and Open Graph tags into the static HTML of `/` and `/e/<slug>` before sending it (`src/worker/open-graph.ts`):

- `/e/<slug>`, for a live event: the title is the event name and its London date (such as `Sat 13 Jun 2026`), and the description is the club name, the venue postcode and the cost, with any that are missing left out. `og:site_name` is the club name if one is set.
- `/` and any unknown, invalid or archived slug get the generic tags: the club name (or "Slot booker") and "Book a slot at <club>'s upcoming events." The page is the same bytes for every such slug, so a preview reveals nothing about which slugs exist beyond what `GET /api/events/<slug>` already says.
- The image is `/api/icon/512`, the club's 512 px icon, or the bundled fallback icon if none is stored yet.
- Only public data is used: the details text, ids, breaks, bookings, the listed flag and the privacy contact never appear. If the database can't be read, the generic tags are sent.

I have not seen a preview in a real WhatsApp chat, or in any other app. WhatsApp keeps previews it has already made for a link, so an event renamed after its link was first shared may keep showing the old preview for a while; I don't know for how long.

**Worker requests per public page view.** Counted from `public/index.html`, `public/event.html` and their scripts (`public/landing.js`, `public/booking.js`, `public/branding.js`), a view that finds nothing in the browser cache makes:

| Page | Requests to the Worker |
| --- | --- |
| Landing page `/` | The page itself (the Worker adds the link-preview tags, reading the settings from D1), then `/api/theme.css`, `/api/icon/32`, `/api/icon/180` and `/api/manifest.webmanifest` (all `<link>`s), `/api/settings`, `/api/events`, and `/api/logo?v=…` for the header image if a logo is set: 7, or 8 with a logo. |
| Booking page `/e/<slug>` | The page itself (the Worker adds the tags, reading the event and the settings from D1), then `/api/theme.css`, `/api/icon/32`, `/api/icon/180`, `/api/manifest.webmanifest`, `/api/settings`, `/api/events/<slug>` (the event itself, which the page always needed), and `/api/logo?v=…` if a logo is set: 7, or 8 with a logo. Plus `/api/admin/session` while no privacy contact is set (above). |

`/` and `/e/*` are in `run_worker_first` in `wrangler.jsonc`, which is why the page itself is a Worker request. `public/style.css`, the scripts and the bundled fallback icons (`/icons/`) are not listed there, so they are served from `public/` without the Worker running (that is what `run_worker_first` says; I haven't checked how Cloudflare counts or bills those). Browsers differ over which icon and manifest links they fetch on their own, so 7 is the most a view makes without a logo, not a measured figure. What the headers allow the browser to reuse: `/api/theme.css` for a minute (below), the icons and the manifest for five minutes, the header image for a year, and `/api/settings` and the events not at all (`no-store`), so those two are requested on every view. A visitor who returns within a minute can therefore make as few as 3 requests per view (the page, `/api/settings` and the events request, plus the session probe where it applies). These counts come from reading the code, not from a network trace, and I have not measured what they mean for the Workers Free plan's daily request allowance; they are more per view than before the landing page and the Worker move.

## The logo

**In the browser** (`public/admin/logo-image.js`; a convenience, not the gate): the file picker accepts PNG, JPEG or WebP; anything over 20 MB is not decoded. The picture is drawn onto a canvas scaled to fit within 512 px on its longest side (never enlarged), and exported as WebP at quality 0.9, then 0.8, 0.7 and 0.5 until it is 200 KiB or smaller; if still too big the size is cut to 75% and the loop tries again, up to four times, before giving up with a message. A browser that can't export WebP hands back PNG, which is accepted as is and shrunk instead of re-compressed. The result is shown as a preview and is not saved until **Use this logo** is pressed. Decoding uses `createImageBitmap`, falling back to an `<img>` with a `data:` URL (the CSP does not allow `blob:`).

**On the server** (`PUT /api/admin/settings/logo`, `src/core/image.ts`; this is the gate). The body is JSON, `{ "data": "<base64>" }`, so the admin CSRF checks apply unchanged. In order:

1. Body at most 300,000 bytes, and the base64 text no longer than a 200 KiB image needs; otherwise 413 `too_large`. Only standard padded base64 (`+` and `/`) is accepted; anything else is a 400.
2. The type comes **only from the magic bytes**: PNG, JPEG or WebP. Nothing the client says about the file (name, type) is used. SVG, GIF, ICO, PDF, HTML and everything else are refused (422 `invalid_image`, reason `unsupported_type`), SVG because it can carry script.
3. Size cap 204,800 bytes (200 KiB), and empty files are refused.
4. The structure is walked end to end, and each of these is `corrupt` (reason `corrupt`):
   - **PNG**: chunks to an `IEND` that ends exactly at the end of the file. A PNG with an `acTL` chunk (an animated PNG, APNG) is refused.
   - **JPEG**: markers to an `EOI` that is the last two bytes, with exactly one start-of-image (SOI) and exactly one start-of-frame (SOF) marker, so a second picture inside the file is refused. The only markers allowed to have no length are `TEM` and the restart markers `RSTn`.
   - **WebP**: chunks that fill the RIFF size exactly. A file whose `VP8X` header has the animation flag set, or that contains an `ANIM` or `ANMF` chunk, is refused.
   - Trailing bytes, a second file or a truncated image are `corrupt` as well. A parse that runs off the buffer is `corrupt`, not an error.

   In short: a static logo only. Animated WebP and animated PNG are refused.
5. Each side must be 1 to 512 pixels (reason `dimensions`).

**Metadata is not stripped by the server.** The checks above decide whether the bytes are an acceptable image; they do not rewrite it. A logo uploaded through the Settings page has been re-encoded by the browser's canvas, which drops EXIF and similar metadata. An admin who sends a file **directly to the API** (a request that passes the sign-in and CSRF checks) keeps whatever metadata is in it, within the structure rules above, and `GET /api/logo` serves those bytes to anyone.

The logo is then stored in `site_logo` (D1), with its type, size, dimensions and SHA-256. The table has its own CHECKs as a backstop (type allow-list, 1 to 204,800 bytes, sides 1 to 512). `DELETE` removes it, and removing a logo that isn't there is not an error.

**Serving** (`GET` or `HEAD /api/logo`, `src/routes/api/logo.ts`):

- `Content-Type` is the stored, allow-listed type, with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, so the response can't be sniffed into something else or run as a page.
- `ETag` is the SHA-256. A conditional request (any `If-None-Match`) and every `HEAD` are answered from the row's metadata, without reading the image: a matching tag gets `304`, and `HEAD` gets the headers with `Content-Type` and `Content-Length`. A conditional `GET` whose tag doesn't match, and a plain `GET`, read the image from D1.
- Pages use `/api/logo?v=<first 16 hex of the SHA-256>`. When `v` matches the current logo the response is `Cache-Control: public, max-age=31536000, immutable`; otherwise (a bare `/api/logo`, which no page uses now, or a stale `v`) it is `public, max-age=300`. A new logo gives a new `v`, so the long lifetime is safe for the header image.
- With no logo: 404 with `Cache-Control: public, max-age=300`, so a browser may remember "no logo" for five minutes. Other methods: 405.

## App icons

The browser tab icon, the Apple touch icon and the web app manifest's icons are made from the logo, or with no logo from a default mark, on the theme's main colour. They are drawn in the browser, because the Worker can't draw.

- **Pages.** Every page links `/api/icon/32` (tab icon), `/api/icon/180` (touch icon) and `/api/manifest.webmanifest` (admin pages use `?for=admin`, so an installed admin app opens `/admin/`; any other query gives the public start page). There is no SVG icon link: browsers prefer an SVG, so one would hide the generated PNG, and the default mark would then stay in the default blue whatever the club's colour.
- **Drawing** (`public/admin/icon-image.js`, run by the Settings page). Three square PNGs, 32, 180 and 512 px: the main colour as the background, and either the logo or, with no logo, the default mark, scaled to fit inside a 14% margin (the same padding and the same shrink-until-it-fits loop for both). The default mark is the ring and clock hand of `public/icons/default.svg`, drawn directly with canvas strokes (a test checks the numbers against the SVG), in the text colour for the main colour, the same white or dark `textOn` picks for button text (white on the default blue).
- **When it runs.** After a logo upload (from the logo), after a logo removal (default mark), after a colour save or reset that changes the main colour (from whatever is current), and when Settings loads and the stored icons are missing or were drawn on a different colour or from something else than the current logo or default mark (the page "heals" them).
- **Storing.** One `PUT /api/admin/settings/icons/<size>` per size, body `{ data, background, logoSha256 }`, admin-only with the usual CSRF checks. The server checks the bytes itself, like the logo: still PNG only, exactly `<size>` by `<size>`, no trailing data, and at most 16 KiB (32 px), 96 KiB (180 px) or 200 KiB (512 px). `background` must be the current main colour (otherwise 409 `stale_theme`). `logoSha256` must be the current logo, or, while there is no logo, `DEFAULT_MARK_SOURCE` (`src/server/settings.ts`; 64 zeros, kept equal to the browser's constant by a test); otherwise 409 `stale_logo`. The insert itself only happens while that still holds (a stored logo with that digest, or no stored logo for the default mark), so a logo uploaded or removed between the check and the write can't leave an icon from the wrong source. They are kept in `site_icons`. Saving or removing the logo deletes them in the same batch, so an icon is never kept from a replaced logo.
- **Serving.** `/api/icon/<size>` (and `/favicon.ico`, which is the 32 px icon) sends the stored PNG, or the bundled one from `public/icons/` for any size with none stored: never a 404, and the fallback is sent uncached if D1 can't be read. Those bundled files are the default mark on the default blue; they are only what is served before the Settings page has drawn the club's own icons (a new site, or after the logo changed). `ETag` is the SHA-256, `Cache-Control: public, max-age=300`, and the headers are the logo's (`nosniff`, `default-src 'none'; sandbox`). The manifest uses the club name (or "Slot booker"), the main colour as `theme_color`, and the 180 and 512 px icons, and is also cached for five minutes.
- **If it fails.** An icon failure never blocks or undoes the logo or colour save. The Settings page shows its own line, for example "The logo was saved, but the app icons couldn't be updated. They'll be tried again next time you open this page.", and opening Settings again retries. One cause is a server refusal, for example a 512 px PNG over 200 KiB; another is a browser that can't export PNG. Until the icons are redrawn, a changed logo shows the bundled fallback icons (they were deleted with the old logo) and a changed colour shows the old-colour icons.
- **The one gap with no logo.** A colour change made through the Settings page redraws the default-mark icons as part of the same action, so they follow the colour. If the admin closes the tab after saving the colours but before the icons are drawn, the stored icons stay in the previous colour until Settings is next opened, when the heal redraws them. The same happens to a colour changed through the API directly.

## The theme

Two colours: **main** (buttons, selected slots, the header band) and **accent** (links and outlined buttons). Defaults are `#0b5cad` for both, which is what `public/style.css` already used.

- **Presets** (`public/theme.js`): Ocean (the default), Forest, Berry, Ember, Teal and Slate, each with the same main and accent colour. Or pick any two colours with the colour pickers.
- **Hex only.** The only accepted input is `#rgb` or `#rrggbb` (any case, surrounding spaces allowed, 64 characters at most), stored as lower-case `#rrggbb`. The database CHECKs the same shape.
- **Text colours are chosen automatically.** The text on a main-colour fill (`--on-primary`) is white or the page's dark text colour (`#14181f`), whichever has more contrast. Nobody picks it.
- **Dark mode is derived automatically.** There is no second set of colours to enter. The main colour is lightened in 2% steps towards white until it reaches contrast 3 against both the dark page and the dark card (buttons and selected slots sit on cards) and its button text reaches 4.5; the accent is lightened until it reaches 4.5 on both dark surfaces. The steps are fixed, so the same input always gives the same output. The last step is pure white, which passes every check below.
- **Contrast checks** (WCAG 2.x ratios, `checkTheme` in `public/theme.js`), run in both light and dark mode:
  - Blocking, each with a minimum of 4.5 (a theme that fails any of these can't be saved): `text-{mode}-page` and `text-{mode}-card` (main text on the page background and on cards), `muted-{mode}-page` and `muted-{mode}-card` (secondary text on each; these four depend only on the fixed page colours, so they are included for completeness), `button-text-{mode}` (the button text on the main colour), and `accent-{mode}-page` and `accent-{mode}-card` (the accent on the page background and on cards). That is seven checks per mode, 14 in all; the light-mode ones are unchanged.
  - Advice only (shown, does not stop a save), minimum 3, so buttons stand out: `button-shape-{mode}` (the main colour against the page background) and `button-shape-{mode}-card` (the main colour against cards). Four in all. In dark mode the derived main colour always reaches 3 on both, so in practice a warning can only come from the light-mode ones.
  - Ratios are shown rounded down, so a displayed 4.5 is never a fail.
- **The server enforces the block.** `PUT /api/admin/settings/theme` runs the same `checkTheme` (the same file is imported by the browser and the Worker). Non-hex colours are a 400 `invalid_input` with a message per colour. A failing blocking check is a 422 `theme_contrast` with the failing checks (`id`, `label`, `mode`, `ratio`, `min`). The form disables Save for the same reason, but that is a convenience. `DELETE` goes back to the default theme.
- **`/api/theme.css`** (`src/routes/api/theme.css.ts`) is the stylesheet every page loads. It is built only by `themeCss`, which accepts nothing except colours that passed `normaliseHex` and concatenates them into constant text, so no administrator-supplied string reaches the CSS. The query string is never read. What is stored is checked again on every read (`loadTheme`): a value edited into the database by hand that isn't a valid hex pair, or fails a blocking check, is served as the default theme. If the database read fails, the default colours are served with `Cache-Control: no-store` instead of an error. Otherwise it sends `Cache-Control: public, max-age=60, stale-while-revalidate=300` with an `ETag` (the SHA-256 of the stylesheet), and a matching `If-None-Match` gets `304`. In plain terms: a cache may reuse the stylesheet for 60 seconds without asking; after that it may keep showing the old copy for up to 300 more seconds while it fetches a fresh one in the background, so a visitor who returns later can see the previous colours for one more page view. A saved change therefore reaches most visitors within about a minute, and in the worst case a visitor whose browser honours `stale-while-revalidate` can still see the old colours once, up to about six minutes after the change. I have not tested this in a browser, and I have not checked whether Cloudflare's own cache holds the response. The admin Settings page is not affected: after a save it points its own stylesheet link at `/api/theme.css?v=<time>`, a URL the cache has not seen, so the admin sees the change at once.
- **CSS variables**: `--primary`, `--on-primary` and `--accent`, in `:root` for light and inside `@media (prefers-color-scheme: dark)` for dark. `public/style.css` declares the same three variables with the values the default theme produces, in both modes, so pages look right if `/api/theme.css` fails to load. `public/theme.test.ts` compares the fixed page colours that `public/theme.js` uses with those in `style.css`, and compares the three fallback variables in `style.css` with the default theme's output (`themeTokens(DEFAULT_THEME)`) in both modes, and checks that the two preview `--border` values in `public/admin/admin.css` equal the ones in `style.css`. Running `themeCss(DEFAULT_THEME)` gives `#0b5cad / #ffffff / #0b5cad` for light and `#236cb5 / #ffffff / #4f8ac4` for dark (`--primary / --on-primary / --accent`), the same as `style.css`.
- **No inline styles.** The CSP (`SECURITY_HEADERS` in `src/worker/headers.ts`, mirrored in `public/_headers`) includes `style-src 'self'` (no `'unsafe-inline'`; it also has `manifest-src 'self'` for the web app manifest), and the admin form follows that: the preview panels set their colours with the CSSOM (`element.style.setProperty`), which the CSP allows, rather than `style` attributes or `<style>` blocks. After a save, the page re-points its own stylesheet link at `/api/theme.css?v=<time>` so the change shows without a reload.
- **Announcements.** The contrast detail block on the Settings page is rebuilt on every colour input and is not a live region. A separate, visually hidden status line announces the overall result (colours can't be saved yet, all checks pass, or advice about the main colour), and its text changes only when that result changes, so a screen reader is not read a stream while a picker is dragged. The preset grid is responsive (`repeat(auto-fill, minmax(8.5rem, 1fr))`, one column at 320 px and two from about 360 px, as measured in the browser pass below).

## Known limits

- **The header name doesn't refresh after saving the club name.** The Settings page's preview panels follow what you type, but the header band and the title keep the old name until the page is reloaded. (The logo is likewise shown in the header as loaded.)
- **Settings changes are not logged anywhere.** There is no audit-log table, so there is no record of who changed the name, contact, logo or colours, or when (`updated_at` holds only the last change time). The control is that every settings route is admin-only and CSRF-protected, which the tests assert (`src/routes/api/admin/settings/access-control.test.ts`).
- **`PRIVACY_NOTICE` still works.** The settings page's privacy contact is appended under whichever notice is in use, the default or the club's own. A club that already names a contact in its own `PRIVACY_NOTICE` will therefore show two (see `docs/configuration.md`).
- **One logo, one theme, one set of details.** No per-event branding, and no history of earlier logos.
- **The tab icon and manifest can lag by up to five minutes** after a change, because `/api/icon/<size>` and the manifest are cached for that long (see "App icons"). I have not checked how long browsers keep a tab icon of their own accord.
- **Icons are drawn in the browser**, so an icon only updates when an admin opens Settings after a logo or theme change made through the API directly (a new logo made that way also deletes the stored icons, so the bundled fallback icons, in the default blue, are served until then). The same applies to a logo removed through the API directly.
- **Concurrent edits of the club details are last-write-wins.** `PUT /api/admin/settings` is an upsert with no version or `updated_at` check, so if two admins save at once, the later save silently replaces the earlier one. The same goes for the logo and the theme.
- **Names can't contain joiners, and some blank-looking characters still pass.** Every format character (category Cf) is refused (`INVISIBLE` in `src/server/bookings.ts`), so emoji joined with a zero-width joiner and Persian or Indic words that need a zero-width non-joiner can't be entered. On an edit, a value left exactly as it is stored is kept even if it contains one (text saved before the check existed), and only a changed value is checked. App icons are separate: if a PNG comes out larger than its size allows, the settings page redraws that size with the logo smaller, down to about a third, and reports a failure only if even that is too big. Characters outside Cf that render as blank, such as U+3164 (Hangul filler) and U+2800 (braille blank), are accepted in these fields, so an admin could make the club name look blank. (A dog's or handler's name is stricter: it must contain a letter or number, and invisible characters are ignored when checking for a repeat booking, see `identityKey` in `src/core/identity.ts`.) This is cosmetic and admin-only: only a signed-in admin can set these fields.
- **The logo's pixel size is not checked before the browser decodes it.** The file picker caps the input at 20 MB, but a small file can declare enormous dimensions, and the browser decodes it before the 512 px resize. An admin could crash their own tab this way; the server is not affected, because it checks the dimensions in the header of whatever is sent to it.
- **The Cache API is not used for the logo.** Every request that isn't answered from a browser cache or a 304/HEAD metadata read goes to D1 and reads the image.
- **More Worker requests per page view than before.** Each public page view makes several (see "What the public can read" for the count), so the Workers Free daily request allowance goes further than it did before this feature.
- **Migration 0009 was edited in place before any deployment.** The schema CHECKs on the text settings were added to `migrations/0009_site_settings.sql` itself, not in a new migration. As far as is known it had not been applied to any database by this project's docs before that edit, so nothing here needs resetting. This is a note for anyone who applied an earlier draft of 0009 (for example to a local database): that database won't have those CHECKs, and since Wrangler tracks migrations by file name it will most likely not re-run the edited file (I have not tested this), so reset that database or add the CHECKs yourself.

## Not verified

- **Remote D1.** All of this was run against local D1 (measured locally with an earlier build) and in the tests, not against a remote database. I have not verified how remote D1 returns a BLOB (the code accepts an array of numbers or an `ArrayBuffer`), that a 200 KiB BLOB fits its row and parameter limits, or that the migration's `GLOB` CHECKs apply as written (D1 limits `GLOB` patterns to 50 bytes, which is why the colour pattern is split in two).
- **CPU on Workers Free.** Reading the logo (a BLOB up to 200 KiB converted from D1's result) and the upload path (base64 decode, structure walk, SHA-256, insert) have not been timed on real Workers, and local workerd does not enforce the 10 ms CPU limit. `GET /api/logo` is the likeliest to matter, because every first view of a page that doesn't have the logo cached reads it.
- **Cloudflare Access.** The admin-only banner probe under Access (above) was reasoned from the code and its tests, not seen against a real Access application.
- **Request volume.** The extra Worker requests per page view have not been measured against the Free plan allowance.

## What was checked in a browser

Checked in headless Chromium 1243 (desktop, emulating phone viewports at 320/360/390 px, light and dark) against a scratch copy with local D1 and password sign-in, on 2026-10-05. It was run twice, before and after the review fixes (preset grid, wide logo, dark-mode contrast on cards, slow settings, animated images and the other fixes were re-checked in the second pass, which passed). It passed:

- the landing page
- the booking page
- the settings forms, including field errors
- the admin-only banner and contact
- logo upload through the file input for PNG, JPEG and WebP
- refusal of SVG and GIF, and of bypass uploads sent straight to the API (SVG, trailing junk, a 20000x20000 header, a 300 KB body, no CSRF token)
- theme presets, custom colours, the contrast block and reset
- CSS-injection strings sent straight to the API
- no CSP violations on any page
- no horizontal scroll at 320 px

A later headless Chromium pass (local D1, password sign-in) checked the icons and manifest on every page: 176 checks passed, with 0 CSP violations. Icon generation from an uploaded logo and from a theme change was verified. That pass was before the default mark was drawn in the browser (no logo): its canvas drawing has been checked only in the tests and in a standalone headless Chromium page, not through the Settings page against a Worker.

**Not checked:** Safari and Firefox, a deployed Worker, Cloudflare Access, real phones (including Add to Home Screen), iOS fetching the `apple-touch-icon`, screen readers, remote D1, anything on real Cloudflare.

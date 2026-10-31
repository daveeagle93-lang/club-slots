-- Club settings an admin can change without redeploying: text, a logo and two theme colours.
--
-- Both tables are singletons (id is always 1), so the application can upsert without
-- looking anything up. The logo has its own table so that reading the text settings,
-- which every public page does, never pulls the image bytes.
--
-- site_settings: empty text means "not set". The migration inserts the row, so a read
-- always finds one. The application limits lengths and checks the formats (src/server/
-- settings.ts); the CHECKs here are the backstop: generous length caps (the application
-- allows 80, 100, 254 and 200 characters and counts code points, which SQLite's length()
-- counts too, so the caps leave headroom) and the https:// start of a website address.
-- The theme colours are NULL for the default theme, otherwise lower-case #rrggbb (split
-- into the "#" and the six digits because D1 limits GLOB patterns to 50 bytes; a GLOB
-- matches the whole string, so a seventh digit is refused).
--
-- site_logo: no row means no logo. content_type is an allow-list (never SVG, which can
-- carry script), the size cap is 200 KiB and each side is 1 to 512 pixels. The
-- application sniffs the real type from the bytes before storing (src/core/image.ts);
-- sha256 is the lower-case hex digest, used for the ETag and the cache-busting ?v=.

CREATE TABLE site_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  club_name             TEXT NOT NULL DEFAULT '' CHECK (length(club_name) <= 320),
  privacy_contact_name  TEXT NOT NULL DEFAULT '' CHECK (length(privacy_contact_name) <= 400),
  privacy_contact_email TEXT NOT NULL DEFAULT '' CHECK (length(privacy_contact_email) <= 254),
  website_url           TEXT NOT NULL DEFAULT '' CHECK (length(website_url) <= 300 AND (website_url = '' OR website_url GLOB 'https://*')),
  theme_primary         TEXT CHECK (theme_primary IS NULL OR (substr(theme_primary, 1, 1) = '#' AND substr(theme_primary, 2) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
  theme_accent          TEXT CHECK (theme_accent IS NULL OR (substr(theme_accent, 1, 1) = '#' AND substr(theme_accent, 2) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (substr(updated_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(updated_at, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
);

INSERT INTO site_settings (id) VALUES (1);

CREATE TABLE site_logo (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  content_type  TEXT    NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes         BLOB    NOT NULL CHECK (typeof(bytes) = 'blob' AND length(bytes) BETWEEN 1 AND 204800),
  width         INTEGER NOT NULL CHECK (width BETWEEN 1 AND 512),
  height        INTEGER NOT NULL CHECK (height BETWEEN 1 AND 512),
  sha256        TEXT    NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (substr(updated_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(updated_at, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
);

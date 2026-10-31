-- App icons (browser tab, home-screen and manifest icons) made from the club's logo and theme colour.
--
-- One row per size, 32, 180 and 512 pixels (the favicon, the Apple touch icon and the manifest icon). No rows
-- means the bundled default icons are served (public/icons/). The browser draws the logo on the theme's main
-- colour and uploads each size on its own (one request per size, so each gets its own CPU budget); the
-- application sniffs and checks every PNG before storing (src/core/image.ts), so the CHECKs here are the backstop:
-- PNG only, 1 to 204800 bytes, both sides equal to the size, sha256 as the lower-case hex digest (the ETag).
--
-- background is the theme main colour the icon was drawn on, and logo_sha256 is the logo it was drawn from.
-- The settings page compares them with the current theme and logo and redraws the icons when they differ.
-- Saving or deleting a logo deletes every row here in the same batch, so an icon is never kept from a logo that
-- has been replaced. The colour is lower-case #rrggbb, split into the "#" and the six digits because D1 limits
-- GLOB patterns to 50 bytes (a GLOB matches the whole string, so a seventh digit is refused).

CREATE TABLE site_icons (
  size          INTEGER PRIMARY KEY CHECK (size IN (32, 180, 512)),
  content_type  TEXT    NOT NULL CHECK (content_type = 'image/png'),
  bytes         BLOB    NOT NULL CHECK (typeof(bytes) = 'blob' AND length(bytes) BETWEEN 1 AND 204800),
  width         INTEGER NOT NULL CHECK (width = size),
  height        INTEGER NOT NULL CHECK (height = size),
  sha256        TEXT    NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  background    TEXT    NOT NULL CHECK (substr(background, 1, 1) = '#' AND substr(background, 2) GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  logo_sha256   TEXT    NOT NULL CHECK (length(logo_sha256) = 64 AND logo_sha256 NOT GLOB '*[^0-9a-f]*'),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (substr(updated_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(updated_at, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
);

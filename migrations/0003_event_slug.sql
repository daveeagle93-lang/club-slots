-- Unguessable public slug for events, used in booking links (ids are sequential).
--
-- SQLite cannot add a UNIQUE column, or a NOT NULL column without a default,
-- via ALTER TABLE, so the column is nullable at schema level. Application code
-- (and the seed script) always sets it via generateSlug() (src/core/slug.ts).
-- A NULL slug is unreachable by URL. The backfill gives any existing rows a
-- random slug (32 hex characters, which isValidSlug() accepts).

ALTER TABLE events ADD COLUMN slug TEXT;

UPDATE events SET slug = lower(hex(randomblob(16))) WHERE slug IS NULL;

CREATE UNIQUE INDEX events_slug ON events (slug);

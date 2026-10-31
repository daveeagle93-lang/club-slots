-- Unguessable per-booking token, used in the booking's .ics link so that link
-- carries no names or times.
--
-- SQLite cannot add a UNIQUE column, or a NOT NULL column without a default,
-- via ALTER TABLE, so the column is nullable at schema level. Application code
-- (and the seed script) always sets it via generateBookingToken()
-- (src/core/slug.ts). A NULL token is unreachable by URL. The backfill gives
-- any existing rows a random token (32 hex characters, which isValidToken()
-- accepts).

ALTER TABLE bookings ADD COLUMN token TEXT;

UPDATE bookings SET token = lower(hex(randomblob(16))) WHERE token IS NULL;

CREATE UNIQUE INDEX bookings_token ON bookings (token);

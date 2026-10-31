-- Client-generated idempotency key for a booking request, so that a retry after
-- a dropped response gets the original booking back instead of a conflict.
--
-- Nullable at schema level: bookings made before this migration (and rows
-- inserted directly, such as by the seed script) have none, and SQLite allows
-- any number of NULLs in a unique index. Application code always sets it
-- (src/server/bookings.ts). The key is only unique within one event.

ALTER TABLE bookings ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX bookings_idempotency_key ON bookings (event_id, idempotency_key);

-- Unicode-aware booking identity.
--
-- The application computes dog_key / handler_key with identityKey()
-- (src/core/identity.ts) on every insert, so SQL never needs to know Unicode
-- rules. dog_name / handler_name stay as entered, for display. The two key
-- columns are kept separate (not concatenated) so that "ab" + "c" and
-- "a" + "bc" cannot collide. A forgotten key (both '') fails loudly on the
-- second booking of an event because of the unique index below.

ALTER TABLE bookings ADD COLUMN dog_key     TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN handler_key TEXT NOT NULL DEFAULT '';

-- Best-effort backfill (ASCII-only), purely so the unique index can be created
-- on a database that already has rows. Production has no data yet.
UPDATE bookings SET dog_key = lower(trim(dog_name)), handler_key = lower(trim(handler_name));

DROP INDEX bookings_one_run_per_dog_handler;

CREATE UNIQUE INDEX bookings_one_run_per_dog_handler_keys
  ON bookings (event_id, dog_key, handler_key);

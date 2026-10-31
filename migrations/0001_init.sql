-- Initial schema for D1 (SQLite).
--
-- Conventions:
--   * Times are UTC ISO-8601 text in the fixed form YYYY-MM-DDTHH:MM:SSZ. The
--     GLOB checks enforce that shape, so lexicographic order is chronological
--     order. (They check shape only, not that the date is a real one.) Each
--     check is split into a date part and a time part because D1 limits GLOB
--     patterns to 50 bytes and the full pattern is longer.
--   * Money is integer pence.

CREATE TABLE events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  -- There is deliberately no separate `date` column. The event date is derived
  -- from start_utc (displayed in Europe/London), giving a single source of
  -- truth and avoiding BST/UTC-midnight inconsistencies.
  start_utc        TEXT    NOT NULL,
  end_utc          TEXT    NOT NULL,
  session_minutes  INTEGER NOT NULL,
  gap_minutes      INTEGER NOT NULL DEFAULT 0,
  cost_pence       INTEGER NOT NULL DEFAULT 0,
  venue_postcode   TEXT    NOT NULL,
  details          TEXT    NOT NULL DEFAULT '',
  archived         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (substr(start_utc, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(start_utc, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  CHECK (substr(end_utc, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(end_utc, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  CHECK (substr(created_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(created_at, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  CHECK (end_utc > start_utc),
  CHECK (session_minutes > 0),
  CHECK (gap_minutes >= 0),
  CHECK (cost_pence >= 0),
  CHECK (archived IN (0, 1))
);

-- Periods within an event during which no slots are offered.
CREATE TABLE breaks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  start_utc  TEXT    NOT NULL,
  end_utc    TEXT    NOT NULL,
  CHECK (substr(start_utc, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(start_utc, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  CHECK (substr(end_utc, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(end_utc, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  CHECK (end_utc > start_utc)
);

CREATE INDEX breaks_event_id ON breaks (event_id);

CREATE TABLE bookings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  slot_start_utc  TEXT    NOT NULL,
  dog_name        TEXT    NOT NULL,
  handler_name    TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (substr(slot_start_utc, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(slot_start_utc, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  CHECK (substr(created_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(created_at, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  CHECK (trim(dog_name) <> ''),
  CHECK (trim(handler_name) <> ''),
  -- One booking per slot.
  UNIQUE (event_id, slot_start_utc)
);

-- Identity rule: one run per dog + handler per event. One handler may still
-- book several slots with different dogs. The two columns are kept separate
-- (not concatenated) so that "ab" + "c" and "a" + "bc" cannot collide.
-- Caveats: SQLite lower() folds ASCII only. The identity rule may become
-- configurable later (the setup wizard may change booking fields), so it is
-- kept isolated in this one index. The database arbitrates concurrent bookings.
CREATE UNIQUE INDEX bookings_one_run_per_dog_handler
  ON bookings (event_id, lower(trim(dog_name)), lower(trim(handler_name)));

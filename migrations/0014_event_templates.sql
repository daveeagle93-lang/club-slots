-- Event templates (what an admin starts a new event from) and a share message per event.
--
-- event_templates: a saved set of event settings, without a name or a date. At most 20 (the application limits it,
-- src/server/admin-templates.ts). The name is unique ignoring ASCII case (SQLite's lower() folds ASCII only). is_default
-- is 0 or 1 and the partial unique index lets at most one row be 1; the application changes the default inside one batch,
-- clearing the old one before setting the new one, so there is never more than one default and, once a template exists,
-- never none. start_time and end_time are London local wall-clock times as HH:MM (the template has no date, so no UTC
-- instant); the GLOB patterns are split in two because GLOB has no alternation, and end must be after start. The
-- application limits the details to 2000 and the share message to 1000 characters, counting code points, which SQLite's
-- length() counts too, so these CHECKs are the same limits as a backstop. venue_postcode is only kept to 2 to 10
-- characters here; the application checks the letters and numbers.
--
-- share_message is the text the admin's Share button builds a WhatsApp message from; empty means the built-in wording.
-- It may hold placeholders such as {event}: the server stores the text as written and the browser fills them in.
--
-- event_template_breaks: the breaks of a template, as HH:MM London times inside the template's day, with the same
-- optional name as a break of an event (40 characters). They go when their template goes.
--
-- events.share_message: an event stores a COPY of the message it was made with (or was given later). There is no link
-- from an event to a template, so editing or deleting a template never changes an event. The existing events get ''.

CREATE TABLE event_templates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 60),
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  details         TEXT    NOT NULL DEFAULT '' CHECK (length(details) <= 2000),
  venue_postcode  TEXT    NOT NULL CHECK (length(venue_postcode) BETWEEN 2 AND 10),
  cost_pence      INTEGER NOT NULL DEFAULT 0 CHECK (cost_pence BETWEEN 0 AND 100000),
  start_time      TEXT    NOT NULL CHECK (start_time GLOB '[01][0-9]:[0-5][0-9]' OR start_time GLOB '2[0-3]:[0-5][0-9]'),
  end_time        TEXT    NOT NULL CHECK (end_time GLOB '[01][0-9]:[0-5][0-9]' OR end_time GLOB '2[0-3]:[0-5][0-9]'),
  session_minutes INTEGER NOT NULL CHECK (session_minutes BETWEEN 1 AND 480),
  gap_minutes     INTEGER NOT NULL DEFAULT 0 CHECK (gap_minutes BETWEEN 0 AND 120),
  share_message   TEXT    NOT NULL DEFAULT '' CHECK (length(share_message) <= 1000),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (end_time > start_time),
  CHECK (substr(created_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(created_at, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'),
  CHECK (substr(updated_at, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(updated_at, 11) GLOB 'T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z')
);

CREATE UNIQUE INDEX event_templates_name ON event_templates (lower(name));

CREATE UNIQUE INDEX event_templates_one_default ON event_templates (is_default) WHERE is_default = 1;

CREATE TABLE event_template_breaks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES event_templates (id) ON DELETE CASCADE,
  start_time  TEXT    NOT NULL CHECK (start_time GLOB '[01][0-9]:[0-5][0-9]' OR start_time GLOB '2[0-3]:[0-5][0-9]'),
  end_time    TEXT    NOT NULL CHECK (end_time GLOB '[01][0-9]:[0-5][0-9]' OR end_time GLOB '2[0-3]:[0-5][0-9]'),
  label       TEXT    NOT NULL DEFAULT '' CHECK (length(label) <= 40),
  CHECK (end_time > start_time)
);

CREATE INDEX event_template_breaks_template_id ON event_template_breaks (template_id);

ALTER TABLE events ADD COLUMN share_message TEXT NOT NULL DEFAULT '' CHECK (length(share_message) <= 1000);

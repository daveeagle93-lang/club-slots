-- Booking fields: what an event's booking form asks for.
--
-- Until now every booking form had two fields, "Dog" and "Handler", kept in bookings.value_1 and value_2, and both
-- together made up the identity (one dog and handler pair). An event now has one to four fields, each with a label,
-- whether it is required, a longest value and whether it is part of the identity. Field n is kept in bookings.value_n
-- (0016 already made the bookings table four fields wide), and the identity is the keys of the identity fields.
--
-- This file is RE-RUNNABLE, like 0016 (see there for why): CREATE ... IF NOT EXISTS, INSERT OR IGNORE and no
-- ALTER TABLE. Nothing in bookings changes. How many bookings one identity may hold is event_layout.identity_limit,
-- which 0016 added.
--
-- event_fields: one row per field of an event, position 1 to 4 (the order of the form and the number of the value
-- column). The application keeps the rules that need several rows (one to four fields, the first one required, an
-- identity field is always required, at least one identity field); the table checks what one row can: the label
-- is 1 to 40 characters (the application also refuses control and invisible characters), max_length is 1 to 80
-- and required and in_identity are 0 or 1. A label is unique within the event ignoring ASCII case (the application
-- compares more strictly: NFC and Unicode lower case). Editing a form replaces all the event's rows in one batch, so a
-- swap of two labels never meets the unique index half-way. Deleting the event deletes its fields.
--
-- event_template_fields: the same for event templates. An event stores a COPY of its template's fields.
--
-- Backfill: every existing event and template gets the two fields it always had, Dog (position 1) and Handler (position
-- 2), both required, up to 80 characters and part of the identity, so nothing changes for existing bookings, their
-- identity keys or their calendar entries. OR IGNORE makes a second run harmless: a field that already exists is left alone.

CREATE TABLE IF NOT EXISTS event_fields (
  event_id     INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  position     INTEGER NOT NULL CHECK (position BETWEEN 1 AND 4),
  label        TEXT    NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  required     INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  max_length   INTEGER NOT NULL DEFAULT 80 CHECK (max_length BETWEEN 1 AND 80),
  in_identity  INTEGER NOT NULL DEFAULT 0 CHECK (in_identity IN (0, 1)),
  PRIMARY KEY (event_id, position)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_fields_label ON event_fields (event_id, lower(label));

CREATE TABLE IF NOT EXISTS event_template_fields (
  template_id  INTEGER NOT NULL REFERENCES event_templates (id) ON DELETE CASCADE,
  position     INTEGER NOT NULL CHECK (position BETWEEN 1 AND 4),
  label        TEXT    NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  required     INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  max_length   INTEGER NOT NULL DEFAULT 80 CHECK (max_length BETWEEN 1 AND 80),
  in_identity  INTEGER NOT NULL DEFAULT 0 CHECK (in_identity IN (0, 1)),
  PRIMARY KEY (template_id, position)
);

CREATE UNIQUE INDEX IF NOT EXISTS event_template_fields_label ON event_template_fields (template_id, lower(label));

INSERT OR IGNORE INTO event_fields (event_id, position, label, required, max_length, in_identity)
  SELECT id, 1, 'Dog', 1, 80, 1 FROM events;

INSERT OR IGNORE INTO event_fields (event_id, position, label, required, max_length, in_identity)
  SELECT id, 2, 'Handler', 1, 80, 1 FROM events;

INSERT OR IGNORE INTO event_template_fields (template_id, position, label, required, max_length, in_identity)
  SELECT id, 1, 'Dog', 1, 80, 1 FROM event_templates;

INSERT OR IGNORE INTO event_template_fields (template_id, position, label, required, max_length, in_identity)
  SELECT id, 2, 'Handler', 1, 80, 1 FROM event_templates;

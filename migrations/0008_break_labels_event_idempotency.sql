-- Two additions: a name for each break, and a client-generated idempotency key for
-- event creation.
--
-- breaks.label is what the organiser calls the break ("Lunch"), shown in the create
-- form's near-miss suggestions. Empty means unnamed, so existing breaks keep working
-- unchanged. The application limits it to 40 characters. The CHECK here is only a
-- looser backstop (100 characters; SQLite's length() counts characters, not bytes),
-- so the application limit can change later without rebuilding the table.
--
-- events.idempotency_key lets the admin create-event endpoint answer a retry of a
-- request whose response was lost with the original event instead of a second one.
-- Nullable at schema level: events made before this migration (and rows inserted
-- directly, such as by the seed script) have none, and SQLite allows any number of
-- NULLs in a unique index. Application code always sets it (src/server/admin-events.ts).
-- Unlike the per-event booking keys (0005) it is unique across all events: only
-- admins create events, and one admin's key never has a reason to meet another's.

ALTER TABLE breaks ADD COLUMN label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 100);

ALTER TABLE events ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX events_idempotency_key ON events (idempotency_key);

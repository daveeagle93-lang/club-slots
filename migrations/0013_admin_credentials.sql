-- The admin secret for the password provider, created on /setup (src/routes/api/setup.ts) instead of being set as
-- Worker secrets. Used only when neither ADMIN_PASSWORD_HASH nor ADMIN_SESSION_SECRET is set (src/server/auth/index.ts).
--
-- One row at most (id is always 1). secret_hash is the same `hmac-sha256$<salt>$<mac>` form as ADMIN_PASSWORD_HASH:
-- the secret itself is shown once on /setup and never stored. session_secret signs the admin session cookie and is at
-- least 32 characters, like ADMIN_SESSION_SECRET. first_login_at is empty until the first successful sign-in; while it
-- is empty /setup may be run again and replaces both values, and once it is set /setup is closed. Deleting the row
-- (docs/admin-auth.md) reopens /setup.

CREATE TABLE admin_credentials (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  secret_hash    TEXT NOT NULL CHECK (substr(secret_hash, 1, 12) = 'hmac-sha256$'),
  session_secret TEXT NOT NULL CHECK (length(session_secret) >= 32),
  created_at     TEXT NOT NULL,
  first_login_at TEXT
);

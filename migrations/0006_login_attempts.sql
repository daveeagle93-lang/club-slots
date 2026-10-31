-- Failed-login throttling for the password admin provider (src/server/auth/ratelimit.ts).
--
-- One row per client: `key` is the hex SHA-256 of the client IP (the raw address is never
-- stored). `attempts` counts logins since `window_start` (epoch seconds); an attempt
-- arriving 900 s or more after the window began starts a new window. A successful login
-- deletes the row, and old rows are purged opportunistically on each attempt.

CREATE TABLE login_attempts (
  key TEXT NOT NULL PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

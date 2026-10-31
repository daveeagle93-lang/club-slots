-- Index for the purge in src/server/auth/ratelimit.ts, which deletes login_attempts rows by age.
--
-- Without it `DELETE ... WHERE window_start < ?` scans the whole table (EXPLAIN QUERY PLAN
-- says SCAN), and it runs on every login attempt. Each new client key adds a row that is kept
-- for over a day, so attempts from N addresses read about N*N/2 rows, enough to use up D1's
-- free daily row-read allowance and take the public booking page down with it. With the index
-- the purge reads only the rows it deletes (the code also deletes at most 100 per attempt).
--
-- The keying described in 0006 has also changed. `key` is now the hex HMAC-SHA-256, keyed with
-- ADMIN_SESSION_SECRET, of the client's rate-limit bucket (the IPv4 address, or the /64 prefix of
-- an IPv6 address), not a plain SHA-256 of the address: the IPv4 space can be hashed in minutes,
-- so unkeyed hashes were really addresses. Rows from before this migration are plain hashes; they
-- no longer match any client and are purged after a day like the rest. The values are
-- pseudonymous, still personal data, and no schema change is needed for the new keying.

CREATE INDEX login_attempts_window_start ON login_attempts (window_start);

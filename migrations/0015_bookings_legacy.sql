-- First of three steps that rebuild the bookings table for lanes (parallel rings) and places (several bookings per
-- time): set the old table aside under another name.
--
-- Why three files instead of one. SQLite cannot change a table's unique constraints in place, so bookings has to be
-- rebuilt, and Cloudflare's D1 documentation says nothing about whether a migration file is applied atomically.
-- What is known: wrangler 4.147 appends its own INSERT INTO d1_migrations to the file and sends the lot as one
-- command, and its own message says "D1 runs your SQL in a transaction for you". That is not proven for a remote
-- database, so the rebuild is written to survive being stopped half-way and run again:
--   0015 (this file): one statement, so it is atomic whatever D1 does.
--   0016: builds everything new and copies the rows across. Every statement is safe to run twice, and the old table
--         is only read, never changed.
--   0017: drops the old table, the one destructive step, in a file of its own after the copy has been committed.
--
-- Nothing else changes here: the table keeps its rows, its indexes (the three named ones keep their names until 0016)
-- and its AUTOINCREMENT counter under the new name.

ALTER TABLE bookings RENAME TO bookings_legacy;

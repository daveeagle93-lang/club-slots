-- Last step of the bookings rebuild (0015, 0016): drop the old table. By now 0016 has copied every row into the new
-- bookings table (it fails when one is missing), so this is the only destructive step, in a file of its own. IF EXISTS
-- makes running it again harmless.

DROP TABLE IF EXISTS bookings_legacy;

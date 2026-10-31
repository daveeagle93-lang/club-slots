#!/usr/bin/env bash
# Applies the migrations to a throwaway local D1 and checks the schema's
# constraints. Exits non-zero if any expectation fails. Run from anywhere.
set -u
cd "$(dirname "$0")/.."

DB=slot-booker-db
STATE=$(mktemp -d)
trap 'rm -rf "$STATE"' EXIT
FAILS=0

wr() { npx wrangler d1 "$@" --local --persist-to "$STATE"; }
sql() { wr execute "$DB" --command "$1" --json 2>&1; }
# key TEXT: the application's identity key (src/core/identity.ts), so SQL need not know Unicode rules
key() { node -e 'import("./src/core/identity.ts").then(m => process.stdout.write(m.identityKey(process.argv[1])))' -- "$1"; }

# expect_ok LABEL SQL
expect_ok() {
  if out=$(sql "$2") && ! grep -q '"success": false' <<<"$out"; then echo "PASS (accepted): $1"
  else echo "FAIL (should be accepted): $1"; echo "$out" | tail -5; FAILS=$((FAILS + 1)); fi
}
# expect_fail LABEL SQL ERROR_TEXT: must fail with the given error text
expect_fail() {
  out=$(sql "$2")
  if grep -q "$3" <<<"$out"; then echo "PASS (rejected, $3): $1"
  else echo "FAIL (should be rejected with '$3'): $1"; echo "$out" | tail -5; FAILS=$((FAILS + 1)); fi
}
# expect_count LABEL SQL EXPECTED
expect_count() {
  got=$(sql "$2" | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
  if [ "$got" = "$3" ]; then echo "PASS (count=$3): $1"
  else echo "FAIL ($1): expected $3, got '$got'"; FAILS=$((FAILS + 1)); fi
}

wr migrations apply "$DB" || { echo "FAIL: migration did not apply"; exit 1; }

expect_count "foreign keys are on" "SELECT foreign_keys AS n FROM pragma_foreign_keys" 1

EV="INSERT INTO events (name, start_utc, end_utc, session_minutes, venue_postcode) VALUES"
EVS="INSERT INTO events (name, start_utc, end_utc, session_minutes, venue_postcode, slug) VALUES"
expect_ok "insert event 1 (with slug)" "$EVS ('Test A', '2026-03-14T09:00:00Z', '2026-03-14T16:00:00Z', 15, 'AB1 2CD', 'slug-a-aaaaaaaaaaaaaa')"
expect_ok "insert event 2 (different slug)" "$EVS ('Test B', '2026-06-13T09:00:00Z', '2026-06-13T16:00:00Z', 15, 'AB1 2CD', 'slug-b-bbbbbbbbbbbbbb')"
expect_ok "insert event 3 (NULL slug)" "$EV ('Test C', '2026-09-12T09:00:00Z', '2026-09-12T16:00:00Z', 15, 'AB1 2CD')"
expect_ok "a second NULL-slug event coexists" "$EV ('Test D', '2026-10-10T09:00:00Z', '2026-10-10T16:00:00Z', 15, 'AB1 2CD')"
expect_fail "duplicate slug" "$EVS ('Dup', '2026-11-14T09:00:00Z', '2026-11-14T16:00:00Z', 15, 'AB1 2CD', 'slug-a-aaaaaaaaaaaaaa')" "UNIQUE constraint failed"
expect_count "two events with different slugs" "SELECT count(DISTINCT slug) AS n FROM events WHERE slug IS NOT NULL" 2
expect_ok "insert breaks" "INSERT INTO breaks (event_id, start_utc, end_utc) VALUES (1, '2026-03-14T12:00:00Z', '2026-03-14T13:00:00Z'), (1, '2026-03-14T14:00:00Z', '2026-03-14T14:15:00Z')"

# Lanes and places (0016): the application gives every event a layout row and one unnamed lane when it creates it; this script inserts events by hand, so it does the same.
expect_ok "a layout row for every event so far" "INSERT INTO event_layout (event_id) SELECT id FROM events"
expect_ok "one unnamed lane for every event so far" "INSERT INTO event_lanes (event_id, position, name) SELECT id, 1, '' FROM events"
expect_count "layout defaults: capacity 1, identity limit 1, revision 0" "SELECT count(*) AS n FROM event_layout WHERE capacity = 1 AND identity_limit = 1 AND config_rev = 0" 4
expect_fail "capacity 0" "UPDATE event_layout SET capacity = 0 WHERE event_id = 1" "CHECK constraint failed"
expect_fail "capacity 51" "UPDATE event_layout SET capacity = 51 WHERE event_id = 1" "CHECK constraint failed"
expect_fail "identity limit 21" "UPDATE event_layout SET identity_limit = 21 WHERE event_id = 1" "CHECK constraint failed"
expect_ok "capacity 50 and identity limit 20" "UPDATE event_layout SET capacity = 50, identity_limit = 20 WHERE event_id = 1"
expect_ok "capacity back to 1 and identity limit to 1" "UPDATE event_layout SET capacity = 1, identity_limit = 1 WHERE event_id = 1"
expect_fail "a second layout row for an event" "INSERT INTO event_layout (event_id) VALUES (1)" "UNIQUE constraint failed"
expect_fail "a lane at position 1001" "INSERT INTO event_lanes (event_id, position, name) VALUES (1, 1001, 'Ring 1001')" "CHECK constraint failed"
expect_ok "a lane parked at position 105 (a reorder parks lanes above 100)" "INSERT INTO event_lanes (event_id, position, name) VALUES (1, 105, 'Parked')"
expect_ok "remove the parked lane" "DELETE FROM event_lanes WHERE position = 105"
expect_fail "a second lane at the same position" "INSERT INTO event_lanes (event_id, position, name) VALUES (1, 1, 'Ring 1')" "UNIQUE constraint failed"
expect_fail "a second unnamed lane" "INSERT INTO event_lanes (event_id, position, name) VALUES (1, 2, '')" "UNIQUE constraint failed"
expect_ok "a named lane" "INSERT INTO event_lanes (event_id, position, name) VALUES (1, 2, 'Ring 1')"
expect_fail "a lane name differing only in case" "INSERT INTO event_lanes (event_id, position, name) VALUES (1, 3, 'RING 1')" "UNIQUE constraint failed"
expect_fail "a lane name of 41 characters" "INSERT INTO event_lanes (event_id, position, name) VALUES (1, 3, replace(hex(zeroblob(20)), '0', 'x') || 'yy' || 'z')" "CHECK constraint failed"
expect_ok "the same lane name in another event" "INSERT INTO event_lanes (event_id, position, name) VALUES (2, 2, 'Ring 1')"
expect_ok "remove the extra lanes again" "DELETE FROM event_lanes WHERE name <> ''"

# Booking fields (0018): one to four fields per event, a label of 1 to 40 characters unique within the event ignoring case.
FLD="INSERT INTO event_fields (event_id, position, label, required, max_length, in_identity) VALUES"
expect_ok "an event's Dog and Handler fields" "$FLD (1, 1, 'Dog', 1, 80, 1), (1, 2, 'Handler', 1, 80, 1)"
expect_fail "a second field at the same position" "$FLD (1, 2, 'Other', 1, 80, 0)" "UNIQUE constraint failed"
expect_fail "a label differing only in case" "$FLD (1, 3, 'DOG', 1, 80, 0)" "UNIQUE constraint failed"
expect_fail "field position 5" "$FLD (1, 5, 'Five', 1, 80, 0)" "CHECK constraint failed"
expect_fail "field position 0" "$FLD (1, 0, 'Zero', 1, 80, 0)" "CHECK constraint failed"
expect_fail "an empty field label" "$FLD (1, 3, '', 1, 80, 0)" "CHECK constraint failed"
expect_fail "a field label of 41 characters" "$FLD (1, 3, replace(hex(zeroblob(20)), '0', 'x') || 'yy' || 'z', 1, 80, 0)" "CHECK constraint failed"
expect_fail "a field max length of 0" "$FLD (1, 3, 'Notes', 0, 0, 0)" "CHECK constraint failed"
expect_fail "a field max length of 81" "$FLD (1, 3, 'Notes', 0, 81, 0)" "CHECK constraint failed"
expect_fail "required = 2" "$FLD (1, 3, 'Notes', 2, 80, 0)" "CHECK constraint failed"
expect_fail "in_identity = 2" "$FLD (1, 3, 'Notes', 0, 80, 2)" "CHECK constraint failed"
expect_fail "a field for a missing event" "$FLD (99, 1, 'Dog', 1, 80, 1)" "FOREIGN KEY constraint failed"
expect_ok "an optional third field and the same label in another event" "$FLD (1, 3, 'Notes', 0, 40, 0), (2, 1, 'Dog', 1, 80, 1)"

# A booking: lane (the event's lane at position 1), place, the two form fields, the identity key (the keys joined with char(31)) and a token.
BK="INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key, token) VALUES"
# row EVENT SLOT DOG HANDLER [PLACE]: one VALUES tuple with keys computed from the names
row() { echo "($1, (SELECT id FROM event_lanes WHERE event_id = $1 AND position = 1), '$2', ${5:-1}, '$3', '$4', '$(key "$3")' || char(31) || '$(key "$4")', lower(hex(randomblob(16))))"; }
expect_ok "first booking" "$BK $(row 1 '2026-03-14T09:00:00Z' 'Rex' 'Sam Jones')"
expect_fail "duplicate (event, lane, slot, place)" "$BK $(row 1 '2026-03-14T09:00:00Z' 'Fido' 'Ann Lee')" "UNIQUE constraint failed"
expect_ok "a second place in the same slot" "$BK $(row 1 '2026-03-14T09:00:00Z' 'Fido' 'Ann Lee' 2)"
expect_fail "place 0" "$BK $(row 1 '2026-03-14T09:00:00Z' 'Bo' 'Cy' 0)" "CHECK constraint failed"
expect_fail "duplicate dog+handler, exact" "$BK $(row 1 '2026-03-14T09:15:00Z' 'Rex' 'Sam Jones')" "UNIQUE constraint failed"
expect_fail "duplicate dog+handler, case/whitespace variants" "$BK $(row 1 '2026-03-14T09:15:00Z' ' rex ' 'sam jones')" "UNIQUE constraint failed"
expect_ok "a second booking of one dog+handler as identity number 2" "INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key, identity_seq, token) VALUES (1, (SELECT id FROM event_lanes WHERE event_id = 1), '2026-03-14T09:15:00Z', 1, 'Rex', 'Sam Jones', 'rex' || char(31) || 'sam jones', 2, lower(hex(randomblob(16))))"
expect_fail "identity number 0" "INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key, identity_seq, token) VALUES (1, (SELECT id FROM event_lanes WHERE event_id = 1), '2026-03-14T09:20:00Z', 1, 'Rex', 'Sam Jones', 'rex' || char(31) || 'sam jones', 0, lower(hex(randomblob(16))))" "CHECK constraint failed"
expect_ok "remove those two extra bookings" "DELETE FROM bookings WHERE event_id = 1 AND (place = 2 OR identity_seq = 2)"
expect_ok "same handler, different dog, same event" "$BK $(row 1 '2026-03-14T09:15:00Z' 'Fido' 'Sam Jones')"
expect_ok "same dog+handler, different event" "$BK $(row 2 '2026-06-13T09:00:00Z' 'Rex' 'Sam Jones')"
expect_ok "no ab+c / a+bc collision" "$BK $(row 1 '2026-03-14T09:30:00Z' 'ab' 'c'), $(row 1 '2026-03-14T09:45:00Z' 'a' 'bc')"
expect_fail "blank first field" "$BK $(row 1 '2026-03-14T10:00:00Z' '  ' 'Ann Lee')" "CHECK constraint failed"
expect_fail "bad booking timestamp format" "$BK $(row 1 '2026-03-14 10:00' 'Bo' 'Ann Lee')" "CHECK constraint failed"
expect_fail "booking for missing event" "$BK (99, 1, '2026-03-14T10:00:00Z', 1, 'Bo', 'Ann Lee', 'bo' || char(31) || 'ann lee', 'tok-missing-event-aaaa')" "FOREIGN KEY constraint failed"
expect_fail "booking in a missing lane" "$BK (1, 999, '2026-03-14T10:00:00Z', 1, 'Bo', 'Ann Lee', 'bo' || char(31) || 'ann lee', 'tok-missing-lane-aaaaaa')" "FOREIGN KEY constraint failed"
expect_fail "booking in another event's lane" "$BK (2, (SELECT id FROM event_lanes WHERE event_id = 1 AND position = 1), '2026-06-13T10:00:00Z', 1, 'Bo', 'Ann Lee', 'bo' || char(31) || 'ann lee', 'tok-other-lane-aaaaaa')" "FOREIGN KEY constraint failed"
expect_fail "a lane that still has bookings cannot be deleted" "DELETE FROM event_lanes WHERE event_id = 1" "FOREIGN KEY constraint failed"

# Unicode identity: keys come from identityKey(), display columns keep the text as entered.
expect_ok "Zoë booked" "$BK $(row 1 '2026-03-14T10:15:00Z' 'Zoë' 'Pat Kay')"
expect_fail "Zoë vs ZOË (same event and handler) collides" "$BK $(row 1 '2026-03-14T10:30:00Z' 'ZOË' 'Pat Kay')" "UNIQUE constraint failed"
expect_fail "precomposed vs decomposed ë collides" "$BK $(row 1 '2026-03-14T10:30:00Z' $'Zoe\xcc\x88' 'Pat Kay')" "UNIQUE constraint failed"
expect_ok "same Zoë dog, different handler" "$BK $(row 1 '2026-03-14T10:30:00Z' 'Zoë' 'Lee Ray')"
expect_ok "ZOË in another event" "$BK $(row 3 '2026-09-12T09:00:00Z' 'ZOË' 'Pat Kay')"
expect_count "the field keeps text as entered" "SELECT count(*) AS n FROM bookings WHERE value_1 = 'ZOË'" 1
expect_count "old ASCII-only and old per-slot rules are gone" "SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name IN ('bookings_one_run_per_dog_handler', 'bookings_one_run_per_dog_handler_keys')" 0
expect_fail "booking with forgotten keys" "INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, token) VALUES (3, 3, '2026-09-12T09:15:00Z', 1, 'Mo', 'Al', 'tok-no-key-aaaaaaaaaaa')" "NOT NULL constraint failed"

# Booking tokens (0004, now NOT NULL and unique).
BKT="INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key, token) VALUES"
expect_ok "booking with a token" "$BKT (3, 3, '2026-09-12T11:00:00Z', 1, 'Ta', 'Ua', 'ta' || char(31) || 'ua', 'token-aaaaaaaaaaaaaaaa')"
expect_fail "duplicate token" "$BKT (3, 3, '2026-09-12T11:15:00Z', 1, 'Tb', 'Ub', 'tb' || char(31) || 'ub', 'token-aaaaaaaaaaaaaaaa')" "UNIQUE constraint failed"
expect_ok "bookings with different tokens coexist" "$BKT (3, 3, '2026-09-12T11:15:00Z', 1, 'Tb', 'Ub', 'tb' || char(31) || 'ub', 'token-bbbbbbbbbbbbbbbb')"
expect_fail "booking with no token" "INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key) VALUES (3, 3, '2026-09-12T11:30:00Z', 1, 'Tc', 'Uc', 'tc' || char(31) || 'uc')" "NOT NULL constraint failed"

# Idempotency keys (0005): unique within an event when set, nullable otherwise.
BKI="INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key, token, idempotency_key) VALUES"
expect_ok "booking with an idempotency key" "$BKI (3, 3, '2026-09-12T12:00:00Z', 1, 'Ia', 'Ja', 'ia' || char(31) || 'ja', 'token-iaaaaaaaaaaaaaaa', 'idem-aaaaaaaaaaaaaaaa')"
expect_fail "duplicate idempotency key, same event" "$BKI (3, 3, '2026-09-12T12:15:00Z', 1, 'Ib', 'Jb', 'ib' || char(31) || 'jb', 'token-ibbbbbbbbbbbbbbb', 'idem-aaaaaaaaaaaaaaaa')" "UNIQUE constraint failed"
expect_ok "same idempotency key, different event" "$BKI (1, 1, '2026-03-14T11:00:00Z', 1, 'Ia', 'Ja', 'ia' || char(31) || 'ja', 'token-icccccccccccccccc', 'idem-aaaaaaaaaaaaaaaa')"
expect_ok "different idempotency keys coexist" "$BKI (3, 3, '2026-09-12T12:15:00Z', 1, 'Ib', 'Jb', 'ib' || char(31) || 'jb', 'token-ibbbbbbbbbbbbbbb', 'idem-bbbbbbbbbbbbbbbb')"
expect_ok "NULL-key bookings coexist alongside keyed ones" "$BKT (3, 3, '2026-09-12T13:00:00Z', 1, 'Tc', 'Uc', 'tc' || char(31) || 'uc', 'token-tcccccccccccccccc'), (3, 3, '2026-09-12T13:15:00Z', 1, 'Td', 'Ud', 'td' || char(31) || 'ud', 'token-tdddddddddddddddd')"
expect_count "both NULL-key bookings stored" "SELECT count(*) AS n FROM bookings WHERE event_id = 3 AND identity_key IN ('tc' || char(31) || 'uc', 'td' || char(31) || 'ud') AND idempotency_key IS NULL" 2

# Login attempts (0006): one row per hashed client key, all columns required.
LA="INSERT INTO login_attempts (key, attempts, window_start) VALUES"
expect_ok "login attempt row" "$LA ('hash-a', 1, 1800000000)"
expect_fail "duplicate login attempt key" "$LA ('hash-a', 1, 1800000900)" "UNIQUE constraint failed"
expect_ok "different login attempt key" "$LA ('hash-b', 3, 1800000000)"
expect_fail "NULL login attempt key" "INSERT INTO login_attempts (key, attempts, window_start) VALUES (NULL, 1, 1800000000)" "NOT NULL constraint failed"
expect_fail "NULL attempts" "INSERT INTO login_attempts (key, window_start) VALUES ('hash-c', 1800000000)" "NOT NULL constraint failed"
expect_fail "NULL window_start" "INSERT INTO login_attempts (key, attempts) VALUES ('hash-d', 1)" "NOT NULL constraint failed"
expect_count "login attempts stored" "SELECT count(*) AS n FROM login_attempts" 2

# Login attempts index (0007): the purge by age must search the index, not scan the table.
expect_count "window_start index exists" "SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'login_attempts_window_start'" 1
# Keep this statement in step with PURGE_SQL in src/server/auth/ratelimit.ts (a unit test checks the real one).
PURGE="DELETE FROM login_attempts WHERE rowid IN (SELECT rowid FROM login_attempts WHERE window_start < 0 LIMIT 100)"
plan=$(sql "EXPLAIN QUERY PLAN $PURGE")
if grep -q 'INDEX login_attempts_window_start' <<<"$plan" && ! grep -q 'SCAN login_attempts' <<<"$plan"; then echo "PASS: purge uses the window_start index"
else echo "FAIL (purge query plan should use the index and not SCAN login_attempts):"; echo "$plan" | tail -15; FAILS=$((FAILS + 1)); fi

# Break labels (0008): NOT NULL, default empty, loose length backstop.
expect_count "existing breaks default to an empty label" "SELECT count(*) AS n FROM breaks WHERE event_id = 1 AND label = ''" 2
expect_ok "break with a label" "INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (2, '2026-06-13T12:00:00Z', '2026-06-13T13:00:00Z', 'Lunch')"
expect_ok "break with a 100-character label" "INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (2, '2026-06-13T14:00:00Z', '2026-06-13T14:15:00Z', replace(hex(zeroblob(50)), '0', 'x'))"
expect_fail "break with a 101-character label" "INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (2, '2026-06-13T15:00:00Z', '2026-06-13T15:15:00Z', replace(hex(zeroblob(50)), '0', 'x') || 'y')" "CHECK constraint failed"
expect_fail "NULL break label" "INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (2, '2026-06-13T15:00:00Z', '2026-06-13T15:15:00Z', NULL)" "NOT NULL constraint failed"

# Event idempotency keys (0008): unique across events when set, nullable otherwise.
EVI="INSERT INTO events (name, start_utc, end_utc, session_minutes, venue_postcode, slug, idempotency_key) VALUES"
expect_count "events from before the key have none" "SELECT count(*) AS n FROM events WHERE slug IN ('slug-a-aaaaaaaaaaaaaa', 'slug-b-bbbbbbbbbbbbbb') AND idempotency_key IS NULL" 2
expect_ok "event with an idempotency key" "$EVI ('Keyed A', '2026-12-12T09:00:00Z', '2026-12-12T16:00:00Z', 15, 'AB1 2CD', 'slug-k-aaaaaaaaaaaaaa', 'evkey-aaaaaaaaaaaaaaaa')"
expect_fail "duplicate event idempotency key" "$EVI ('Keyed B', '2026-12-19T09:00:00Z', '2026-12-19T16:00:00Z', 15, 'AB1 2CD', 'slug-k-bbbbbbbbbbbbbb', 'evkey-aaaaaaaaaaaaaaaa')" "UNIQUE constraint failed"
expect_ok "different event idempotency keys coexist" "$EVI ('Keyed B', '2026-12-19T09:00:00Z', '2026-12-19T16:00:00Z', 15, 'AB1 2CD', 'slug-k-bbbbbbbbbbbbbb', 'evkey-bbbbbbbbbbbbbbbb')"
expect_ok "two NULL-key events coexist alongside keyed ones" "$EVI ('Unkeyed A', '2027-01-09T09:00:00Z', '2027-01-09T16:00:00Z', 15, 'AB1 2CD', 'slug-n-aaaaaaaaaaaaaa', NULL), ('Unkeyed B', '2027-01-16T09:00:00Z', '2027-01-16T16:00:00Z', 15, 'AB1 2CD', 'slug-n-bbbbbbbbbbbbbb', NULL)"

# Site settings (0009): a singleton row inserted by the migration; theme colours NULL or lower-case #rrggbb.
expect_count "the migration inserted the settings row" "SELECT count(*) AS n FROM site_settings WHERE id = 1 AND club_name = '' AND website_url = '' AND theme_primary IS NULL AND theme_accent IS NULL" 1
expect_fail "a second settings row" "INSERT INTO site_settings (id) VALUES (2)" "CHECK constraint failed"
expect_fail "settings id 1 twice" "INSERT INTO site_settings (id) VALUES (1)" "UNIQUE constraint failed"
expect_fail "NULL club name" "UPDATE site_settings SET club_name = NULL" "NOT NULL constraint failed"
expect_ok "club name of 320 characters" "UPDATE site_settings SET club_name = replace(hex(zeroblob(160)), '0', 'x')"
expect_fail "club name of 321 characters" "UPDATE site_settings SET club_name = replace(hex(zeroblob(160)), '0', 'x') || 'y'" "CHECK constraint failed"
expect_ok "club name back to empty" "UPDATE site_settings SET club_name = ''"
expect_fail "privacy contact name of 401 characters" "UPDATE site_settings SET privacy_contact_name = replace(hex(zeroblob(200)), '0', 'x') || 'y'" "CHECK constraint failed"
expect_fail "privacy contact email of 255 characters" "UPDATE site_settings SET privacy_contact_email = replace(hex(zeroblob(127)), '0', 'x') || 'y'" "CHECK constraint failed"
expect_fail "website of 301 characters" "UPDATE site_settings SET website_url = 'https://' || replace(hex(zeroblob(146)), '0', 'x') || 'y'" "CHECK constraint failed"
expect_ok "website with https" "UPDATE site_settings SET website_url = 'https://example.org/'"
expect_fail "website with http" "UPDATE site_settings SET website_url = 'http://example.org/'" "CHECK constraint failed"
expect_fail "website with javascript:" "UPDATE site_settings SET website_url = 'javascript:alert(1)'" "CHECK constraint failed"
expect_ok "website back to empty" "UPDATE site_settings SET website_url = ''"
expect_ok "theme colours set" "UPDATE site_settings SET theme_primary = '#0a1b2c', theme_accent = '#ffffff'"
expect_ok "theme colours back to NULL" "UPDATE site_settings SET theme_primary = NULL, theme_accent = NULL"
expect_fail "upper-case theme colour" "UPDATE site_settings SET theme_primary = '#0A1B2C'" "CHECK constraint failed"
expect_fail "short theme colour" "UPDATE site_settings SET theme_accent = '#fff'" "CHECK constraint failed"
expect_fail "theme colour with a seventh digit" "UPDATE site_settings SET theme_accent = '#0a1b2c0'" "CHECK constraint failed"
expect_fail "theme colour without the #" "UPDATE site_settings SET theme_primary = '0a1b2c'" "CHECK constraint failed"
expect_fail "settings timestamp in the wrong shape" "UPDATE site_settings SET updated_at = '2026-10-05 12:00'" "CHECK constraint failed"

# Site logo (0009): singleton, allow-listed type, BLOB of 1 to 204800 bytes, sides 1 to 512, 64 lower-case hex digest.
LG="INSERT INTO site_logo (id, content_type, bytes, width, height, sha256) VALUES"
SHA=$(printf 'a%.0s' $(seq 64))
expect_count "no logo to begin with" "SELECT count(*) AS n FROM site_logo" 0
expect_ok "a png logo" "$LG (1, 'image/png', x'010203', 10, 10, '$SHA')"
expect_fail "a second logo row" "$LG (1, 'image/png', x'010203', 10, 10, '$SHA')" "UNIQUE constraint failed"
expect_fail "logo id 2" "$LG (2, 'image/png', x'010203', 10, 10, '$SHA')" "CHECK constraint failed"
expect_ok "delete the logo" "DELETE FROM site_logo"
for ct in image/jpeg image/webp; do
  expect_ok "a $ct logo" "$LG (1, '$ct', x'010203', 10, 10, '$SHA')"
  expect_ok "delete the $ct logo" "DELETE FROM site_logo"
done
for ct in image/svg+xml image/gif text/html IMAGE/PNG; do
  expect_fail "logo content type $ct" "$LG (1, '$ct', x'010203', 10, 10, '$SHA')" "CHECK constraint failed"
done
expect_fail "empty logo bytes" "$LG (1, 'image/png', x'', 10, 10, '$SHA')" "CHECK constraint failed"
expect_fail "logo bytes as text" "$LG (1, 'image/png', 'abc', 10, 10, '$SHA')" "CHECK constraint failed"
expect_fail "logo of 204801 bytes" "$LG (1, 'image/png', zeroblob(204801), 10, 10, '$SHA')" "CHECK constraint failed"
expect_ok "logo of 204800 bytes" "$LG (1, 'image/png', zeroblob(204800), 512, 512, '$SHA')"
expect_ok "delete the large logo" "DELETE FROM site_logo"
expect_fail "logo 513 wide" "$LG (1, 'image/png', x'010203', 513, 10, '$SHA')" "CHECK constraint failed"
expect_fail "logo 0 tall" "$LG (1, 'image/png', x'010203', 10, 0, '$SHA')" "CHECK constraint failed"
expect_fail "upper-case logo digest" "$LG (1, 'image/png', x'010203', 10, 10, '$(printf 'A%.0s' $(seq 64))')" "CHECK constraint failed"
expect_fail "short logo digest" "$LG (1, 'image/png', x'010203', 10, 10, 'abc')" "CHECK constraint failed"
expect_fail "NULL logo bytes" "$LG (1, 'image/png', NULL, 10, 10, '$SHA')" "NOT NULL constraint failed"

# Event templates (0014): name unique ignoring case, one default at most, HH:MM times, caps; breaks go with their template.
TP="INSERT INTO event_templates (name, is_default, venue_postcode, start_time, end_time, session_minutes) VALUES"
expect_ok "a default template" "$TP ('Saturday', 1, 'AB1 2CD', '09:00', '12:00', 15)"
expect_ok "a second, non-default template" "$TP ('Sunday', 0, 'AB1 2CD', '09:00', '12:00', 15)"
expect_fail "template name differing only in case" "$TP ('SATURDAY', 0, 'AB1 2CD', '09:00', '12:00', 15)" "UNIQUE constraint failed"
expect_fail "a second default template" "$TP ('Third', 1, 'AB1 2CD', '09:00', '12:00', 15)" "UNIQUE constraint failed"
expect_fail "template name of 61 characters" "$TP (replace(hex(zeroblob(30)), '0', 'x') || 'yy', 0, 'AB1 2CD', '09:00', '12:00', 15)" "CHECK constraint failed"
expect_fail "blank template name" "$TP ('  ', 0, 'AB1 2CD', '09:00', '12:00', 15)" "CHECK constraint failed"
expect_fail "template start 24:00" "$TP ('Late', 0, 'AB1 2CD', '24:00', '24:30', 15)" "CHECK constraint failed"
expect_fail "template end not after start" "$TP ('Backwards', 0, 'AB1 2CD', '12:00', '09:00', 15)" "CHECK constraint failed"
expect_fail "template session of 0 minutes" "$TP ('Zero', 0, 'AB1 2CD', '09:00', '12:00', 0)" "CHECK constraint failed"
expect_ok "template break" "INSERT INTO event_template_breaks (template_id, start_time, end_time, label) VALUES (1, '10:00', '10:30', 'Lunch')"
expect_fail "template break label of 41 characters" "INSERT INTO event_template_breaks (template_id, start_time, end_time, label) VALUES (1, '10:00', '10:30', replace(hex(zeroblob(20)), '0', 'x') || 'yy' || 'z')" "CHECK constraint failed"
expect_fail "template break for a missing template" "INSERT INTO event_template_breaks (template_id, start_time, end_time) VALUES (99, '10:00', '10:30')" "FOREIGN KEY constraint failed"
expect_ok "layout and lane rows for a template" "INSERT INTO event_template_layout (template_id) VALUES (1)"
expect_ok "a lane for a template" "INSERT INTO event_template_lanes (template_id, position, name) VALUES (1, 1, '')"
expect_fail "a second unnamed lane for a template" "INSERT INTO event_template_lanes (template_id, position, name) VALUES (1, 2, '')" "UNIQUE constraint failed"
expect_fail "template capacity 51" "UPDATE event_template_layout SET capacity = 51 WHERE template_id = 1" "CHECK constraint failed"
expect_ok "fields for a template" "INSERT INTO event_template_fields (template_id, position, label, required, max_length, in_identity) VALUES (1, 1, 'Dog', 1, 80, 1), (1, 2, 'Handler', 1, 80, 1)"
expect_fail "a template label differing only in case" "INSERT INTO event_template_fields (template_id, position, label) VALUES (1, 3, 'HANDLER')" "UNIQUE constraint failed"
expect_fail "a template field with max length 81" "INSERT INTO event_template_fields (template_id, position, label, max_length) VALUES (1, 3, 'Notes', 81)" "CHECK constraint failed"
expect_ok "delete a template" "DELETE FROM event_templates WHERE id = 1"
expect_count "cascade: template breaks removed" "SELECT count(*) AS n FROM event_template_breaks" 0
expect_count "cascade: template layout, lanes and fields removed" "SELECT (SELECT count(*) FROM event_template_layout) + (SELECT count(*) FROM event_template_lanes) + (SELECT count(*) FROM event_template_fields) AS n" 0
expect_count "existing events have an empty share message" "SELECT count(*) AS n FROM events WHERE share_message = ''" "$(sql "SELECT count(*) AS n FROM events" | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')"
expect_ok "event with a share message of 1000 characters" "UPDATE events SET share_message = replace(hex(zeroblob(500)), '0', 'x') WHERE id = 2"
expect_fail "event share message of 1001 characters" "UPDATE events SET share_message = replace(hex(zeroblob(500)), '0', 'x') || 'y' WHERE id = 2" "CHECK constraint failed"

expect_fail "trailing junk after timestamp" "$BK $(row 1 '2026-03-14T10:00:00Zx' 'Bo' 'Ann Lee')" "CHECK constraint failed"
expect_fail "bad event timestamp format" "$EV ('Bad', '2026-03-14 09:00', '2026-03-14T16:00:00Z', 15, 'AB1 2CD')" "CHECK constraint failed"
expect_fail "event end == start" "$EV ('Bad', '2026-03-14T09:00:00Z', '2026-03-14T09:00:00Z', 15, 'AB1 2CD')" "CHECK constraint failed"
expect_fail "event end < start" "$EV ('Bad', '2026-03-14T09:00:00Z', '2026-03-14T08:00:00Z', 15, 'AB1 2CD')" "CHECK constraint failed"
expect_fail "break end <= start" "INSERT INTO breaks (event_id, start_utc, end_utc) VALUES (1, '2026-03-14T12:00:00Z', '2026-03-14T12:00:00Z')" "CHECK constraint failed"

expect_ok "delete event 1" "DELETE FROM events WHERE id = 1"
expect_count "cascade: breaks removed" "SELECT count(*) AS n FROM breaks WHERE event_id = 1" 0
expect_count "cascade: bookings removed" "SELECT count(*) AS n FROM bookings WHERE event_id = 1" 0
expect_count "cascade: lanes, layout and fields removed" "SELECT (SELECT count(*) FROM event_lanes WHERE event_id = 1) + (SELECT count(*) FROM event_layout WHERE event_id = 1) + (SELECT count(*) FROM event_fields WHERE event_id = 1) AS n" 0
expect_count "other event's booking kept" "SELECT count(*) AS n FROM bookings WHERE event_id = 2" 1

# Backfill: a database holding rows from before 0003 / 0004 gets random slugs and tokens (0005 and 0008 leave keys NULL, 0008 leaves break labels empty, 0009 adds the settings row), then goes through the rest of the migrations.
OLD=$(mktemp -d)
trap 'rm -rf "$STATE" "$OLD"' EXIT
old() { npx wrangler d1 execute "$DB" --local --persist-to "$OLD" "$@" 2>&1; }
old --file migrations/0001_init.sql >/dev/null && old --file migrations/0002_identity_keys.sql >/dev/null \
  && old --command "INSERT INTO events (name, start_utc, end_utc, session_minutes, venue_postcode) VALUES ('Old', '2026-03-14T09:00:00Z', '2026-03-14T16:00:00Z', 15, 'AB1 2CD')" >/dev/null \
  && old --file migrations/0003_event_slug.sql >/dev/null \
  && old --command "INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key) VALUES (1, '2026-03-14T09:00:00Z', 'Rex', 'Sam Jones', 'rex', 'sam jones'), (1, '2026-03-14T09:15:00Z', 'Fido', 'Ann Lee', 'fido', 'ann lee')" >/dev/null \
  && old --file migrations/0004_booking_token.sql >/dev/null \
  && old --file migrations/0005_booking_idempotency_key.sql >/dev/null \
  && old --command "INSERT INTO breaks (event_id, start_utc, end_utc) VALUES (1, '2026-03-14T12:00:00Z', '2026-03-14T13:00:00Z')" >/dev/null \
  && old --file migrations/0006_login_attempts.sql >/dev/null && old --file migrations/0007_login_attempts_index.sql >/dev/null \
  && old --file migrations/0008_break_labels_event_idempotency.sql >/dev/null \
  && old --file migrations/0009_site_settings.sql >/dev/null || { echo "FAIL: backfill setup"; FAILS=$((FAILS + 1)); }
got=$(old --command "SELECT count(*) AS n FROM events WHERE slug GLOB '[0-9a-f]*' AND length(slug) = 32" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "1" ]; then echo "PASS (count=1): pre-existing event backfilled with a 32-hex slug"
else echo "FAIL (backfill): expected 1, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM bookings WHERE token NOT GLOB '*[^0-9a-f]*' AND length(token) = 32" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "2" ]; then echo "PASS (count=2): pre-existing bookings backfilled with 32-hex tokens"
else echo "FAIL (token backfill): expected 2, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(DISTINCT token) AS n FROM bookings" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "2" ]; then echo "PASS (count=2): backfilled tokens are distinct"
else echo "FAIL (token backfill distinct): expected 2, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM bookings WHERE idempotency_key IS NULL" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "2" ]; then echo "PASS (count=2): pre-existing bookings have no idempotency key"
else echo "FAIL (idempotency key on old rows): expected 2, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM breaks WHERE label = ''" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "1" ]; then echo "PASS (count=1): pre-existing break survived 0008 with an empty label"
else echo "FAIL (break label on old rows): expected 1, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM events WHERE idempotency_key IS NULL" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "1" ]; then echo "PASS (count=1): pre-existing event survived 0008 with no idempotency key"
else echo "FAIL (event key on old rows): expected 1, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM site_settings WHERE id = 1" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "1" ]; then echo "PASS (count=1): 0009 added the settings row to a database with earlier data"
else echo "FAIL (settings row on old database): expected 1, got '$got'"; FAILS=$((FAILS + 1)); fi

# The bookings rebuild (0015 to 0017) and the booking fields (0018) on that database, which still holds the two v1.0-shaped bookings: ids, tokens and names carry over.
old --command "SELECT token FROM bookings ORDER BY id" --json | grep -o '"token": *"[^"]*"' > "$OLD/tokens-before"
for f in 0010 0011 0012 0013 0014 0015 0016 0017 0018; do
  old --file migrations/${f}_*.sql >/dev/null || { echo "FAIL: migration $f on the upgraded database"; FAILS=$((FAILS + 1)); }
done
old --command "SELECT token FROM bookings ORDER BY id" --json | grep -o '"token": *"[^"]*"' > "$OLD/tokens-after"
if cmp -s "$OLD/tokens-before" "$OLD/tokens-after"; then echo "PASS: the rebuild kept every booking token"
else echo "FAIL: tokens differ after the rebuild"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM bookings WHERE place = 1 AND identity_seq = 1 AND lane_id IN (SELECT id FROM event_lanes WHERE event_id = bookings.event_id AND position = 1) AND identity_key IN ('rex' || char(31) || 'sam jones', 'fido' || char(31) || 'ann lee') AND value_1 IN ('Rex', 'Fido')" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "2" ]; then echo "PASS (count=2): the rebuild moved both bookings into the event's lane with their identity keys"
else echo "FAIL (rebuild): expected 2, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%legacy%'" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "0" ]; then echo "PASS (count=0): the legacy table is gone"
else echo "FAIL (legacy table): expected 0, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT (SELECT count(*) FROM event_layout) + (SELECT count(*) FROM event_lanes) AS n" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "2" ]; then echo "PASS (count=2): one layout row and one lane for the existing event"
else echo "FAIL (layout rows): expected 2, got '$got'"; FAILS=$((FAILS + 1)); fi
got=$(old --command "SELECT count(*) AS n FROM event_fields WHERE event_id = 1 AND ((position = 1 AND label = 'Dog') OR (position = 2 AND label = 'Handler')) AND required = 1 AND max_length = 80 AND in_identity = 1" --json | grep -o '"n": *[0-9]*' | head -1 | grep -o '[0-9]*$')
if [ "$got" = "2" ]; then echo "PASS (count=2): the existing event got its Dog and Handler fields"
else echo "FAIL (field backfill): expected 2, got '$got'"; FAILS=$((FAILS + 1)); fi

if [ "$FAILS" -ne 0 ]; then echo "$FAILS check(s) FAILED"; exit 1; fi
echo "All schema checks passed"

-- Booking identity keys no longer contain invisible characters.
--
-- identityKey() (src/core/identity.ts) now strips every Unicode Default_Ignorable_Code_Point (variation
-- selectors such as U+FE0F, the combining grapheme joiner U+034F, the Hangul fillers U+115F, U+1160, U+3164 and
-- U+FFA0, zero-width and bidi characters, tag characters, ...) before comparing, so "Rex" and "Rex" + U+FE0F are
-- one dog and the one-run-per-dog-and-handler unique index (bookings_one_run_per_dog_handler_keys) catches the
-- repeat. This migration brings the keys stored earlier into line.
--
-- SQL cannot normalise Unicode, so it does only what it can: it removes those code points from dog_key and
-- handler_key (the application had already NFKC-normalised and lower-cased them), then trims and collapses the
-- spaces that the removal can leave behind. dog_name and handler_name are not touched; they stay as entered.
--
-- It must not fail on data. If the stripped key of a booking would equal another booking's key in the same event
-- (the very duplicate this change exists to prevent), UPDATE OR IGNORE skips that row, which keeps its old key,
-- and the migration carries on. Those rows are left for an organiser to see and sort out; nothing is deleted.
--
-- Known limit: stripping happens after composition here but before it in JavaScript, so a key such as
-- "e" + U+034F + U+0301 (stored as separate characters) stays different from the new JavaScript key "é". That is
-- negligible: it needs a deliberately odd name, and the next booking is checked against the new keys anyway.
-- Likewise U+FEFF, which JavaScript also counts as whitespace: an old key already holds a space where one sat
-- inside a word, and SQL cannot tell it from a real space. FEFF is a format character (Cf), which the booking
-- form refuses, so it takes a row stored without that check.
--
-- The code points are the 17 ranges of Default_Ignorable_Code_Point (4174 code points) listed in the ranges table
-- below, and checked in src/test/migration-0012.test.ts against the JavaScript regex
-- \p{Default_Ignorable_Code_Point}, which is the definition identityKey() uses.
--
-- w takes each key apart one character at a time (so the work is the length of the key, not the number of code
-- points), dropping the characters that fall in a range and keeping the rest in order. Only keys with a character
-- outside printable ASCII can contain one, so only those rows are visited.

WITH RECURSIVE
  ranges(first, last) AS (VALUES
    (0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C), (0x115F, 0x1160), (0x17B4, 0x17B5), (0x180B, 0x180F),
    (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF)),
  w(id, d, od, h, oh) AS (
    SELECT id, dog_key, '', handler_key, '' FROM bookings
      WHERE dog_key GLOB '*[^ -~]*' OR handler_key GLOB '*[^ -~]*'
    UNION ALL
    SELECT id,
      substr(d, 2),
      od || CASE WHEN d = '' OR EXISTS (SELECT 1 FROM ranges WHERE unicode(substr(d, 1, 1)) BETWEEN first AND last)
                 THEN '' ELSE substr(d, 1, 1) END,
      substr(h, 2),
      oh || CASE WHEN h = '' OR EXISTS (SELECT 1 FROM ranges WHERE unicode(substr(h, 1, 1)) BETWEEN first AND last)
                 THEN '' ELSE substr(h, 1, 1) END
    FROM w WHERE d <> '' OR h <> ''
  )
UPDATE OR IGNORE bookings SET
  -- Removal can leave runs of spaces. Each pass halves a run and a name is at most 80 characters, so seven passes leave one.
  dog_key = trim(replace(replace(replace(replace(replace(replace(replace(w.od,
    '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')),
  handler_key = trim(replace(replace(replace(replace(replace(replace(replace(w.oh,
    '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '))
FROM w
WHERE w.id = bookings.id AND w.d = '' AND w.h = '';

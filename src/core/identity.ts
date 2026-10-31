/**
 * Identity key for one value of an event's identity fields (a dog's name, a handler's name, a car registration, ...): two values that
 * produce the same key are the same identity.
 * Order matters: strip default-ignorable code points, NFKC, strip them again, trim, collapse whitespace,
 * lower-case (en-GB, so no Turkish I rules).
 *
 * Default-ignorable code points (Unicode property Default_Ignorable_Code_Point: variation selectors, the
 * combining grapheme joiner, Hangul fillers, zero-width and bidi characters, tag characters and so on) render as
 * nothing, so "Rex" and "Rex" + U+FE0F must be one identity. They are stripped before NFKC (so "e" + U+034F +
 * U+0301 composes to "é") and after it (NFKC turns U+3164 and U+FFA0 into U+1160, itself default-ignorable).
 * migrations/0012_strip_default_ignorables_from_keys.sql applies the same strip to keys stored earlier.
 *
 * Known limits: lower-casing is not full case-folding ("ß" and "SS" do not collide).
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

export function identityKey(input: string): string {
  return input
    .replace(DEFAULT_IGNORABLE, "")
    .normalize("NFKC")
    .replace(DEFAULT_IGNORABLE, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-GB");
}

/**
 * Separates the keys of the identity fields inside a stored identity key. U+001F is a control character, which the
 * booking form refuses in every value, so it can never be part of a key and "ab" + "c" never collides with "a" + "bc".
 * migrations/0016_lanes_and_places.sql joins the keys of existing bookings with the same character (char(31)).
 */
export const IDENTITY_SEPARATOR = "\u001f";

/** The identity key of a booking: the key of each identity field's value, in field order, joined with U+001F. One field is just its key. */
export const identityKeyOf = (values: readonly string[]): string => values.map(identityKey).join(IDENTITY_SEPARATOR);

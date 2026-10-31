/** Every code point in Unicode general category Cf (format characters), found by scanning the whole range. */
export const FORMAT_CODE_POINTS: number[] = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (/^\p{Cf}$/u.test(String.fromCodePoint(cp))) FORMAT_CODE_POINTS.push(cp);
}

/**
 * Written out by hand, not derived: if the scan above ever used a wrong category or range these would be missing from
 * FORMAT_CODE_POINTS, and the tests that assert they are there would fail. Soft hyphen, zero-width space, ZWNJ, ZWJ,
 * left-to-right mark, byte order mark, and a tag character (the "g" in an England flag).
 */
export const ANCHOR_CODE_POINTS = [0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0xfeff, 0xe0067];

export const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** Names that must stay acceptable: accents, apostrophe, hyphen, CJK, Arabic letters with no marks, a plain emoji. */
export const ORDINARY_NAMES = ["Zoë", "Siân", "O'Brien", "Mary-Jane", "ミニー", "小狗", "كلب", "🐕"];

// @ts-check
// Pure theme-colour helpers: no DOM, no network. The admin settings preview (browser) and the Worker
// (validation at save time, and the generated stylesheet) both import this file, so they cannot disagree.
//
// Colours arrive from an admin form and end up in a served stylesheet, so the only accepted input is a hex colour
// and the CSS is built solely from hex strings that passed normaliseHex plus constant text.

/**
 * The fixed page colours the checks run against. theme.test.ts compares them with the --bg/--surface/--text/--muted
 * values in style.css, so change both together.
 */
export const PAGE_COLOURS = {
  light: { bg: "#f6f7f9", surface: "#ffffff", text: "#14181f", muted: "#4a5360" },
  dark: { bg: "#0f1216", surface: "#1a1f26", text: "#f1f3f6", muted: "#b3bbc7" },
};

/** Today's look. */
export const DEFAULT_THEME = { primary: "#0b5cad", accent: "#0b5cad" };

/** @type {{ id: string, name: string, primary: string, accent: string }[]} */
export const PRESETS = [
  { id: "ocean", name: "Ocean", ...DEFAULT_THEME },
  { id: "forest", name: "Forest", primary: "#1b6b3a", accent: "#1b6b3a" },
  { id: "berry", name: "Berry", primary: "#a1235f", accent: "#a1235f" },
  { id: "ember", name: "Ember", primary: "#b4400f", accent: "#b4400f" },
  { id: "teal", name: "Teal", primary: "#0f6b6e", accent: "#0f6b6e" },
  { id: "slate", name: "Slate", primary: "#3d4a5c", accent: "#3d4a5c" },
];

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * "#rgb" or "#rrggbb" (any case, surrounding spaces allowed) as lower-case "#rrggbb", or null for anything else.
 * @param {unknown} input
 * @returns {string | null}
 */
export function normaliseHex(input) {
  // The length cap keeps the space trimming linear on hostile input.
  if (typeof input !== "string" || input.length > 64) return null;
  const s = input.replace(/^ +| +$/g, "");
  if (!HEX.test(s)) return null;
  const h = s.slice(1).toLowerCase();
  return "#" + (h.length === 3 ? h.replace(/./g, "$&$&") : h);
}

/** @param {string} hex a normalised "#rrggbb" */
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * WCAG 2.x relative luminance of a normalised "#rrggbb".
 * @param {string} hex
 */
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 2.x contrast ratio, 1 to 21. Throws RangeError unless both are hex colours.
 * @param {string} hexA
 * @param {string} hexB
 */
export function contrastRatio(hexA, hexB) {
  const a = normaliseHex(hexA);
  const b = normaliseHex(hexB);
  if (!a || !b) throw new RangeError("contrastRatio needs two hex colours");
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const LIGHT_TEXT = "#ffffff";
const DARK_TEXT = PAGE_COLOURS.light.text;

/**
 * Whichever of white and the dark page text reads better on this background.
 * @param {string} bgHex
 */
export const textOn = (bgHex) => (contrastRatio(LIGHT_TEXT, bgHex) >= contrastRatio(DARK_TEXT, bgHex) ? LIGHT_TEXT : DARK_TEXT);

/**
 * Mixes towards white in 2% steps from 0 and returns the first colour that passes, so the same input always gives
 * the same output. The last step is pure white, which passes every check used here.
 * @param {string} hex
 * @param {(candidate: string) => boolean} passes
 */
function lighten(hex, passes) {
  const [r, g, b] = rgb(hex);
  for (let step = 0; step < 50; step++) {
    const t = step * 0.02;
    const mix = (/** @type {number} */ v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, "0");
    const candidate = `#${mix(r)}${mix(g)}${mix(b)}`;
    if (passes(candidate)) return candidate;
  }
  return "#ffffff";
}

/**
 * The colour variables for both modes. The dark colours are derived: the primary is lightened until it stands out
 * on both the dark page and the dark cards (3; buttons and selected slots sit on cards) and carries readable
 * button text (4.5), the accent until it is readable text on both dark surfaces (4.5). Throws RangeError unless both colours are hex.
 * @param {{ primary: unknown, accent: unknown }} theme
 */
export function themeTokens(theme) {
  const primary = normaliseHex(theme.primary);
  const accent = normaliseHex(theme.accent);
  if (!primary || !accent) throw new RangeError("primary and accent must be hex colours");
  const { bg, surface } = PAGE_COLOURS.dark;
  // Mid-tones can fail with both white and dark button text, so the button text must be readable too.
  const darkPrimary = lighten(
    primary,
    (c) => contrastRatio(c, bg) >= 3 && contrastRatio(c, surface) >= 3 && contrastRatio(textOn(c), c) >= 4.5,
  );
  const darkAccent = lighten(accent, (c) => contrastRatio(c, surface) >= 4.5 && contrastRatio(c, bg) >= 4.5);
  return {
    light: { "--primary": primary, "--on-primary": textOn(primary), "--accent": accent },
    dark: { "--primary": darkPrimary, "--on-primary": textOn(darkPrimary), "--accent": darkAccent },
  };
}

/**
 * Contrast checks for a theme in both modes. Blocking checks decide `ok`; the rest are warnings (filter `checks`
 * by `!pass && !blocking`). Invalid colours are named in `invalid` and give no checks.
 * @param {{ primary: unknown, accent: unknown }} theme
 * @returns {{
 *   ok: boolean,
 *   invalid: string[],
 *   checks: { id: string, label: string, mode: "light" | "dark", fg: string, bg: string, ratio: number, min: number, pass: boolean, blocking: boolean }[],
 * }}
 */
export function checkTheme(theme) {
  const invalid = ["primary", "accent"].filter((name) => normaliseHex(theme[/** @type {"primary" | "accent"} */ (name)]) === null);
  if (invalid.length) return { ok: false, invalid, checks: [] };

  const tokens = themeTokens(theme);
  /** @type {ReturnType<typeof checkTheme>["checks"]} */
  const checks = [];
  /**
   * @param {"light" | "dark"} mode
   * @param {string} id
   * @param {string} label
   * @param {string} fg
   * @param {string} bg
   * @param {number} min
   * @param {boolean} [blocking]
   */
  const add = (mode, id, label, fg, bg, min, blocking = true) => {
    const r = contrastRatio(fg, bg);
    // Rounded down, so a ratio shown as 4.5 is never a fail.
    checks.push({
      id, label: `${label} (${mode} mode)`, mode, fg, bg, ratio: Math.floor(r * 100) / 100, min, pass: r >= min, blocking,
    });
  };
  for (const mode of /** @type {const} */ (["light", "dark"])) {
    const page = PAGE_COLOURS[mode];
    const t = tokens[mode];
    add(mode, `text-${mode}-page`, "Main text on the page background", page.text, page.bg, 4.5);
    add(mode, `text-${mode}-card`, "Main text on cards", page.text, page.surface, 4.5);
    add(mode, `muted-${mode}-page`, "Secondary text on the page background", page.muted, page.bg, 4.5);
    add(mode, `muted-${mode}-card`, "Secondary text on cards", page.muted, page.surface, 4.5);
    add(mode, `button-text-${mode}`, "Button text on the main colour", t["--on-primary"], t["--primary"], 4.5);
    add(mode, `accent-${mode}-page`, "Links and outlined buttons on the page background", t["--accent"], page.bg, 4.5);
    add(mode, `accent-${mode}-card`, "Links and outlined buttons on cards", t["--accent"], page.surface, 4.5);
    add(mode, `button-shape-${mode}`, "Main colour buttons against the page background", t["--primary"], page.bg, 3, false);
    add(mode, `button-shape-${mode}-card`, "Main colour buttons against cards", t["--primary"], page.surface, 3, false);
  }
  return { ok: checks.every((c) => c.pass || !c.blocking), invalid, checks };
}

/**
 * The stylesheet for a theme. Throws RangeError unless both colours are hex; only the normalised hex values
 * from the input appear in the output.
 * @param {{ primary: unknown, accent: unknown }} theme
 */
export function themeCss(theme) {
  const { light, dark } = themeTokens(theme);
  /** @param {Record<string, string>} tokens */
  const decls = (tokens) => Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(";");
  return `:root{${decls(light)}}@media (prefers-color-scheme:dark){:root{${decls(dark)}}}\n`;
}

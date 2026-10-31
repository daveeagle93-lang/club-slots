/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  contrastRatio, checkTheme, DEFAULT_THEME, normaliseHex, PAGE_COLOURS, PRESETS, textOn, themeCss, themeTokens,
} from "./theme.js";

const INJECTIONS = [
  "#fff;}body{display:none", "red", "url(x)", "#12345", "#12345g", "#ffff", "#fff\n", "\n#fff", "expression(alert(1))",
  "#fff/*", "#fff*/", "#ffffff;", "#fff}", "#{fff", "rgb(0,0,0)", "hsl(0,0%,0%)", "var(--x)", "#ffffffff", "#fffffff",
  "", " ", "#", "fff", "#ＦＦＦ", "#ｆｆｆ", "#fff ", " #fff", "#fff\t", "#fff\u0000", "#ff f", "# fff",
  "#fff</style><script>", "#fff\\", "#00000١", "#" + "f".repeat(5000), " ".repeat(5000) + "#fff", "#fff" + " ".repeat(5000) + "x",
];

describe("normaliseHex", () => {
  it.each([
    ["#fff", "#ffffff"],
    ["#FFF", "#ffffff"],
    ["#0b5cad", "#0b5cad"],
    ["#0B5CAD", "#0b5cad"],
    ["#AbC", "#aabbcc"],
    ["  #abc  ", "#aabbcc"],
    ["#123456", "#123456"],
  ])("accepts %j as %j", (input, expected) => {
    expect(normaliseHex(input)).toBe(expected);
  });

  it.each(INJECTIONS.map((s) => [s.length > 40 ? `${s.slice(0, 20)}... (${s.length} chars)` : s, s]))(
    "rejects %j",
    (_label, input) => {
      expect(normaliseHex(input)).toBeNull();
    },
  );

  it.each([undefined, null, 0, 123456, true, {}, [], ["#fff"], { toString: () => "#fff" }, () => "#fff", Symbol("x")])(
    "rejects the non-string %p",
    (input) => {
      expect(normaliseHex(input)).toBeNull();
    },
  );
});

describe("contrastRatio", () => {
  it("matches known WCAG values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#336699", "#336699")).toBe(1);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("accepts #rgb and any case, and rejects non-hex", () => {
    expect(contrastRatio("#FFF", "#000")).toBeCloseTo(21, 5);
    expect(() => contrastRatio("red", "#fff")).toThrow(RangeError);
  });
});

describe("textOn", () => {
  it.each([
    ["#000000", "#ffffff"],
    ["#ffffff", "#14181f"],
    ["#0b5cad", "#ffffff"],
    ["#ffd400", "#14181f"],
    ["#777777", "#ffffff"],
  ])("on %s gives %s", (bg, expected) => {
    expect(textOn(bg)).toBe(expected);
  });
});

describe("page colours", () => {
  /** The value of each custom property declared in a CSS block. */
  const vars = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
  const css = readFileSync("public/style.css", "utf8");
  const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
  const light = vars(css.slice(css.indexOf(":root"), darkAt));
  const dark = vars(css.slice(darkAt, css.indexOf("}\n}", darkAt)));

  it("match public/style.css, so the contrast checks describe the real page", () => {
    for (const [mode, actual] of [["light", light], ["dark", dark]] as const) {
      const p = PAGE_COLOURS[mode];
      expect({ bg: p.bg, surface: p.surface, text: p.text, muted: p.muted }).toEqual({
        bg: actual.bg, surface: actual.surface, text: actual.text, muted: actual.muted,
      });
    }
  });
});

describe("style.css fallbacks", () => {
  const css = readFileSync("public/style.css", "utf8");
  const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
  const block = (text: string, name: string) => text.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`))?.[1];
  const light = css.slice(css.indexOf(":root"), darkAt);
  const dark = css.slice(darkAt, css.indexOf("}\n}", darkAt));

  // The fallbacks apply until /api/theme.css loads (or if it fails), so they must be what it outputs by default.
  it("--primary, --on-primary and --accent equal the default theme's tokens in both modes", () => {
    const tokens = themeTokens(DEFAULT_THEME);
    for (const [mode, text] of [["light", light], ["dark", dark]] as const) {
      for (const name of ["primary", "on-primary", "accent"]) {
        expect(block(text, name), `${mode} --${name}`).toBe(tokens[mode][`--${name}` as keyof typeof tokens.light]);
      }
    }
  });

  it("the admin sample pages use the same --border as style.css", () => {
    const admin = readFileSync("public/admin/admin.css", "utf8");
    const borders = [...admin.matchAll(/\.pv[a-z-]*\s*\{[^}]*?--border:\s*(#[0-9a-f]{6})/g)].map((m) => m[1]);
    expect(borders).toEqual([block(light, "border"), block(dark, "border")]);
  });
});

describe("presets", () => {
  it("the first preset is today's look", () => {
    expect(DEFAULT_THEME).toEqual({ primary: "#0b5cad", accent: "#0b5cad" });
    expect(PRESETS[0]).toMatchObject({ id: "ocean", ...DEFAULT_THEME });
  });

  it("are six, with unique lower-case slug ids, names and distinct primaries", () => {
    expect(PRESETS).toHaveLength(6);
    for (const p of PRESETS) expect(p.id).toMatch(/^[a-z]+$/);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(6);
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(6);
    expect(new Set(PRESETS.map((p) => p.primary)).size).toBe(6);
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))("%s passes every check, with no warnings", (_id, p) => {
    expect(normaliseHex(p.primary)).toBe(p.primary);
    expect(normaliseHex(p.accent)).toBe(p.accent);
    const result = checkTheme(p);
    expect(result.ok).toBe(true);
    expect(result.checks.filter((c) => !c.pass)).toEqual([]);
  });
});

describe("checkTheme", () => {
  it("covers light and dark, with fixed text, button text, links and button shape", () => {
    const { ok, invalid, checks } = checkTheme(DEFAULT_THEME);
    expect(ok).toBe(true);
    expect(invalid).toEqual([]);
    expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length);
    for (const mode of ["light", "dark"]) {
      const ids = checks.filter((c) => c.mode === mode).map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining([
        `text-${mode}-page`, `text-${mode}-card`, `muted-${mode}-page`, `muted-${mode}-card`,
        `button-text-${mode}`, `accent-${mode}-page`, `accent-${mode}-card`, `button-shape-${mode}`,
        `button-shape-${mode}-card`,
      ]));
    }
    for (const c of checks) {
      expect(c.label.length).toBeGreaterThan(5);
      expect(c.ratio).toBeCloseTo(Math.round(c.ratio * 100) / 100, 10);
      expect(c.pass).toBe(contrastRatio(c.fg, c.bg) >= c.min);
      expect(c.blocking).toBe(!c.id.startsWith("button-shape"));
      expect(c.min).toBe(c.id.startsWith("button-shape") ? 3 : 4.5);
    }
  });

  it("never reports a ratio that rounds up past the minimum", () => {
    for (const c of checkTheme({ primary: "#0b5cad", accent: "#767676" }).checks) {
      if (!c.pass) expect(c.ratio).toBeLessThan(c.min);
    }
  });

  it("fails a pale yellow accent on the blocking link checks only", () => {
    const result = checkTheme({ primary: "#0b5cad", accent: "#ffd400" });
    expect(result.ok).toBe(false);
    expect(result.checks.filter((c) => !c.pass && c.blocking).map((c) => c.id)).toEqual([
      "accent-light-page", "accent-light-card",
    ]);
  });

  it("treats a weak primary shape as a warning, not a failure", () => {
    const result = checkTheme({ primary: "#ffd400", accent: "#0b5cad" });
    expect(result.ok).toBe(true);
    expect(result.checks.filter((c) => !c.pass).map((c) => [c.id, c.blocking])).toEqual([
      ["button-shape-light", false], ["button-shape-light-card", false],
    ]);
  });

  it("reports invalid inputs by name and returns no checks", () => {
    expect(checkTheme({ primary: "red", accent: "#fff" })).toEqual({ ok: false, invalid: ["primary"], checks: [] });
    expect(checkTheme({ primary: "#fff", accent: "url(x)" })).toEqual({ ok: false, invalid: ["accent"], checks: [] });
    expect(checkTheme({ primary: 1, accent: undefined })).toEqual({ ok: false, invalid: ["primary", "accent"], checks: [] });
  });
});

describe("themeTokens", () => {
  it("keeps the light colours as given and normalised", () => {
    expect(themeTokens({ primary: "#0B5CAD", accent: "#F00" }).light).toEqual({
      "--primary": "#0b5cad", "--on-primary": "#ffffff", "--accent": "#ff0000",
    });
  });

  it("lightens a dark primary and accent until they stand out on the dark page", () => {
    const { dark } = themeTokens({ primary: "#000000", accent: "#000000" });
    expect(contrastRatio(dark["--primary"], PAGE_COLOURS.dark.bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(dark["--accent"], PAGE_COLOURS.dark.surface)).toBeGreaterThanOrEqual(4.5);
    expect(dark["--primary"]).not.toBe("#000000");
  });

  it("leaves colours that already pass unchanged in dark mode", () => {
    expect(themeTokens({ primary: "#ffffff", accent: "#ffffff" }).dark).toEqual({
      "--primary": "#ffffff", "--on-primary": "#14181f", "--accent": "#ffffff",
    });
  });

  it("lightens a mid-tone primary in dark mode until its button text is readable", () => {
    // White gives 4.48 here and dark text less, so the light theme fails and the derived dark one must not.
    const result = checkTheme({ primary: "#0077dd", accent: "#0b5cad" });
    expect(result.checks.filter((c) => !c.pass && c.blocking).map((c) => c.id)).toEqual(["button-text-light"]);
    expect(result.checks.filter((c) => c.mode === "dark" && !c.pass)).toEqual([]);
  });

  it("throws RangeError on invalid colours", () => {
    expect(() => themeTokens({ primary: "red", accent: "#fff" })).toThrow(RangeError);
  });

  // Every #rgb colour, as the primary and as the accent: the search terminates and the dark checks pass.
  const all = Array.from({ length: 4096 }, (_, i) => "#" + i.toString(16).padStart(3, "0"));

  it("always passes the dark checks, whatever the primary", () => {
    for (const c of all) {
      const result = checkTheme({ primary: c, accent: DEFAULT_THEME.accent });
      expect(result.checks.filter((x) => x.mode === "dark" && !x.pass), c).toEqual([]);
    }
  });

  it("always passes the dark checks, whatever the accent", () => {
    for (const c of all) {
      const result = checkTheme({ primary: DEFAULT_THEME.primary, accent: c });
      expect(result.checks.filter((x) => x.mode === "dark" && !x.pass), c).toEqual([]);
    }
  });

  it("lifts the dark primary to 3:1 on the cards as well as the page, whatever the primary", () => {
    // Buttons and selected slots sit on cards, which are lighter than the page, so the page alone is not enough.
    for (const c of all) {
      const p = themeTokens({ primary: c, accent: DEFAULT_THEME.accent }).dark["--primary"];
      expect(contrastRatio(p, PAGE_COLOURS.dark.bg), c).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(p, PAGE_COLOURS.dark.surface), c).toBeGreaterThanOrEqual(3);
    }
  });

  it("is deterministic", () => {
    expect(themeTokens({ primary: "#123", accent: "#456" })).toEqual(themeTokens({ primary: "#123", accent: "#456" }));
  });
});

describe("themeCss", () => {
  const SHAPE = new RegExp(
    "^:root\\{--primary:#[0-9a-f]{6};--on-primary:#[0-9a-f]{6};--accent:#[0-9a-f]{6}\\}" +
    "@media \\(prefers-color-scheme:dark\\)\\{:root\\{--primary:#[0-9a-f]{6};--on-primary:#[0-9a-f]{6};--accent:#[0-9a-f]{6}\\}\\}\\n?$",
  );
  const ALLOWED = /^[a-z0-9#:;{}()\-@ \n]*$/;

  it("produces the fixed shape from the tokens", () => {
    const css = themeCss({ primary: "#0b5cad", accent: "#0B5CAD" });
    const { light, dark } = themeTokens({ primary: "#0b5cad", accent: "#0b5cad" });
    const decls = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `${k}:${v}`).join(";");
    expect(css).toBe(
      `:root{${decls(light)}}@media (prefers-color-scheme:dark){:root{${decls(dark)}}}\n`,
    );
    expect(css).toMatch(SHAPE);
  });

  it("only ever emits the strict shape from the allow-list, for every #rgb colour as primary and as accent", () => {
    for (let i = 0; i < 4096; i++) {
      const c = "#" + i.toString(16).padStart(3, "0");
      for (const css of [themeCss({ primary: c, accent: "#0b5cad" }), themeCss({ primary: "#0b5cad", accent: c })]) {
        if (!SHAPE.test(css) || !ALLOWED.test(css)) throw new Error(`unexpected CSS for ${c}: ${css}`);
      }
    }
  });

  it.each(INJECTIONS.map((s) => [s.length > 40 ? `${s.slice(0, 20)}... (${s.length} chars)` : s, s]))(
    "throws RangeError for %j in either colour",
    (_label, input) => {
      expect(() => themeCss({ primary: input, accent: "#0b5cad" })).toThrow(RangeError);
      expect(() => themeCss({ primary: "#0b5cad", accent: input })).toThrow(RangeError);
    },
  );

  it("throws for non-string colours", () => {
    expect(() => themeCss({ primary: undefined, accent: "#fff" })).toThrow(RangeError);
    expect(() => themeCss({ primary: "#fff", accent: 5 })).toThrow(RangeError);
  });

  it("is deterministic", () => {
    expect(themeCss({ primary: "#a1235f", accent: "#a1235f" })).toBe(themeCss({ primary: "#a1235f", accent: "#a1235f" }));
  });
});

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const style = readFileSync("public/style.css", "utf8");
const admin = readFileSync("public/admin/admin.css", "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
const rule = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};

// iOS Safari gives date and time inputs an intrinsic min-width, so they ran past the card and the Start/End pairs overlapped
// (Chromium never showed it). These pin the rules that fix it; they check the rules exist, not how WebKit renders them.
// `npm run test:webkit` is the layout check, on a machine where Playwright supports WebKit.
describe("date and time inputs on a narrow screen", () => {
  const inputs = rule(style, 'input[type="date"], input[type="time"]');

  it.each([
    "-webkit-appearance: none;",
    "appearance: none;",
    "min-width: 0;",
    "max-width: 100%;",
    "width: 100%;",
    "height: 48px;",
    "min-height: 48px;",
    "line-height: 44px;",
  ])("the input rule has %s", (declaration) => {
    expect(inputs).toContain(declaration);
  });

  it("left-aligns the value, which iOS centres without a native appearance", () => {
    expect(style).toMatch(
      /input\[type="date"\]::-webkit-date-and-time-value, input\[type="time"\]::-webkit-date-and-time-value \{ text-align: left; \}/,
    );
  });

  it("keeps the 16px font size, or iOS zooms on focus", () => {
    expect(rule(style, ".slot, .button, input")).toContain("font-size: 1rem;");
    expect(inputs).not.toMatch(/font-size/);
  });

  it("lets the form, fields and break rows shrink below their content", () => {
    expect(rule(style, "form, .field, .break-row")).toMatch(/min-width: 0;/);
  });

  it("sizes the Start/End columns with minmax(0, 1fr), not 1fr, which can't shrink below the input", () => {
    expect(admin).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);");
    expect(admin).not.toMatch(/\.field-row \{[^}]*grid-template-columns: 1fr 1fr/);
    expect(admin).toMatch(/\.field-row > \* \{ min-width: 0; \}/);
  });

  it("shares the row's label / input / error tracks, so an error under one cell doesn't unlevel the other", () => {
    expect(admin).toContain("@supports (grid-template-rows: subgrid)");
    expect(admin).toContain(".field-row > .field { display: grid; grid-row: span 3; grid-template-rows: subgrid;");
  });
});

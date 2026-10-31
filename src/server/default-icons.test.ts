import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inspectImage } from "../core/image";
import { DEFAULT_THEME } from "../../public/theme.js";
import { MAX_ICON_BYTES } from "./settings";

const read = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, "../../public/icons", name)));

describe("the default icons", () => {
  const svg = readFileSync(join(import.meta.dirname, "../../public/icons/default.svg"), "utf8");

  it("the SVG is the default theme's main colour with a white glyph, and nothing active in it", () => {
    expect(svg).toContain(`fill="${DEFAULT_THEME.primary}"`);
    expect(svg).toContain('stroke="#ffffff"');
    expect(svg).not.toMatch(/<script|<foreignObject|<image|<use|<style|\son\w+=|href=|javascript:|data:/i);
    expect([...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]).every((c) => ["none", "#ffffff", DEFAULT_THEME.primary].includes(c))).toBe(true);
  });

  it.each([32, 180, 512] as const)("default-%i.png is a still PNG of exactly that size, within the size's cap, in the default colour at its corner", (size) => {
    const png = read(`default-${size}.png`);
    expect(inspectImage(png)).toEqual({ ok: true, type: "image/png", width: size, height: size });
    expect(png.length).toBeLessThanOrEqual(MAX_ICON_BYTES[size]);
    // The first pixel of the first scanline is its raw bytes whatever the filter (nothing is above or to its left).
    const idat: Buffer[] = [];
    let colourType = -1;
    for (let pos = 8; pos < png.length;) {
      const length = new DataView(png.buffer, png.byteOffset + pos).getUint32(0);
      const type = Buffer.from(png.subarray(pos + 4, pos + 8)).toString("latin1");
      if (type === "IHDR") colourType = png[pos + 8 + 9];
      if (type === "IDAT") idat.push(Buffer.from(png.subarray(pos + 8, pos + 8 + length)));
      pos += 12 + length;
    }
    expect([2, 6]).toContain(colourType); // RGB or RGBA, 8 bits
    const first = inflateSync(Buffer.concat(idat));
    const hex = `#${[1, 2, 3].map((i) => first[i].toString(16).padStart(2, "0")).join("")}`;
    expect(hex).toBe(DEFAULT_THEME.primary);
  });
});

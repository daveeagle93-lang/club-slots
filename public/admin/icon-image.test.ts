// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MARK_SOURCE, drawDefaultIcon, drawIcon, ICON_PADDING, ICON_SCALES, ICON_SIZES, IconError, iconLayout, MARK, MAX_ICON_BYTES, updateDefaultIcons, updateIcons } from "./icon-image.js";

const SHA = "a".repeat(64);
const logo = (type = "image/webp") => new Blob([new Uint8Array(10)], { type });

type Op = [string, ...unknown[]];

/** Fake browser pieces: records what is drawn on each canvas; toBlob answers `type` with `bytes(size)` bytes. */
function fakes({ source = { width: 300, height: 100 }, type = "image/png", bytes = (size: number, _attempt: number) => size, context = true } = {}) {
  const drawn: { size: number; ops: Op[] }[] = [];
  const close = vi.fn();
  const deps = {
    createImageBitmap: vi.fn(async (_file: unknown) => ({ ...source, close })),
    loadImage: vi.fn(async (_file: unknown) => ({ source: {}, ...source })),
    createCanvas: (width: number, height: number) => {
      const canvas = { size: width, ops: [] as Op[] };
      const attempt = drawn.filter((d) => d.size === width).length;
      drawn.push(canvas);
      expect(width).toBe(height);
      return {
        getContext: () => (context ? {
          set fillStyle(v: string) { canvas.ops.push(["fillStyle", v]); },
          set imageSmoothingQuality(v: string) { canvas.ops.push(["imageSmoothingQuality", v]); },
          set strokeStyle(v: string) { canvas.ops.push(["strokeStyle", v]); },
          set lineWidth(v: number) { canvas.ops.push(["lineWidth", v]); },
          set lineCap(v: string) { canvas.ops.push(["lineCap", v]); },
          set lineJoin(v: string) { canvas.ops.push(["lineJoin", v]); },
          beginPath: () => canvas.ops.push(["beginPath"]),
          arc: (...a: unknown[]) => canvas.ops.push(["arc", ...a]),
          moveTo: (...a: unknown[]) => canvas.ops.push(["moveTo", ...a]),
          lineTo: (...a: unknown[]) => canvas.ops.push(["lineTo", ...a]),
          stroke: () => canvas.ops.push(["stroke"]),
          fillRect: (...a: unknown[]) => canvas.ops.push(["fillRect", ...a]),
          drawImage: (_source: unknown, ...a: unknown[]) => canvas.ops.push(["drawImage", ...a]),
        } : null),
        toBlob: (cb: (b: Blob | null) => void, asked: string) => {
          canvas.ops.push(["toBlob", asked]);
          cb(type === "" ? null : new Blob([new Uint8Array(bytes(width, attempt))], { type }));
        },
      };
    },
  };
  return { deps, drawn, close };
}

describe("iconLayout", () => {
  it("uses 14% of the size as the margin and fits the logo in what is left, centred", () => {
    expect(ICON_PADDING).toBe(0.14);
    expect(iconLayout(512, 512, 512)).toEqual({ x: 72, y: 72, width: 368, height: 368 });
    expect(iconLayout(180, 180, 180)).toEqual({ x: 25, y: 25, width: 130, height: 130 });
    expect(iconLayout(32, 32, 32)).toEqual({ x: 4, y: 4, width: 24, height: 24 });
  });

  it("keeps the aspect ratio: a wide logo fills the width, a tall one the height", () => {
    expect(iconLayout(512, 300, 100)).toEqual({ x: 72, y: 195, width: 368, height: 123 });
    expect(iconLayout(512, 100, 300)).toEqual({ x: 195, y: 72, width: 123, height: 368 });
  });

  it("enlarges a small logo to fit rather than leaving it tiny", () => {
    expect(iconLayout(180, 10, 10)).toEqual({ x: 25, y: 25, width: 130, height: 130 });
  });

  it.each(ICON_SIZES)("always lands inside the margin at %i px, however odd the logo's shape", (size) => {
    const pad = Math.round(size * ICON_PADDING);
    for (const [w, h] of [[1, 1], [512, 1], [1, 512], [512, 511], [77, 13], [13, 77], [333, 333], [1000, 3], [3, 1000]]) {
      const at = iconLayout(size, w, h);
      expect(at.width, `${w}x${h}`).toBeGreaterThanOrEqual(1);
      expect(at.height, `${w}x${h}`).toBeGreaterThanOrEqual(1);
      expect(at.x, `${w}x${h}`).toBeGreaterThanOrEqual(pad);
      expect(at.y, `${w}x${h}`).toBeGreaterThanOrEqual(pad);
      expect(at.x + at.width, `${w}x${h}`).toBeLessThanOrEqual(size - pad);
      expect(at.y + at.height, `${w}x${h}`).toBeLessThanOrEqual(size - pad);
      expect(Math.abs(at.x - (size - at.x - at.width)), `${w}x${h}`).toBeLessThanOrEqual(1);
      expect(Math.abs(at.y - (size - at.y - at.height)), `${w}x${h}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("iconLayout with a scale", () => {
  it("shrinks the logo within the padded box, still centred", () => {
    expect(iconLayout(512, 512, 512, 0.5)).toEqual({ x: 164, y: 164, width: 184, height: 184 });
    expect(iconLayout(512, 512, 512, 1)).toEqual(iconLayout(512, 512, 512));
  });
});

describe("drawIcon", () => {
  it("fills the whole square with the background, then draws the logo in its layout, then exports a PNG", async () => {
    const { deps, drawn } = fakes();
    const png = await drawIcon(180, "#1b6b3a", { source: {}, width: 300, height: 100 }, deps);
    expect(png).toBeInstanceOf(Uint8Array);
    expect(png.length).toBe(180);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].ops).toEqual([
      ["fillStyle", "#1b6b3a"], ["fillRect", 0, 0, 180, 180], ["imageSmoothingQuality", "high"],
      ["drawImage", 25, 69, 130, 43], ["toBlob", "image/png"],
    ]);
  });

  it("exports once when the PNG fits the cap for its size", async () => {
    const { deps, drawn } = fakes({ bytes: (size) => MAX_ICON_BYTES[size as 32 | 180 | 512] });
    const png = await drawIcon(512, "#1b6b3a", { source: {}, width: 300, height: 100 }, deps);
    expect(png.length).toBe(200 * 1024);
    expect(drawn).toHaveLength(1);
  });

  it("redraws the logo smaller, keeping the background fill, until the PNG fits", async () => {
    const { deps, drawn } = fakes({ bytes: (size, attempt) => (attempt < 2 ? MAX_ICON_BYTES[size as 32 | 180 | 512] + 1 : 1000) });
    const png = await drawIcon(512, "#1b6b3a", { source: {}, width: 100, height: 100 }, deps);
    expect(png.length).toBe(1000);
    expect(drawn).toHaveLength(3);
    expect(ICON_SCALES).toEqual([1, 0.8, 0.65, 0.5, 0.35]);
    drawn.forEach((d, i) => {
      const at = iconLayout(512, 100, 100, ICON_SCALES[i]);
      expect(d.ops).toEqual([
        ["fillStyle", "#1b6b3a"], ["fillRect", 0, 0, 512, 512], ["imageSmoothingQuality", "high"],
        ["drawImage", at.x, at.y, at.width, at.height], ["toBlob", "image/png"],
      ]);
    });
    expect(drawn[2].ops[3]).not.toEqual(drawn[0].ops[3]);
  });

  it("gives up with an IconError after the smallest step, without looping on", async () => {
    const { deps, drawn } = fakes({ bytes: (size) => MAX_ICON_BYTES[size as 32 | 180 | 512] + 1 });
    await expect(drawIcon(32, "#000000", { source: {}, width: 1, height: 1 }, deps)).rejects.toBeInstanceOf(IconError);
    expect(drawn).toHaveLength(ICON_SCALES.length);
  });

  it("refuses a browser that has no 2D context, or answers anything but PNG", async () => {
    await expect(drawIcon(32, "#000000", { source: {}, width: 1, height: 1 }, fakes({ context: false }).deps)).rejects.toBeInstanceOf(IconError);
    for (const type of ["image/webp", "image/jpeg", "", "text/html"]) {
      await expect(drawIcon(32, "#000000", { source: {}, width: 1, height: 1 }, fakes({ type }).deps), type).rejects.toBeInstanceOf(IconError);
    }
  });
});

describe("drawDefaultIcon", () => {
  const opsOf = (drawn: { ops: Op[] }) => {
    const find = (name: string) => drawn.ops.filter((o) => o[0] === name);
    return { arc: find("arc")[0].slice(1) as number[], lines: [...find("moveTo"), ...find("lineTo")].map((o) => o.slice(1) as number[]), find };
  };

  it("fills the square with the background first, strokes the ring and the hand in the on-primary colour with round caps and joins, then exports a PNG", async () => {
    const { deps, drawn } = fakes();
    const png = await drawDefaultIcon(512, "#0b5cad", deps);
    expect(png.length).toBe(512);
    expect(drawn).toHaveLength(1);
    const names = drawn[0].ops.map((o) => o[0]);
    expect(names).toEqual([
      "fillStyle", "fillRect", "strokeStyle", "lineWidth", "lineCap", "lineJoin",
      "beginPath", "arc", "stroke", "beginPath", "moveTo", "lineTo", "lineTo", "stroke", "toBlob",
    ]);
    expect(drawn[0].ops.slice(0, 2)).toEqual([["fillStyle", "#0b5cad"], ["fillRect", 0, 0, 512, 512]]);
    expect(drawn[0].ops.filter((o) => o[0] === "lineCap" || o[0] === "lineJoin")).toEqual([["lineCap", "round"], ["lineJoin", "round"]]);
    expect(drawn[0].ops.at(-1)).toEqual(["toBlob", "image/png"]);
  });

  it("strokes in white on a dark main colour and in the dark text colour on a light one (textOn, as for button text)", async () => {
    for (const [background, ink] of [["#0b5cad", "#ffffff"], ["#1b6b3a", "#ffffff"], ["#ffe08a", "#14181f"]]) {
      const { deps, drawn } = fakes();
      await drawDefaultIcon(180, background, deps);
      expect(drawn[0].ops.find((o) => o[0] === "fillStyle"), background).toEqual(["fillStyle", background]);
      expect(drawn[0].ops.find((o) => o[0] === "strokeStyle"), background).toEqual(["strokeStyle", ink]);
    }
  });

  it.each(ICON_SIZES)("keeps the mark inside the same padded box as a logo at %i px, centred", async (size) => {
    const { deps, drawn } = fakes();
    await drawDefaultIcon(size, "#0b5cad", deps);
    const { arc, find } = opsOf(drawn[0]);
    const [cx, cy, radius] = arc;
    const lineWidth = (find("lineWidth")[0] as [string, number])[1];
    const pad = Math.round(size * ICON_PADDING);
    expect(cx).toBeCloseTo(size / 2, 6);
    expect(cy).toBeCloseTo(size / 2, 6);
    expect(cx - radius - lineWidth / 2).toBeCloseTo(pad, 6); // the ring's outer edge is the padding's edge
    expect(cx + radius + lineWidth / 2).toBeCloseTo(size - pad, 6);
    expect(arc.slice(3)).toEqual([0, 2 * Math.PI]);
    // ... and in proportion: radius 150 to stroke 36, as in the SVG
    expect(radius / lineWidth).toBeCloseTo(MARK.radius / MARK.stroke, 6);
  });

  it("places the clock hand as in the SVG, scaled with the ring", async () => {
    const { deps, drawn } = fakes();
    await drawDefaultIcon(512, "#0b5cad", deps);
    const { arc, lines } = opsOf(drawn[0]);
    const k = arc[2] / MARK.radius;
    const [start, down, end] = lines;
    expect(start[0]).toBeCloseTo(arc[0], 6); // the hand starts straight above the centre ...
    expect(start[1]).toBeCloseTo(arc[1] - 96 * k, 6); // ... 96 up (160 against the centre at 256) ...
    expect(down[0]).toBeCloseTo(start[0], 6); // ... runs straight down 102 ...
    expect(down[1] - start[1]).toBeCloseTo(102 * k, 6);
    expect(end[0] - down[0]).toBeCloseTo(68 * k, 6); // ... then 68 across and 40 down
    expect(end[1] - down[1]).toBeCloseTo(40 * k, 6);
  });

  it("redraws the mark smaller, keeping the background fill, until the PNG fits the cap", async () => {
    const { deps, drawn } = fakes({ bytes: (size, attempt) => (attempt < 2 ? MAX_ICON_BYTES[size as 32 | 180 | 512] + 1 : 1000) });
    const png = await drawDefaultIcon(512, "#1b6b3a", deps);
    expect(png.length).toBe(1000);
    expect(drawn).toHaveLength(3);
    const radii = drawn.map((d) => d.ops.find((o) => o[0] === "arc")![3] as number);
    expect(radii[1]).toBeCloseTo(radii[0] * ICON_SCALES[1], 0);
    expect(radii[2]).toBeCloseTo(radii[0] * ICON_SCALES[2], 0);
    for (const d of drawn) expect(d.ops.slice(0, 2)).toEqual([["fillStyle", "#1b6b3a"], ["fillRect", 0, 0, 512, 512]]);
  });

  it("gives up with an IconError after the smallest step, without looping on", async () => {
    const { deps, drawn } = fakes({ bytes: (size) => MAX_ICON_BYTES[size as 32 | 180 | 512] + 1 });
    await expect(drawDefaultIcon(32, "#000000", deps)).rejects.toBeInstanceOf(IconError);
    expect(drawn).toHaveLength(ICON_SCALES.length);
  });

  it("refuses a browser that has no 2D context, or answers anything but PNG", async () => {
    await expect(drawDefaultIcon(32, "#000000", fakes({ context: false }).deps)).rejects.toBeInstanceOf(IconError);
    for (const type of ["image/webp", "", "text/html"]) {
      await expect(drawDefaultIcon(32, "#000000", fakes({ type }).deps), type).rejects.toBeInstanceOf(IconError);
    }
  });

  it("is the mark in public/icons/default.svg (circle, stroke width and hand path), which stays as the design source of the bundled PNGs", () => {
    const svg = readFileSync("public/icons/default.svg", "utf8");
    const [a, b, c] = MARK.hand;
    expect(svg).toContain(`<circle cx="${MARK.centre}" cy="${MARK.centre}" r="${MARK.radius}"`);
    expect(svg).toContain(`d="M${a[0]} ${a[1]}v${b[1] - a[1]}l${c[0] - b[0]} ${c[1] - b[1]}"`);
    expect(svg.match(/stroke-width="(\d+)"/g)).toEqual([`stroke-width="${MARK.stroke}"`, `stroke-width="${MARK.stroke}"`]);
    expect(svg).toContain('stroke-linecap="round" stroke-linejoin="round"');
  });
});

describe("updateDefaultIcons", () => {
  const run = (over: Record<string, unknown> = {}) => {
    const f = fakes();
    const calls: { size: number; body: { data: string; background: string; logoSha256: string } }[] = [];
    const put = vi.fn(async (size: number, body: never) => { calls.push({ size, body }); return true; });
    const args = { background: "#1b6b3a", image: f.deps, put, ...over };
    return { f, calls, args, done: () => updateDefaultIcons(args as never) };
  };

  it("draws and sends 32, 180 and 512 px, in that order, one request each, with the default mark's source id", async () => {
    const { f, calls, done } = run();
    await done();
    expect(DEFAULT_MARK_SOURCE).toBe("0".repeat(64));
    expect(calls.map((c) => c.size)).toEqual([32, 180, 512]);
    expect(f.drawn.map((d) => d.size)).toEqual([32, 180, 512]);
    for (const c of calls) {
      expect(Object.keys(c.body).sort()).toEqual(["background", "data", "logoSha256"]);
      expect(c.body.background).toBe("#1b6b3a");
      expect(c.body.logoSha256).toBe(DEFAULT_MARK_SOURCE);
      expect(atob(c.body.data)).toHaveLength(c.size);
    }
    expect(f.deps.createImageBitmap).not.toHaveBeenCalled(); // no decoding: nothing is read from a file
  });

  it("stops at the first size the server refuses, and throws", async () => {
    const { f, args } = run({ put: vi.fn(async (size: number) => size !== 180) });
    await expect(updateDefaultIcons(args as never)).rejects.toBeInstanceOf(IconError);
    expect(f.drawn.map((d) => d.size)).toEqual([32, 180]);
  });

  it("stops quietly once a newer run has taken over, before drawing or sending the next size", async () => {
    let current = true;
    const { f, calls, args } = run({ isCurrent: () => current, put: vi.fn(async (size: number) => { if (size === 32) current = false; return true; }) });
    await updateDefaultIcons(args as never);
    expect(f.drawn.map((d) => d.size)).toEqual([32]);
    expect(calls).toHaveLength(0);
  });
});

describe("updateIcons", () => {
  const run = (over: Record<string, unknown> = {}) => {
    const f = fakes();
    const calls: { size: number; body: { data: string; background: string; logoSha256: string } }[] = [];
    const put = vi.fn(async (size: number, body: never) => { calls.push({ size, body }); return true; });
    const args = { logo: logo(), background: "#0b5cad", logoSha256: SHA, image: f.deps, put, ...over };
    return { f, calls, put, args, done: () => updateIcons(args as never) };
  };

  it("draws and sends 32, 180 and 512 px, in that order, one request each", async () => {
    const { f, calls, done } = run();
    await done();
    expect(calls.map((c) => c.size)).toEqual([32, 180, 512]);
    expect(f.drawn.map((d) => d.size)).toEqual([32, 180, 512]);
    for (const c of calls) {
      expect(Object.keys(c.body).sort()).toEqual(["background", "data", "logoSha256"]);
      expect(c.body.background).toBe("#0b5cad");
      expect(c.body.logoSha256).toBe(SHA);
      expect(atob(c.body.data)).toHaveLength(c.size); // fakes() makes `size` bytes
    }
  });

  it("decodes the logo once and releases it afterwards", async () => {
    const { f, done } = run();
    await done();
    expect(f.deps.createImageBitmap).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to the <img> decode, as for the logo", async () => {
    const f = fakes();
    f.deps.createImageBitmap.mockRejectedValue(new Error("no"));
    const { calls, args } = run({ image: f.deps });
    await updateIcons(args as never);
    expect(f.deps.loadImage).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
  });

  it("stops at the first size the server refuses, and throws", async () => {
    const { f, calls, args } = run({ put: vi.fn(async (size: number) => size !== 180) });
    await expect(updateIcons(args as never)).rejects.toBeInstanceOf(IconError);
    expect(f.drawn.map((d) => d.size)).toEqual([32, 180]);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("lets a failed request or a bad decode through as an error, after releasing the logo", async () => {
    const { f, args } = run({ put: vi.fn(async () => { throw new TypeError("offline"); }) });
    await expect(updateIcons(args as never)).rejects.toThrow("offline");
    expect(f.close).toHaveBeenCalledTimes(1);
    const broken = fakes();
    broken.deps.createImageBitmap.mockRejectedValue(new Error("no"));
    broken.deps.loadImage.mockRejectedValue(new Error("no"));
    await expect(run({ image: broken.deps }).done()).rejects.toThrow();
  });

  it("stops quietly once a newer run has taken over, before drawing or sending the next size", async () => {
    let current = true;
    const { f, calls, args } = run({
      isCurrent: () => current,
      put: vi.fn(async (size: number) => { if (size === 32) current = false; return true; }),
    });
    await updateIcons(args as never);
    expect(f.drawn.map((d) => d.size)).toEqual([32]);
    expect(calls).toHaveLength(0);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("reports a size that never fits as a failure, puts nothing for it, and doesn't go on to the next size", async () => {
    const f = fakes({ bytes: (size) => (size === 180 ? MAX_ICON_BYTES[180] + 1 : size) });
    const { calls, args } = run({ image: f.deps });
    await expect(updateIcons(args as never)).rejects.toBeInstanceOf(IconError);
    expect(calls.map((c) => c.size)).toEqual([32]);
    expect(f.drawn.filter((d) => d.size === 180)).toHaveLength(ICON_SCALES.length);
    expect(f.drawn.some((d) => d.size === 512)).toBe(false);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});

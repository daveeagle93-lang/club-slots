// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { bytesToBase64, LogoError, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, prepareLogo } from "./logo-image.js";

const file = (type = "image/png", size = 10) => new File([new Uint8Array(size)], "logo", { type });

/**
 * Fakes for the browser pieces. `bytes(width, quality)` is the size of the exported picture; `type` is what
 * canvas.toBlob hands back whatever was asked for (Safari answers PNG).
 */
function fakes({ source = { width: 2000, height: 1000 }, bytes = (() => 1000) as (width: number, quality: number) => number, type = "image/webp" } = {}) {
  const canvases: { width: number; height: number }[] = [];
  const exports: { width: number; type: string; quality: number }[] = [];
  const close = vi.fn();
  const deps = {
    createImageBitmap: vi.fn(async (_file: unknown) => ({ ...source, close })),
    loadImage: vi.fn(async (_file: unknown) => ({ source: {}, ...source })),
    createCanvas: (width: number, height: number) => {
      canvases.push({ width, height });
      return {
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (cb: (b: Blob | null) => void, asked: string, quality: number) => {
          exports.push({ width, type: asked, quality });
          cb(new Blob([new Uint8Array(bytes(width, quality))], { type }));
        },
      };
    },
  };
  return { deps, canvases, exports, close };
}

describe("prepareLogo", () => {
  it("scales the longer side to 512, keeps the aspect ratio and exports WebP", async () => {
    const { deps, canvases } = fakes();
    const out = await prepareLogo(file(), deps);
    expect(canvases).toEqual([{ width: 512, height: 256 }]);
    expect(out).toMatchObject({ contentType: "image/webp", width: 512, height: 256 });
    expect(out.bytes).toBeInstanceOf(Uint8Array);
    expect(out.bytes.length).toBe(1000);
  });

  it("handles a tall picture and never enlarges a small one", async () => {
    const tall = fakes({ source: { width: 300, height: 1500 } });
    expect(await prepareLogo(file(), tall.deps)).toMatchObject({ width: 102, height: 512 });
    const small = fakes({ source: { width: 100, height: 50 } });
    expect(await prepareLogo(file(), small.deps)).toMatchObject({ width: 100, height: 50 });
  });

  it("tries quality 0.9, 0.8, 0.7, 0.5 in turn and stops at the first that fits", async () => {
    const sizes: Record<number, number> = { 0.9: 300000, 0.8: 250000, 0.7: MAX_OUTPUT_BYTES - 1, 0.5: 1 };
    const { deps, exports } = fakes({ bytes: (_w, q) => sizes[q] });
    const out = await prepareLogo(file(), deps);
    expect(exports.map((e) => [e.type, e.quality])).toEqual([["image/webp", 0.9], ["image/webp", 0.8], ["image/webp", 0.7]]);
    expect(out.bytes.length).toBe(MAX_OUTPUT_BYTES - 1);
  });

  it("accepts a picture of exactly 200 KiB", async () => {
    const { deps } = fakes({ bytes: () => MAX_OUTPUT_BYTES });
    expect((await prepareLogo(file(), deps)).bytes.length).toBe(204800);
  });

  it("shrinks by a quarter and starts the qualities again when no quality fits", async () => {
    // Only fits once the width is down to 288 or less (512 -> 384 -> 288).
    const { deps, canvases, exports } = fakes({ bytes: (w) => (w <= 288 ? 1000 : 300000) });
    const out = await prepareLogo(file(), deps);
    expect(canvases.map((c) => c.width)).toEqual([512, 384, 288]);
    expect(exports.filter((e) => e.width === 512)).toHaveLength(4);
    expect(exports.filter((e) => e.width === 384)).toHaveLength(4);
    expect(exports.filter((e) => e.width === 288)).toHaveLength(1);
    expect(out).toMatchObject({ width: 288, height: 144 });
  });

  it("gives up with a message after a few tries", async () => {
    const { deps, canvases } = fakes({ bytes: () => 999999 });
    const failure = await prepareLogo(file(), deps).catch((e) => e);
    expect(failure).toBeInstanceOf(LogoError);
    expect(failure.message).toContain("small enough");
    expect(canvases).toHaveLength(5);
  });

  it("accepts PNG when the browser can't export WebP, without retrying qualities", async () => {
    const small = fakes({ type: "image/png", bytes: () => 5000 });
    const out = await prepareLogo(file(), small.deps);
    expect(out.contentType).toBe("image/png");

    // PNG ignores quality, so a too-big PNG goes straight to a smaller size.
    const big = fakes({ type: "image/png", bytes: (w) => (w <= 384 ? 5000 : 300000) });
    const shrunk = await prepareLogo(file(), big.deps);
    expect(big.exports.map((e) => e.width)).toEqual([512, 384]);
    expect(shrunk).toMatchObject({ contentType: "image/png", width: 384 });
  });

  it("refuses an export in any other format", async () => {
    const { deps } = fakes({ type: "image/jpeg" });
    await expect(prepareLogo(file(), deps)).rejects.toBeInstanceOf(LogoError);
  });

  it("refuses SVG and other types without decoding", async () => {
    for (const type of ["image/svg+xml", "image/gif", "text/html", ""]) {
      const { deps } = fakes();
      const failure = await prepareLogo(file(type), deps).catch((e) => e);
      expect(failure).toBeInstanceOf(LogoError);
      expect(failure.message).toContain("PNG, JPEG or WebP");
      expect(deps.createImageBitmap).not.toHaveBeenCalled();
      expect(deps.loadImage).not.toHaveBeenCalled();
    }
  });

  it("refuses a file over 20 MB without decoding it", async () => {
    const { deps } = fakes();
    const huge = file();
    Object.defineProperty(huge, "size", { value: MAX_INPUT_BYTES + 1 });
    const failure = await prepareLogo(huge, deps).catch((e) => e);
    expect(failure).toBeInstanceOf(LogoError);
    expect(failure.message).toContain("20 MB");
    expect(deps.createImageBitmap).not.toHaveBeenCalled();
  });

  it("falls back to an <img> decode when createImageBitmap fails or is missing", async () => {
    const failing = fakes();
    failing.deps.createImageBitmap.mockRejectedValue(new Error("nope"));
    expect(await prepareLogo(file(), failing.deps)).toMatchObject({ width: 512 });
    expect(failing.deps.loadImage).toHaveBeenCalledTimes(1);

    const missing = fakes();
    expect(await prepareLogo(file(), { ...missing.deps, createImageBitmap: null })).toMatchObject({ width: 512 });
    expect(missing.deps.loadImage).toHaveBeenCalledTimes(1);
  });

  it("says so when the picture can't be decoded either way", async () => {
    const { deps } = fakes();
    deps.createImageBitmap.mockRejectedValue(new Error("nope"));
    deps.loadImage.mockRejectedValue(new Error("nope"));
    await expect(prepareLogo(file(), deps)).rejects.toThrow(/couldn't read/);
  });

  it("releases the decoded bitmap, on success and on failure", async () => {
    const ok = fakes();
    await prepareLogo(file(), ok.deps);
    expect(ok.close).toHaveBeenCalledTimes(1);
    const bad = fakes({ bytes: () => 999999 });
    await prepareLogo(file(), bad.deps).catch(() => {});
    expect(bad.close).toHaveBeenCalledTimes(1);
  });
});

describe("bytesToBase64", () => {
  it("matches btoa for input larger than one chunk", () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) % 256);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    expect(bytesToBase64(bytes)).toBe(btoa(binary));
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });
});

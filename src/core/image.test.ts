import { describe, expect, it } from "vitest";
import {
  jpegWithAfterSoi, jpegWithTwoFrames, makeApng, makeJpeg, makePng, PNG_SIGNATURE, pngChunk, pngOfSize, webpAnimated, webpAnimChunksOnly,
  webpAnimFlagOnly, webpExtended, webpLossless, webpLosslessAlpha, webpLossy, webpLossyAlpha, webpLossyThenAnmf, webpWithMetadata,
  withRiffSize, withTrailing,
} from "../test/images";
import { inspectImage, MAX_IMAGE_BYTES } from "./image";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const reason = (bytes: Uint8Array) => {
  const r = inspectImage(bytes);
  return r.ok ? "ok" : r.reason;
};

describe("inspectImage: accepted images", () => {
  it("reads the type and size of a PNG", () => {
    expect(inspectImage(makePng(120, 80))).toEqual({ ok: true, type: "image/png", width: 120, height: 80 });
  });

  it("reads a JPEG's size from the first frame header, not the DHT in front of it", () => {
    expect(inspectImage(makeJpeg(300, 200))).toEqual({ ok: true, type: "image/jpeg", width: 300, height: 200 });
    expect(inspectImage(makeJpeg(64, 32, 0xc2))).toMatchObject({ ok: true, width: 64, height: 32 }); // progressive
  });

  it("reads lossy, lossless and extended WebP", () => {
    expect(inspectImage(webpLossy(100, 50))).toEqual({ ok: true, type: "image/webp", width: 100, height: 50 });
    expect(inspectImage(webpLossless(256, 129))).toEqual({ ok: true, type: "image/webp", width: 256, height: 129 });
    expect(inspectImage(webpExtended(512, 7))).toEqual({ ok: true, type: "image/webp", width: 512, height: 7 });
  });

  it("accepts the still WebP layouts browsers write: lossy, lossless, and extended with alpha or metadata but no animation", () => {
    for (const make of [webpLossy, webpLossless, webpLossyAlpha, webpLosslessAlpha, webpWithMetadata]) {
      expect(inspectImage(make(40, 30)), make.name).toEqual({ ok: true, type: "image/webp", width: 40, height: 30 });
    }
  });

  it("accepts the standalone JPEG markers TEM and RSTn between segments", () => {
    for (const marker of [0x01, 0xd0, 0xd3, 0xd7]) {
      expect(reason(jpegWithAfterSoi(8, 8, Uint8Array.of(0xff, marker))), marker.toString(16)).toBe("ok");
    }
  });

  it("accepts 1x1 and 512x512, the limits of the allowed range", () => {
    for (const make of [makePng, makeJpeg, webpLossy, webpLossless, webpExtended]) {
      expect(reason(make(1, 1)), make.name).toBe("ok");
      expect(reason(make(512, 512)), make.name).toBe("ok");
    }
  });
});

describe("inspectImage: dimensions", () => {
  it("rejects zero or more than 512 on either side, for every format", () => {
    for (const make of [makePng, makeJpeg, webpLossy, webpLossless, webpExtended]) {
      expect(reason(make(513, 10)), `${make.name} wide`).toBe("dimensions");
      expect(reason(make(10, 513)), `${make.name} tall`).toBe("dimensions");
    }
    expect(reason(makePng(0, 10, false))).toBe("dimensions");
    expect(reason(makePng(10, 0, false))).toBe("dimensions");
    expect(reason(makeJpeg(0, 10))).toBe("dimensions");
    expect(reason(makeJpeg(10, 0))).toBe("dimensions");
    expect(reason(webpLossy(0, 10))).toBe("dimensions");
  });

  it("rejects a dimension bomb: a tiny file declaring 20000 x 20000", () => {
    const png = makePng(20000, 20000, false);
    expect(png.length).toBeLessThan(100);
    expect(reason(png)).toBe("dimensions");
    expect(reason(makePng(0x7fffffff, 0xffffffff, false))).toBe("dimensions");
    expect(reason(makeJpeg(65535, 65535))).toBe("dimensions");
    expect(reason(webpLossy(16383, 16383))).toBe("dimensions");
    expect(reason(webpLossless(16384, 16384))).toBe("dimensions");
    expect(reason(webpExtended(1 << 24, 1 << 24))).toBe("dimensions");
  });
});

describe("inspectImage: size", () => {
  it("rejects nothing at all as empty", () => {
    expect(inspectImage(new Uint8Array(0))).toEqual({ ok: false, reason: "empty" });
  });

  it("accepts exactly 204800 bytes and rejects one more, before looking at the type", () => {
    expect(MAX_IMAGE_BYTES).toBe(204_800);
    expect(inspectImage(pngOfSize(204_800))).toMatchObject({ ok: true, type: "image/png" });
    expect(reason(pngOfSize(204_801))).toBe("too_large");
    expect(reason(new Uint8Array(204_801))).toBe("too_large"); // not even an image
  });
});

describe("inspectImage: the type comes only from the bytes", () => {
  const svgs: [string, Uint8Array][] = [
    ["a bare svg", text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')],
    ["an xml prolog", text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["leading whitespace", text('  \n\t<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["a UTF-8 BOM", Uint8Array.of(0xef, 0xbb, 0xbf, ...text("<svg/>"))],
    ["a UTF-16 BOM", Uint8Array.of(0xff, 0xfe, ...text("<svg/>"))],
    ["a doctype", text('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ""><svg/>')],
    ["svg that a client labelled image/png", text('<svg onload="alert(1)"/>')],
  ];
  it.each(svgs)("rejects SVG: %s", (_name, bytes) => {
    expect(inspectImage(bytes)).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("rejects an HTML/script polyglot", () => {
    expect(reason(text('<html><body><script>alert(document.cookie)</script></body></html>'))).toBe("unsupported_type");
    expect(reason(text('GIF89a/*<svg onload=alert(1)>*/=1;alert(1)'))).toBe("unsupported_type");
    expect(reason(text("<script>alert(1)</script>"))).toBe("unsupported_type");
  });

  it("rejects an image with text in front of the signature", () => {
    expect(reason(Uint8Array.of(...text("<svg/>"), ...makePng(4, 4)))).toBe("unsupported_type");
    expect(reason(Uint8Array.of(0x20, ...makePng(4, 4)))).toBe("unsupported_type");
  });

  it("rejects other formats and plain data", () => {
    const formats: Record<string, Uint8Array> = {
      gif: text("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), bmp: text("BM\x1e\x00\x00\x00\x00\x00\x00\x00\x1a\x00\x00\x00"),
      ico: Uint8Array.of(0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0), pdf: text("%PDF-1.7\n%%EOF"),
      wav: Uint8Array.of(...text("RIFF"), 4, 0, 0, 0, ...text("WAVE")), text: text("hello"),
      zip: Uint8Array.of(0x50, 0x4b, 3, 4, 0, 0), one: Uint8Array.of(0x89), twoJpegBytes: Uint8Array.of(0xff, 0xd8),
      pngSignatureShort: PNG_SIGNATURE.subarray(0, 7), riffShort: text("RIFF\0\0\0\0WEB"),
    };
    for (const [name, bytes] of Object.entries(formats)) expect(reason(bytes), name).toBe("unsupported_type");
  });
});

describe("inspectImage: nothing can ride along", () => {
  it("rejects bytes after a PNG's IEND, however few", () => {
    expect(reason(withTrailing(makePng(4, 4), 0))).toBe("corrupt");
    expect(reason(withTrailing(makePng(4, 4), ...text("<script>alert(1)</script>")))).toBe("corrupt");
  });

  it("rejects bytes after a JPEG's EOI, and a JPEG that doesn't end in one", () => {
    const jpeg = makeJpeg(4, 4);
    expect(reason(withTrailing(jpeg, 0))).toBe("corrupt");
    expect(reason(withTrailing(jpeg, 0xff, 0xd9))).toBe("corrupt"); // a second EOI is not the end
    expect(reason(withTrailing(jpeg, ...text("<script>alert(1)</script>"), 0xff, 0xd9))).toBe("corrupt");
    expect(reason(jpeg.subarray(0, jpeg.length - 2))).toBe("corrupt");
  });

  it("rejects bytes after a WebP's last chunk, and a wrong RIFF size either way", () => {
    const webp = webpLossless(8, 8);
    expect(reason(withTrailing(webp, 0, 0))).toBe("corrupt"); // size field now short of the length
    expect(reason(withRiffSize(withTrailing(webp, 0, 0), webp.length - 6))).toBe("corrupt"); // size field matches, chunks don't fill the file
    expect(reason(withRiffSize(webp, webp.length - 9))).toBe("corrupt");
    expect(reason(withRiffSize(webp, webp.length - 7))).toBe("corrupt");
    expect(reason(withRiffSize(webp, 0xffffffff))).toBe("corrupt");
    expect(reason(withRiffSize(webp, 0))).toBe("corrupt");
  });

  it("rejects a PNG with an extra chunk after IEND, or with IEND missing", () => {
    const png = makePng(4, 4);
    expect(reason(Uint8Array.of(...png, ...pngChunk("IEND", new Uint8Array(0))))).toBe("corrupt");
    expect(reason(png.subarray(0, png.length - 12))).toBe("corrupt");
  });
});

describe("inspectImage: only still images", () => {
  it("rejects an animated PNG (acTL)", () => {
    expect(reason(makeApng(8, 8))).toBe("corrupt");
  });

  it("rejects an animated WebP: the VP8X animation flag, or any ANIM or ANMF chunk", () => {
    for (const make of [webpAnimated, webpAnimFlagOnly, webpAnimChunksOnly, webpLossyThenAnmf]) {
      expect(reason(make(8, 8)), make.name).toBe("corrupt");
    }
  });

  it("rejects a JPEG with a second SOI or a second frame header", () => {
    expect(reason(jpegWithAfterSoi(8, 8, Uint8Array.of(0xff, 0xd8)))).toBe("corrupt");
    expect(reason(jpegWithTwoFrames(8, 8))).toBe("corrupt");
  });
});

describe("inspectImage: malformed input is corrupt, never a throw", () => {
  it("rejects every truncation of every format", () => {
    for (const image of [makePng(9, 9), makeJpeg(9, 9), webpLossy(9, 9), webpLossless(9, 9), webpExtended(9, 9)]) {
      for (let n = 1; n < image.length; n++) {
        const r = inspectImage(image.subarray(0, n));
        expect(r.ok && n < image.length, `${image.length} truncated to ${n}`).toBe(false);
      }
    }
  });

  it("says corrupt (not unsupported_type) for a truncated but recognisable file", () => {
    expect(reason(makePng(9, 9).subarray(0, 20))).toBe("corrupt");
    expect(reason(makeJpeg(9, 9).subarray(0, 30))).toBe("corrupt");
    expect(reason(webpLossy(9, 9).subarray(0, 24))).toBe("corrupt");
  });

  it("survives a chunk length that points far past the end, including 4 GiB - 1", () => {
    const png = makePng(4, 4).slice();
    new DataView(png.buffer).setUint32(33, 0xffffffff); // the first chunk after IHDR
    expect(reason(png)).toBe("corrupt");
    const big = makePng(4, 4).slice();
    new DataView(big.buffer).setUint32(8, 0x7fffffff); // IHDR length
    expect(reason(big)).toBe("corrupt");
  });

  it("rejects a PNG whose first chunk is not a 13 byte IHDR", () => {
    const png = (first: Uint8Array) => Uint8Array.of(...PNG_SIGNATURE, ...first, ...pngChunk("IEND", new Uint8Array(0)));
    expect(reason(png(pngChunk("IDAT", new Uint8Array(13))))).toBe("corrupt");
    expect(reason(png(pngChunk("IHDR", new Uint8Array(12))))).toBe("corrupt");
    expect(reason(png(pngChunk("IHDR", new Uint8Array(14))))).toBe("corrupt");
  });

  it("rejects a JPEG with no frame header, a bad marker or a segment past the end", () => {
    expect(reason(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBe("corrupt"); // no SOFn
    expect(reason(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0xff, 0xd9))).toBe("corrupt"); // APP0 longer than the file
    expect(reason(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9))).toBe("corrupt"); // segment length < 2
    expect(reason(Uint8Array.of(0xff, 0xd8, 0xff, 0x00, 0x00, 0xff, 0xd9))).toBe("corrupt"); // FF 00 is not a marker
    expect(reason(Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x04, 0, 0, 0xff, 0xd9))).toBe("corrupt"); // SOF too short
    expect(reason(Uint8Array.of(0xff, 0xd8, 0x00, 0x00))).toBe("unsupported_type"); // not FF D8 FF
  });

  it("does not take a JPEG's size from a DHT, JPG or DAC marker", () => {
    for (const marker of [0xc4, 0xc8, 0xcc]) expect(reason(makeJpeg(9, 9, marker))).toBe("corrupt");
  });

  it("rejects a WebP whose first chunk is not VP8, VP8L or VP8X, or whose frame header is bad", () => {
    const riffOf = (body: Uint8Array) => Uint8Array.of(...text("RIFF"), body.length + 4, 0, 0, 0, ...text("WEBP"), ...body);
    expect(reason(riffOf(Uint8Array.of(...text("ALPH"), 2, 0, 0, 0, 1, 2)))).toBe("corrupt");
    expect(reason(riffOf(Uint8Array.of(...text("VP8L"), 6, 0, 0, 0, 0x2e, 0, 0, 0, 0, 0)))).toBe("corrupt"); // wrong signature byte
    expect(reason(riffOf(Uint8Array.of(...text("VP8 "), 10, 0, 0, 0, 0, 0, 0, 1, 1, 1, 8, 0, 8, 0)))).toBe("corrupt"); // no start code
    expect(reason(riffOf(Uint8Array.of(...text("VP8X"), 4, 0, 0, 0, 0, 0, 0, 0)))).toBe("corrupt"); // VP8X too short
    expect(reason(riffOf(Uint8Array.of(...text("VP8L"), 0xff, 0xff, 0xff, 0xff, 0x2f, 0, 0, 0, 0, 0)))).toBe("corrupt"); // chunk past the end
  });

  it("never throws on random bytes behind each signature", () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
    const heads = [[...PNG_SIGNATURE], [0xff, 0xd8, 0xff], [...text("RIFF"), 0, 0, 0, 0, ...text("WEBP")]];
    for (let i = 0; i < 3000; i++) {
      const head = heads[i % 3];
      const bytes = Uint8Array.of(...head, ...Array.from({ length: i % 80 }, next));
      expect(() => inspectImage(bytes)).not.toThrow();
    }
  });
});

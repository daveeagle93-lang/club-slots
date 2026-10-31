/// <reference types="node" />
import { crc32, deflateSync } from "node:zlib";

// Tiny image fixtures built in code, so the tests carry no binary files. They have the structure a real
// file has (what src/core/image.ts walks); they aren't meant to be decodable beyond the PNG.

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const u32be = (n: number): Uint8Array => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u32le = (n: number): Uint8Array => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24);
const u16le = (n: number): Uint8Array => Uint8Array.of(n & 255, (n >>> 8) & 255);
const u16be = (n: number): Uint8Array => Uint8Array.of(n >>> 8, n & 255);

export const pngChunk = (type: string, data: Uint8Array): Uint8Array =>
  concat(u32be(data.length), ascii(type), data, u32be(crc32(concat(ascii(type), data))));

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** A greyscale PNG. `pixels: false` gives only the header and IEND, so a huge declared size stays a tiny file. */
export function makePng(width: number, height: number, pixels = true): Uint8Array {
  const header = concat(u32be(width), u32be(height), Uint8Array.of(8, 0, 0, 0, 0));
  const rows = pixels ? deflateSync(Buffer.alloc((width + 1) * height)) : new Uint8Array(0);
  return concat(PNG_SIGNATURE, pngChunk("IHDR", header), ...(pixels ? [pngChunk("IDAT", rows)] : []), pngChunk("IEND", new Uint8Array(0)));
}

const segment = (marker: number, body: Uint8Array): Uint8Array => concat(Uint8Array.of(0xff, marker), u16be(body.length + 2), body);

/** Header-only JPEG: SOI, JFIF, SOF0, SOS with a little entropy data (FF00, a restart marker, a fill byte), EOI. */
export function makeJpeg(width: number, height: number, sofMarker = 0xc0): Uint8Array {
  return concat(
    Uint8Array.of(0xff, 0xd8),
    segment(0xe0, concat(ascii("JFIF\0"), Uint8Array.of(1, 1, 0, 0, 1, 0, 1, 0, 0))),
    segment(0xdb, new Uint8Array(65)),
    segment(0xc4, new Uint8Array(17)), // DHT: must not be mistaken for a frame header
    segment(sofMarker, concat(Uint8Array.of(8), u16be(height), u16be(width), Uint8Array.of(1, 1, 0x11, 0))),
    segment(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)),
    Uint8Array.of(0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56),
    Uint8Array.of(0xff, 0xff, 0xd9), // a fill byte before the EOI
  );
}

const riff = (...chunks: Uint8Array[]): Uint8Array => {
  const body = concat(ascii("WEBP"), ...chunks);
  return concat(ascii("RIFF"), u32le(body.length), body);
};
const riffChunk = (type: string, data: Uint8Array): Uint8Array =>
  concat(ascii(type), u32le(data.length), data, data.length % 2 ? Uint8Array.of(0) : new Uint8Array(0));

export const webpLossy = (width: number, height: number): Uint8Array =>
  riff(riffChunk("VP8 ", concat(Uint8Array.of(0x10, 0, 0, 0x9d, 0x01, 0x2a), u16le(width), u16le(height), new Uint8Array(4))));

export const webpLossless = (width: number, height: number): Uint8Array =>
  riff(riffChunk("VP8L", concat(Uint8Array.of(0x2f), u32le((width - 1) | ((height - 1) << 14)), new Uint8Array(3))));

const vp8x = (width: number, height: number, flags: number): Uint8Array =>
  riffChunk("VP8X", concat(Uint8Array.of(flags, 0, 0, 0), u32le(width - 1).subarray(0, 3), u32le(height - 1).subarray(0, 3)));
const vp8lChunk = (width: number, height: number): Uint8Array =>
  riffChunk("VP8L", concat(Uint8Array.of(0x2f), u32le((width - 1) | ((height - 1) << 14)), new Uint8Array(3)));
const vp8Chunk = (width: number, height: number): Uint8Array =>
  riffChunk("VP8 ", concat(Uint8Array.of(0x10, 0, 0, 0x9d, 0x01, 0x2a), u16le(width), u16le(height), new Uint8Array(4)));

export const webpExtended = (width: number, height: number): Uint8Array =>
  riff(vp8x(width, height, 0), vp8lChunk(width, height));

// What browsers' canvas.toBlob("image/webp") really writes when there is transparency or metadata: still images
// that use the extended layout. Flags: 0x20 ICC profile, 0x10 alpha, 0x08 EXIF, 0x04 XMP, 0x02 animation.
export const webpLossyAlpha = (width: number, height: number): Uint8Array =>
  riff(vp8x(width, height, 0x10), riffChunk("ALPH", Uint8Array.of(0, 1, 2)), vp8Chunk(width, height));
export const webpLosslessAlpha = (width: number, height: number): Uint8Array =>
  riff(vp8x(width, height, 0x10), vp8lChunk(width, height));
export const webpWithMetadata = (width: number, height: number): Uint8Array =>
  riff(vp8x(width, height, 0x38), riffChunk("ICCP", new Uint8Array(5)), vp8Chunk(width, height), riffChunk("EXIF", new Uint8Array(3)), riffChunk("XMP ", new Uint8Array(4)));

/** An animated WebP: the animation flag, ANIM, and an ANMF frame. */
export const webpAnimated = (width: number, height: number): Uint8Array =>
  riff(vp8x(width, height, 0x12), riffChunk("ANIM", new Uint8Array(6)), riffChunk("ANMF", concat(new Uint8Array(16), vp8Chunk(width, height))));
/** The same file with the animation flag cleared: ANIM and ANMF chunks still make it animated. */
export const webpAnimChunksOnly = (width: number, height: number): Uint8Array =>
  riff(vp8x(width, height, 0x10), riffChunk("ANIM", new Uint8Array(6)), vp8Chunk(width, height));
/** An ANMF chunk after an ordinary first chunk (no VP8X at all). */
export const webpLossyThenAnmf = (width: number, height: number): Uint8Array =>
  riff(vp8Chunk(width, height), riffChunk("ANMF", new Uint8Array(16)));
/** The animation flag set on a VP8X that has no animation chunks. */
export const webpAnimFlagOnly = (width: number, height: number): Uint8Array =>
  riff(vp8x(width, height, 0x02), vp8lChunk(width, height));

/** An animated PNG: a still PNG with an acTL chunk after IHDR. */
export function makeApng(width: number, height: number): Uint8Array {
  const png = makePng(width, height);
  const ihdrEnd = PNG_SIGNATURE.length + 12 + 13;
  return concat(png.subarray(0, ihdrEnd), pngChunk("acTL", concat(u32be(2), u32be(0))), png.subarray(ihdrEnd));
}

/** A JPEG with `extra` bytes inserted straight after the SOI, to give the marker walk something odd to refuse or skip. */
export const jpegWithAfterSoi = (width: number, height: number, extra: Uint8Array, sofMarker = 0xc0): Uint8Array => {
  const jpeg = makeJpeg(width, height, sofMarker);
  return concat(jpeg.subarray(0, 2), extra, jpeg.subarray(2));
};
/** A JPEG with a second frame header (SOF0) in front of the usual one. */
export const jpegWithTwoFrames = (width: number, height: number): Uint8Array =>
  jpegWithAfterSoi(width, height, segment(0xc0, concat(Uint8Array.of(8), u16be(height), u16be(width), Uint8Array.of(1, 1, 0x11, 0))));

/** The same fixture with its RIFF size field set to `size`. */
export function withRiffSize(webp: Uint8Array, size: number): Uint8Array {
  const out = webp.slice();
  out.set(u32le(size), 4);
  return out;
}

export const withTrailing = (bytes: Uint8Array, ...extra: number[]): Uint8Array => concat(bytes, Uint8Array.from(extra));

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A valid PNG of exactly `total` bytes, made up with an ancillary text chunk before IEND. */
export function pngOfSize(total: number, width = 4, height = 4): Uint8Array {
  const base = makePng(width, height);
  const filler = total - base.length - 12; // one extra chunk: 12 bytes of framing
  if (filler < 0) throw new Error("total is smaller than the base image");
  const iend = base.subarray(base.length - 12);
  return concat(base.subarray(0, base.length - 12), pngChunk("tEXt", new Uint8Array(filler)), iend);
}

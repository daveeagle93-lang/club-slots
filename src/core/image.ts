/**
 * Decides whether uploaded bytes are an image we are willing to store and serve, from the bytes alone:
 * the type comes only from the magic bytes (never from a file name or Content-Type the client sent),
 * and the structure is walked end to end so nothing can ride along after the image (a script, a second
 * file). Any parse that runs off the buffer is "corrupt", never a throw. SVG, GIF, ICO, PDF, HTML and
 * the rest are "unsupported_type": SVG can carry script, and the others aren't worth the surface.
 */
export const MAX_IMAGE_BYTES = 204_800;
export const MAX_IMAGE_SIDE = 512;

export type ImageType = "image/png" | "image/jpeg" | "image/webp";
export type ImageRejection = "empty" | "too_large" | "unsupported_type" | "corrupt" | "dimensions";
export type ImageCheck = { ok: true; type: ImageType; width: number; height: number } | { ok: false; reason: ImageRejection };

type Size = { width: number; height: number } | null;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (b: Uint8Array, at: number, ascii: string | number[]): boolean => {
  const want = typeof ascii === "string" ? [...ascii].map((c) => c.charCodeAt(0)) : ascii;
  return b.length >= at + want.length && want.every((v, i) => b[at + i] === v);
};

function sniff(b: Uint8Array): ImageType | null {
  if (startsWith(b, 0, PNG_SIGNATURE)) return "image/png";
  if (startsWith(b, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, 0, "RIFF") && startsWith(b, 8, "WEBP")) return "image/webp";
  return null;
}

/** IHDR must be the first chunk, IEND must end exactly at the end of the buffer, and there is no acTL (animated PNG). */
function pngSize(b: Uint8Array): Size {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let size: Size = null;
  let pos = PNG_SIGNATURE.length;
  for (;;) {
    if (pos + 12 > b.length) return null; // length, type and CRC must fit
    const length = view.getUint32(pos);
    if (length > b.length - pos - 12) return null;
    if (size === null) {
      if (!startsWith(b, pos + 4, "IHDR") || length !== 13) return null;
      size = { width: view.getUint32(pos + 8), height: view.getUint32(pos + 12) };
    } else if (startsWith(b, pos + 4, "IEND")) {
      return length === 0 && pos + 12 === b.length ? size : null;
    } else if (startsWith(b, pos + 4, "acTL")) return null;
    pos += 12 + length;
  }
}

/**
 * Walks the markers to the one SOFn, then on to the EOI, which must be the last two bytes. A second SOI or SOFn
 * (a second picture inside the file) is refused; the only markers without a length are TEM and RSTn.
 */
function jpegSize(b: Uint8Array): Size {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let size: Size = null;
  let pos = 2; // after SOI
  for (;;) {
    if (b[pos] !== 0xff) return null;
    while (b[pos + 1] === 0xff) pos++; // fill bytes
    const marker = b[pos + 1];
    if (marker === undefined || marker === 0x00) return null;
    pos += 2;
    if (marker === 0xd9) return size !== null && pos === b.length ? size : null;
    if (marker === 0xd8) return null; // a second SOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone: no length
    if (pos + 2 > b.length) return null;
    const length = view.getUint16(pos);
    if (length < 2 || pos + length > b.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (size !== null || length < 8) return null;
      size = { width: view.getUint16(pos + 5), height: view.getUint16(pos + 3) };
    }
    pos += length;
    if (marker === 0xda) {
      // Entropy-coded data follows a scan header: FF00 and the restart markers are part of it.
      for (;;) {
        if (pos >= b.length) return null;
        if (b[pos] !== 0xff) pos++;
        else if (b[pos + 1] === 0x00 || (b[pos + 1] >= 0xd0 && b[pos + 1] <= 0xd7)) pos += 2;
        else if (b[pos + 1] === 0xff) pos++;
        else break;
      }
    }
  }
}

/**
 * The RIFF size field must equal the length minus 8 and the chunks must fill the file exactly. A still image
 * only: the animation flag in VP8X, and any ANIM or ANMF chunk, are refused.
 */
function webpSize(b: Uint8Array): Size {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 20 || view.getUint32(4, true) !== b.length - 8) return null;
  let size: Size = null;
  let pos = 12;
  while (pos < b.length) {
    if (pos + 8 > b.length) return null;
    const length = view.getUint32(pos + 4, true);
    const data = pos + 8;
    if (length > b.length - data) return null;
    if (startsWith(b, pos, "ANIM") || startsWith(b, pos, "ANMF")) return null;
    if (size === null) {
      if (startsWith(b, pos, "VP8 ")) {
        if (length < 10 || !startsWith(b, data + 3, [0x9d, 0x01, 0x2a])) return null;
        size = { width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff };
      } else if (startsWith(b, pos, "VP8L")) {
        if (length < 5 || b[data] !== 0x2f) return null;
        const bits = view.getUint32(data + 1, true);
        size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      } else if (startsWith(b, pos, "VP8X")) {
        if (length < 10 || (b[data] & 0x02) !== 0) return null; // bit 1 of the flags is "animation"
        size = {
          width: (b[data + 4] | (b[data + 5] << 8) | (b[data + 6] << 16)) + 1,
          height: (b[data + 7] | (b[data + 8] << 8) | (b[data + 9] << 16)) + 1,
        };
      } else return null;
    }
    pos = data + length + (length & 1); // chunks are padded to an even length
  }
  return pos === b.length ? size : null;
}

const PARSERS: Record<ImageType, (b: Uint8Array) => Size> = { "image/png": pngSize, "image/jpeg": jpegSize, "image/webp": webpSize };

export function inspectImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large" };
  const type = sniff(bytes);
  if (type === null) return { ok: false, reason: "unsupported_type" };
  let size: Size;
  try {
    size = PARSERS[type](bytes);
  } catch (e) {
    // Every read is bounds-checked first; this is the backstop for one that was missed.
    if (e instanceof RangeError) return { ok: false, reason: "corrupt" };
    throw e;
  }
  if (size === null) return { ok: false, reason: "corrupt" };
  const { width, height } = size;
  if (width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return { ok: false, reason: "dimensions" };
  return { ok: true, type, width, height };
}

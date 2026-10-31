// Turns a chosen picture into a small logo, in the browser, before anything is uploaded. This is a convenience
// (phone photos are several MB); the server checks the bytes again and is the real gate.
//
// The browser pieces (decoder, canvas) are passed in, so tests can drive this without a browser.

export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_INPUT_BYTES = 20 * 1024 * 1024; // don't even try to decode more than this
export const MAX_SIDE = 512;
export const MAX_OUTPUT_BYTES = 200 * 1024;
const QUALITIES = [0.9, 0.8, 0.7, 0.5];
const MAX_SHRINKS = 4;
const SHRINK = 0.75;
const OUTPUT_TYPES = ["image/webp", "image/png"]; // PNG is what browsers without WebP export hand back

/** An error whose message is fit to show to the admin as it is. */
export class LogoError extends Error {}

/** Standard base64, built in chunks so a large array never goes through one giant argument list. */
export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The real browser pieces. Kept apart so `prepareLogo` never touches globals. */
export function browserImage(window) {
  const { document } = window;
  return {
    createImageBitmap: window.createImageBitmap ? (file) => window.createImageBitmap(file) : null,
    // The fallback for browsers (or files) createImageBitmap can't handle. A data: URL, since blob: is not allowed by the CSP.
    async loadImage(file) {
      const url = `data:${file.type};base64,${bytesToBase64(new Uint8Array(await file.arrayBuffer()))}`;
      const img = document.createElement("img");
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("decode failed"));
        img.src = url;
      });
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    },
    createCanvas(width, height) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
  };
}

export async function decode(file, { createImageBitmap, loadImage }) {
  if (createImageBitmap) {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch { /* fall through to the <img> route */ }
  }
  try {
    return { ...(await loadImage(file)), close: () => {} };
  } catch {
    throw new LogoError("We couldn't read that picture. It may be damaged; try a different one.");
  }
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * `{ bytes, contentType, width, height }` for the file, scaled to fit MAX_SIDE (never enlarged) and under
 * MAX_OUTPUT_BYTES as WebP (or PNG if that is all the browser can export). Throws LogoError with a plain message.
 */
export async function prepareLogo(file, deps) {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    throw new LogoError("That file type can't be used. Choose a PNG, JPEG or WebP picture (SVG and other formats aren't accepted).");
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new LogoError("That picture is too big (over 20 MB). Choose a smaller one.");
  }
  const image = await decode(file, deps);
  try {
    if (!(image.width > 0 && image.height > 0)) throw new LogoError("That picture has no size we can use. Try a different one.");
    const fit = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    let width = Math.max(1, Math.round(image.width * fit));
    let height = Math.max(1, Math.round(image.height * fit));
    for (let shrinks = 0; shrinks <= MAX_SHRINKS; shrinks++) {
      const canvas = deps.createCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new LogoError("Your browser couldn't prepare the picture. Try a different browser.");
      context.imageSmoothingQuality = "high";
      context.drawImage(image.source, 0, 0, width, height);
      for (const quality of QUALITIES) {
        const blob = await toBlob(canvas, "image/webp", quality);
        if (!blob || !OUTPUT_TYPES.includes(blob.type)) throw new LogoError("Your browser couldn't prepare the picture. Try a different browser.");
        if (blob.size <= MAX_OUTPUT_BYTES) {
          return { bytes: new Uint8Array(await blob.arrayBuffer()), contentType: blob.type, width, height };
        }
        // PNG ignores the quality setting, so a smaller size is the only thing left to try.
        if (blob.type === "image/png") break;
      }
      width = Math.max(1, Math.round(width * SHRINK));
      height = Math.max(1, Math.round(height * SHRINK));
    }
    throw new LogoError("We couldn't make that picture small enough (under 200 KB). Try a simpler or smaller picture.");
  } finally {
    image.close();
  }
}

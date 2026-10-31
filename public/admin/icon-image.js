// Draws the app icons (browser tab, home screen, manifest) in the browser: each is a square PNG filled with the
// theme's main colour with the club's logo, or with no logo the default mark, scaled to fit inside a margin. The
// server checks every PNG again and is the real gate; this is only where the pixels come from (the Worker can't draw).
//
// Like logo-image.js, the browser pieces (decoder, canvas) are passed in so tests can drive this without a browser.

import { textOn } from "../theme.js";
import { bytesToBase64, decode } from "./logo-image.js";

/** One icon per request on the server, in this order. */
export const ICON_SIZES = [32, 180, 512];
/**
 * The most the server stores for each size (MAX_ICON_BYTES in src/server/settings.ts; a test keeps the two equal).
 * A PNG over its cap is redrawn with the logo smaller instead of being sent to be refused.
 */
export const MAX_ICON_BYTES = { 32: 16 * 1024, 180: 96 * 1024, 512: 200 * 1024 };
/** The logo's size, as a fraction of the padded box, for each try: the first that fits the cap is used. */
export const ICON_SCALES = [1, 0.8, 0.65, 0.5, 0.35];
/** The margin on each side, as a fraction of the icon's size. */
export const ICON_PADDING = 0.14;

/**
 * What an icon drawn from the default mark (no logo) sends in place of a logo digest: 64 zeros, which no SHA-256 of
 * a real logo can be in practice. DEFAULT_MARK_SOURCE in src/server/settings.ts is the same; a test keeps the two equal.
 */
export const DEFAULT_MARK_SOURCE = "0".repeat(64);

/**
 * The default mark, as in public/icons/default.svg (a test keeps the two in step): a ring and a clock hand on a
 * 512 x 512 view box, drawn in strokes of MARK.stroke with round caps and joins.
 */
export const MARK = {
  centre: 256, radius: 150, stroke: 36,
  hand: [[256, 160], [256, 262], [324, 302]],
};
// The square the mark's strokes cover, which is what gets scaled into the padded box: the ring's outer edge.
const MARK_FROM = MARK.centre - MARK.radius - MARK.stroke / 2;
const MARK_SIZE = 2 * (MARK.radius + MARK.stroke / 2);

/** An error whose message is fit to show to the admin as it is. */
export class IconError extends Error {}

/**
 * Where to draw a `width` x `height` logo in a `size` x `size` icon: as large as fits inside the margin with the
 * aspect ratio kept (a small logo is enlarged, a large one reduced), centred. `shrink` (0 to 1) scales the box down further.
 */
export function iconLayout(size, width, height, shrink = 1) {
  const box = (size - 2 * Math.round(size * ICON_PADDING)) * shrink;
  const scale = Math.min(box / width, box / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { x: Math.round((size - w) / 2), y: Math.round((size - h) / 2), width: w, height: h };
}

const toBlob = (canvas, type) => new Promise((resolve) => canvas.toBlob(resolve, type));

/**
 * The PNG bytes of one icon: the square filled with `background`, then `paint(context, scale)` draws on it. A PNG over
 * the size's cap is redrawn with the picture smaller (ICON_SCALES) until it fits; an IconError if even the smallest is too big.
 */
async function drawPng(size, background, paint, deps) {
  for (const scale of ICON_SCALES) {
    const canvas = deps.createCanvas(size, size);
    const context = canvas.getContext("2d");
    if (!context) throw new IconError("Your browser couldn't draw the app icons.");
    context.fillStyle = background;
    context.fillRect(0, 0, size, size);
    paint(context, scale);
    const blob = await toBlob(canvas, "image/png");
    if (!blob || blob.type !== "image/png") throw new IconError("Your browser couldn't make PNG icons.");
    if (blob.size <= MAX_ICON_BYTES[size]) return new Uint8Array(await blob.arrayBuffer());
  }
  throw new IconError(`The ${size} px icon is too large to store, even with the logo made smaller.`);
}

/** The PNG bytes of one icon from a decoded logo (see decode in logo-image.js). */
export function drawIcon(size, background, image, deps) {
  return drawPng(size, background, (context, scale) => {
    context.imageSmoothingQuality = "high";
    const at = iconLayout(size, image.width, image.height, scale);
    context.drawImage(image.source, at.x, at.y, at.width, at.height);
  }, deps);
}

/**
 * The PNG bytes of one icon from the default mark, in the readable text colour for `background` (the colour of text
 * on a main-colour button), laid out in the same padded box as a logo.
 */
export function drawDefaultIcon(size, background, deps) {
  return drawPng(size, background, (context, scale) => {
    const at = iconLayout(size, MARK_SIZE, MARK_SIZE, scale);
    const k = at.width / MARK_SIZE;
    const point = ([x, y]) => [at.x + (x - MARK_FROM) * k, at.y + (y - MARK_FROM) * k];
    context.strokeStyle = textOn(background);
    context.lineWidth = MARK.stroke * k;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.arc(...point([MARK.centre, MARK.centre]), MARK.radius * k, 0, 2 * Math.PI);
    context.stroke();
    context.beginPath();
    MARK.hand.forEach((p, i) => (i === 0 ? context.moveTo(...point(p)) : context.lineTo(...point(p))));
    context.stroke();
  }, deps);
}

/**
 * Draws every size with `draw(size)` and hands each to `put(size, { data, background, logoSha256 })`, which resolves
 * true once the server has stored it. One size at a time. Stops early, quietly, once `isCurrent()` is false.
 */
async function putIcons({ draw, background, logoSha256, put, isCurrent }) {
  for (const size of ICON_SIZES) {
    if (!isCurrent()) return;
    const png = await draw(size);
    if (!isCurrent()) return;
    if (!(await put(size, { data: bytesToBase64(png), background, logoSha256 }))) {
      throw new IconError(`The server didn't accept the ${size} px icon.`);
    }
  }
}

/**
 * Draws every size from `logo` (a Blob or File of the logo image) on `background` (the current main colour, "#rrggbb")
 * and hands each to `put(size, { data, background, logoSha256 })`, which resolves true once the server has stored it.
 * One size at a time. Stops early, quietly, once `isCurrent()` is false (a newer run has taken over). Throws
 * IconError (or whatever the decoder or `put` threw) on failure; the caller decides what that means for the page.
 */
export async function updateIcons({ logo, background, logoSha256, image, put, isCurrent = () => true }) {
  const decoded = await decode(logo, image);
  try {
    await putIcons({ draw: (size) => drawIcon(size, background, decoded, image), background, logoSha256, put, isCurrent });
  } finally {
    decoded.close();
  }
}

/** The same with no logo: the default mark, sent with DEFAULT_MARK_SOURCE as the digest the server expects when there is no logo. */
export function updateDefaultIcons({ background, image, put, isCurrent = () => true }) {
  return putIcons({ draw: (size) => drawDefaultIcon(size, background, image), background, logoSha256: DEFAULT_MARK_SOURCE, put, isCurrent });
}

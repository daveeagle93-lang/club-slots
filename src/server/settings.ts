import { MAX_IMAGE_BYTES, type ImageType } from "../core/image";
import { checkTheme, DEFAULT_THEME, normaliseHex } from "../../public/theme.js";
import { INVISIBLE, invisibleMessage, LINE_SEPARATORS } from "./bookings";

const MAX_CLUB_NAME = 80;
const MAX_CONTACT_NAME = 100;
const MAX_EMAIL = 254;
const MAX_WEBSITE = 200;

export interface SiteSettings {
  clubName: string;
  privacyContact: { name: string; email: string };
  website: string;
}

export interface LogoInfo { contentType: ImageType; width: number; height: number; bytes: number; sha256: string }

type Fields = Record<string, string>;

/**
 * Trimmed text of at most `max` code points, with the same character rules as the event and booking names
 * (src/server/admin-events.ts). Empty is allowed: it means "not set". A value exactly equal to `stored` (what is saved
 * now) skips the invisible-character check, so text saved before that check existed can be kept while other fields change.
 */
function checkText(value: unknown, label: string, max: number, stored?: string): { text: string } | { message: string } {
  if (typeof value !== "string") return { message: `The ${label} must be text (it can be empty).` };
  if (!value.isWellFormed()) return { message: `The ${label} can't contain unpaired surrogate characters.` };
  if (value !== stored && INVISIBLE.test(value)) return { message: invisibleMessage(label) };
  if (LINE_SEPARATORS.test(value)) return { message: `The ${label} can't contain line or paragraph separators.` };
  const text = value.trim();
  if ([...text].length > max) return { message: `The ${label} must be at most ${max} characters.` };
  if (/\p{Cc}/u.test(text)) return { message: `The ${label} can't contain control characters.` };
  return { text };
}

// One plain address. Letters and digits (any script), and . _ + - in the local part: no spaces, quotes, angle
// brackets, commas, semicolons or parentheses, so it can't be several addresses or a "Name <a@b.c>" form, and it is
// safe to put in a mailto: link. The domain needs a dot.
const EMAIL = /^[\p{L}\p{N}._+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;

function checkEmail(value: unknown, stored?: string): { text: string } | { message: string } {
  const checked = checkText(value, "email address", MAX_EMAIL, stored);
  if ("message" in checked || checked.text === "" || EMAIL.test(checked.text)) return checked;
  return { message: "Enter one email address, like name@example.org." };
}

function checkWebsite(value: unknown, stored?: string): { text: string } | { message: string } {
  const checked = checkText(value, "website address", MAX_WEBSITE, stored);
  if ("message" in checked || checked.text === "") return checked;
  const bad = { message: "Enter a full web address starting with https://, like https://example.org." };
  // The prefix check keeps out javascript:, data:, http:, ftp:, //host and a bare host before the URL parser's leniency.
  if (!/^https:\/\//i.test(checked.text) || /\s/u.test(checked.text)) return bad;
  let url: URL;
  try {
    url = new URL(checked.text);
  } catch {
    return bad;
  }
  if (url.protocol !== "https:" || url.hostname === "") return bad;
  if (url.username !== "" || url.password !== "") return { message: "The website address can't contain a user name or password." };
  if (url.href.length > MAX_WEBSITE) return { message: `The website address must be at most ${MAX_WEBSITE} characters.` };
  return { text: url.href };
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Validates the whole settings group (all three parts are required), or returns a message per field. `stored` is what
 * is saved now: a text left exactly as it is isn't checked for invisible characters again.
 */
export function parseSettingsInput(raw: Record<string, unknown>, stored?: SiteSettings): { settings: SiteSettings } | { fields: Fields } {
  const fields: Fields = {};
  const clubName = checkText(raw.clubName, "club name", MAX_CLUB_NAME, stored?.clubName);
  if ("message" in clubName) fields.clubName = clubName.message;
  const website = checkWebsite(raw.website, stored?.website);
  if ("message" in website) fields.website = website.message;

  let name = "";
  let email = "";
  const contact = asRecord(raw.privacyContact);
  if (!contact) fields.privacyContact = "Send the privacy contact as a name and an email address.";
  else {
    const n = checkText(contact.name, "privacy contact name", MAX_CONTACT_NAME, stored?.privacyContact.name);
    const e = checkEmail(contact.email, stored?.privacyContact.email);
    if ("message" in n) fields["privacyContact.name"] = n.message;
    else name = n.text;
    if ("message" in e) fields["privacyContact.email"] = e.message;
    else email = e.text;
    if (!("message" in n) && !("message" in e) && name !== "" && email === "") {
      fields["privacyContact.email"] = "A privacy contact needs an email address.";
    }
  }

  if (Object.keys(fields).length > 0) return { fields };
  return { settings: { clubName: (clubName as { text: string }).text, privacyContact: { name, email }, website: (website as { text: string }).text } };
}

export async function loadSettings(db: D1Database): Promise<SiteSettings> {
  const row = await db
    .prepare("SELECT club_name, privacy_contact_name, privacy_contact_email, website_url FROM site_settings WHERE id = 1")
    .first<{ club_name: string; privacy_contact_name: string; privacy_contact_email: string; website_url: string }>();
  // The migration inserts the row; a missing one reads as nothing set rather than failing every page.
  return {
    clubName: row?.club_name ?? "",
    privacyContact: { name: row?.privacy_contact_name ?? "", email: row?.privacy_contact_email ?? "" },
    website: row?.website_url ?? "",
  };
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

/** Replaces the text settings. The theme columns are not touched. */
export async function saveSettings(db: D1Database, s: SiteSettings): Promise<void> {
  await db
    .prepare(
      `INSERT INTO site_settings (id, club_name, privacy_contact_name, privacy_contact_email, website_url) VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT (id) DO UPDATE SET club_name = excluded.club_name, privacy_contact_name = excluded.privacy_contact_name,
         privacy_contact_email = excluded.privacy_contact_email, website_url = excluded.website_url, updated_at = ${NOW_SQL}`,
    )
    .bind(s.clubName, s.privacyContact.name, s.privacyContact.email, s.website)
    .run();
}

interface LogoRow { content_type: ImageType; width: number; height: number; size: number; sha256: string }
const LOGO_INFO_SQL = "SELECT content_type, width, height, length(bytes) AS size, sha256 FROM site_logo WHERE id = 1";
const toInfo = (r: LogoRow): LogoInfo => ({ contentType: r.content_type, width: r.width, height: r.height, bytes: r.size, sha256: r.sha256 });

/** What the logo is, without reading its bytes. */
export async function loadLogoInfo(db: D1Database): Promise<LogoInfo | null> {
  const row = await db.prepare(LOGO_INFO_SQL).first<LogoRow>();
  return row ? toInfo(row) : null;
}

/** The logo with its bytes. D1 hands a BLOB back as an array of numbers (or an ArrayBuffer, depending on the runtime). */
export async function loadLogo(db: D1Database): Promise<{ info: LogoInfo; data: Uint8Array } | null> {
  const row = await db
    .prepare("SELECT content_type, width, height, length(bytes) AS size, sha256, bytes FROM site_logo WHERE id = 1")
    .first<LogoRow & { bytes: ArrayBuffer | number[] }>();
  if (!row) return null;
  return { info: toInfo(row), data: row.bytes instanceof ArrayBuffer ? new Uint8Array(row.bytes) : Uint8Array.from(row.bytes) };
}

export const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The icons are made from the logo, so every change to the logo drops them in the same batch; the browser redraws them. */
const DELETE_ICONS_SQL = "DELETE FROM site_icons";

/** Stores the logo in place of any earlier one. The caller has already run the bytes through inspectImage. */
export async function saveLogo(db: D1Database, data: Uint8Array, image: { type: ImageType; width: number; height: number }): Promise<LogoInfo> {
  const sha256 = hex(await crypto.subtle.digest("SHA-256", data));
  await db.batch([
    db
      .prepare(
        `INSERT INTO site_logo (id, content_type, bytes, width, height, sha256) VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET content_type = excluded.content_type, bytes = excluded.bytes, width = excluded.width,
           height = excluded.height, sha256 = excluded.sha256, updated_at = ${NOW_SQL}`,
      )
      .bind(image.type, data, image.width, image.height, sha256),
    db.prepare(DELETE_ICONS_SQL),
  ]);
  return { contentType: image.type, width: image.width, height: image.height, bytes: data.byteLength, sha256 };
}

/** Removes the logo, and the icons made from it. Removing one that isn't there is fine. */
export async function deleteLogo(db: D1Database): Promise<void> {
  await db.batch([db.prepare("DELETE FROM site_logo WHERE id = 1"), db.prepare(DELETE_ICONS_SQL)]);
}

/** The `?v=` that changes whenever the logo does, so a long cache lifetime is safe. */
export const logoVersion = (sha256: string): string => sha256.slice(0, 16);
export const logoUrl = (info: LogoInfo): string => `/api/logo?v=${logoVersion(info.sha256)}`;

export const ICON_SIZES = [32, 180, 512] as const;
export type IconSize = (typeof ICON_SIZES)[number];
/** Per-size caps on the PNG: a 32 px icon has no business being larger than 16 KiB. The table allows up to 200 KiB for any size. */
export const MAX_ICON_BYTES: Record<IconSize, number> = { 32: 16 * 1024, 180: 96 * 1024, 512: 200 * 1024 };

/** "32", "180" or "512" exactly (no sign, no leading zeros, no whitespace), else null. */
export const parseIconSize = (text: string): IconSize | null => ICON_SIZES.find((size) => String(size) === text) ?? null;

/**
 * What an icon drawn from the default mark (the club has no logo) stores as the digest of the logo it was drawn from:
 * 64 zeros, which no SHA-256 of a real logo can be in practice. saveIcon accepts it only while there is no logo.
 * DEFAULT_MARK_SOURCE in public/admin/icon-image.js is the same; a test keeps the two equal.
 */
export const DEFAULT_MARK_SOURCE = "0".repeat(64);

export interface IconInfo { sha256: string; bytes: number }

/** What a stored icon is, without reading its bytes. */
export async function loadIconInfo(db: D1Database, size: IconSize): Promise<IconInfo | null> {
  return db.prepare("SELECT sha256, length(bytes) AS bytes FROM site_icons WHERE size = ?1").bind(size).first<IconInfo>();
}

/** A stored icon with its bytes (see loadLogo for how D1 hands a BLOB back). */
export async function loadIcon(db: D1Database, size: IconSize): Promise<{ info: IconInfo; data: Uint8Array } | null> {
  const row = await db
    .prepare("SELECT sha256, length(bytes) AS size, bytes FROM site_icons WHERE size = ?1")
    .bind(size)
    .first<{ sha256: string; size: number; bytes: ArrayBuffer | number[] }>();
  if (!row) return null;
  return { info: { sha256: row.sha256, bytes: row.size }, data: row.bytes instanceof ArrayBuffer ? new Uint8Array(row.bytes) : Uint8Array.from(row.bytes) };
}

/**
 * Stores one icon, in place of any earlier one for that size, only if the logo it was drawn from is still the stored
 * logo (or, for DEFAULT_MARK_SOURCE, there is still no logo) and its background is still the main colour (the stored
 * one, else the default). One statement, so a logo or colour change between a check and the write can't leave an
 * out-of-date icon.
 * Returns the icon's SHA-256, or null when nothing was stored because one of them changed. The caller has already checked the PNG.
 */
export async function saveIcon(db: D1Database, size: IconSize, data: Uint8Array, from: { background: string; logoSha256: string }): Promise<string | null> {
  const sha256 = hex(await crypto.subtle.digest("SHA-256", data));
  const result = await db
    .prepare(
      `INSERT INTO site_icons (size, content_type, bytes, width, height, sha256, background, logo_sha256)
       SELECT ?1, 'image/png', ?2, ?1, ?1, ?3, ?4, ?5
       WHERE (EXISTS (SELECT 1 FROM site_logo WHERE id = 1 AND sha256 = ?5)
           OR (?5 = ?7 AND NOT EXISTS (SELECT 1 FROM site_logo WHERE id = 1)))
         AND COALESCE((SELECT theme_primary FROM site_settings WHERE id = 1), ?6) = ?4
       ON CONFLICT (size) DO UPDATE SET bytes = excluded.bytes, sha256 = excluded.sha256, background = excluded.background,
         logo_sha256 = excluded.logo_sha256, updated_at = ${NOW_SQL}`,
    )
    .bind(size, data, sha256, from.background, from.logoSha256, DEFAULT_THEME.primary, DEFAULT_MARK_SOURCE)
    .run();
  return result.meta.changes > 0 ? sha256 : null;
}

/** What the stored icons were drawn from, or null unless all three sizes are there and agree. Never the bytes. */
export async function loadIconsStatus(db: D1Database): Promise<{ background: string; logoSha256: string } | null> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n, MIN(background) AS b1, MAX(background) AS b2, MIN(logo_sha256) AS l1, MAX(logo_sha256) AS l2 FROM site_icons")
    .first<{ n: number; b1: string | null; b2: string | null; l1: string | null; l2: string | null }>();
  if (!row || row.n !== ICON_SIZES.length || row.b1 !== row.b2 || row.l1 !== row.l2 || row.b1 === null || row.l1 === null) return null;
  return { background: row.b1, logoSha256: row.l1 };
}

/** `sha256` is only for the admin page: it must send it back with each icon so the server can tell which logo the icon was drawn from. */
export interface AdminLogo { url: string; width: number; height: number; contentType: ImageType; bytes: number; sha256: string }
export const adminLogo = (info: LogoInfo): AdminLogo => ({
  url: logoUrl(info), width: info.width, height: info.height, contentType: info.contentType, bytes: info.bytes, sha256: info.sha256,
});

export interface ThemeInfo { primary: string; accent: string; isDefault: boolean }

const defaultTheme = (): ThemeInfo => ({ ...DEFAULT_THEME, isDefault: true });

/**
 * The stored theme, or the default if none is set. What is stored is checked again here (the same colour and
 * contrast rules as at save time) because it ends up in a served stylesheet on every page: a value someone
 * edited into the database by hand falls back to the default instead of being served.
 */
export async function loadTheme(db: D1Database): Promise<ThemeInfo> {
  const row = await db
    .prepare("SELECT theme_primary, theme_accent FROM site_settings WHERE id = 1")
    .first<{ theme_primary: string | null; theme_accent: string | null }>();
  if (!row) return defaultTheme();
  const primary = normaliseHex(row.theme_primary);
  const accent = normaliseHex(row.theme_accent);
  if (!primary || !accent || !checkTheme({ primary, accent }).ok) return defaultTheme();
  return { primary, accent, isDefault: false };
}

/** Stores a theme. The colours are normalised again here, so only "#rrggbb" can reach the database. */
export async function saveTheme(db: D1Database, theme: { primary: string; accent: string }): Promise<void> {
  const primary = normaliseHex(theme.primary);
  const accent = normaliseHex(theme.accent);
  if (!primary || !accent) throw new RangeError("primary and accent must be hex colours");
  // An upsert, like saveSettings: a plain UPDATE of a missing row changes nothing and would still report a save.
  await db
    .prepare(
      `INSERT INTO site_settings (id, theme_primary, theme_accent) VALUES (1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET theme_primary = excluded.theme_primary, theme_accent = excluded.theme_accent, updated_at = ${NOW_SQL}`,
    )
    .bind(primary, accent)
    .run();
}

/** Back to the default theme. Resetting one that is already default is fine. */
export async function resetTheme(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO site_settings (id) VALUES (1)
       ON CONFLICT (id) DO UPDATE SET theme_primary = NULL, theme_accent = NULL, updated_at = ${NOW_SQL}`,
    )
    .run();
}

export interface ContrastFailure { id: string; label: string; mode: "light" | "dark"; ratio: number; min: number }

/**
 * Validates a theme request: both colours must be hex (fields per bad colour), and the pair must pass every
 * blocking contrast check (the failures, otherwise). Non-blocking warnings don't stop a save. The browser runs the
 * same checks as a convenience; this is the one that is enforced.
 */
export function parseThemeInput(raw: Record<string, unknown>):
  { theme: { primary: string; accent: string } } | { fields: Fields } | { failures: ContrastFailure[] } {
  const primary = normaliseHex(raw.primary);
  const accent = normaliseHex(raw.accent);
  const fields: Fields = {};
  if (!primary) fields.primary = "Enter the main colour as a hex code, like #0b5cad.";
  if (!accent) fields.accent = "Enter the accent colour as a hex code, like #0b5cad.";
  if (!primary || !accent) return { fields };
  const result = checkTheme({ primary, accent });
  if (result.ok) return { theme: { primary, accent } };
  const failures = result.checks
    .filter((c) => c.blocking && !c.pass)
    .map(({ id, label, mode, ratio, min }) => ({ id, label, mode, ratio, min }));
  return { failures };
}

/** Everything the settings form shows. */
export async function loadAdminSettings(
  db: D1Database,
): Promise<SiteSettings & { logo: AdminLogo | null; theme: ThemeInfo; icons: { background: string; logoSha256: string } | null }> {
  const [settings, logo, theme, icons] = await Promise.all([loadSettings(db), loadLogoInfo(db), loadTheme(db), loadIconsStatus(db)]);
  return { ...settings, logo: logo ? adminLogo(logo) : null, theme, icons };
}

export interface PublicSettings {
  clubName: string | null;
  website: string | null;
  privacyContact: { name: string; email: string } | null;
  logo: { url: string; width: number; height: number } | null;
}

/** Only what public pages need: no timestamps, theme or hashes (beyond the `?v=` in the logo URL). */
export async function loadPublicSettings(db: D1Database): Promise<PublicSettings> {
  const [settings, logo] = await Promise.all([loadSettings(db), loadLogoInfo(db)]);
  return {
    clubName: settings.clubName || null,
    website: settings.website || null,
    // The contact counts as set only with an email.
    privacyContact: settings.privacyContact.email ? settings.privacyContact : null,
    logo: logo ? { url: logoUrl(logo), width: logo.width, height: logo.height } : null,
  };
}

/** The longest base64 text that can decode to a logo within the size cap; checked before decoding. */
export const MAX_LOGO_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/** Standard base64 only: the + / alphabet, padded to a multiple of 4. No whitespace, no URL-safe alphabet. */
export function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  // An index loop: Uint8Array.from with a callback took about 11 ms for 200 KiB, past the 10 ms CPU budget of the free plan.
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

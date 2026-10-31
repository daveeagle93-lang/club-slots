import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANCHOR_CODE_POINTS, FORMAT_CODE_POINTS, hex, ORDINARY_NAMES } from "../test/format-chars";
import { makePng } from "../test/images";
import { createTestEnv, type TestEnv } from "../test/db";
import {
  decodeBase64, deleteLogo, loadAdminSettings, loadIcon, loadIconInfo, loadLogo, loadLogoInfo, loadPublicSettings, loadSettings, loadTheme,
  DEFAULT_MARK_SOURCE, MAX_ICON_BYTES, MAX_LOGO_BASE64, parseSettingsInput, parseThemeInput, resetTheme, saveIcon, saveLogo, saveSettings, saveTheme,
} from "./settings";
import { DEFAULT_MARK_SOURCE as CLIENT_DEFAULT_MARK_SOURCE, MAX_ICON_BYTES as CLIENT_MAX_ICON_BYTES } from "../../public/admin/icon-image.js";
import { DEFAULT_THEME } from "../../public/theme.js";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());
beforeEach(async () => {
  await t.env.DB.prepare("DELETE FROM site_logo").run();
  await t.env.DB.prepare("DELETE FROM site_icons").run();
  await saveSettings(t.env.DB, { clubName: "", privacyContact: { name: "", email: "" }, website: "" });
});

const ok = { clubName: "Example Dog Club", privacyContact: { name: "Pat Example", email: "pat@example.org" }, website: "https://example.org/" };
const parse = (over: Record<string, unknown>) => parseSettingsInput({ ...ok, ...over });
const fieldsOf = (r: ReturnType<typeof parseSettingsInput>) => ("fields" in r ? r.fields : null);

describe("parseSettingsInput", () => {
  it("accepts a full set and trims it", () => {
    expect(parseSettingsInput(ok)).toEqual({ settings: ok });
    expect(parse({ clubName: "  Spaced  ", website: " https://example.org/x ", privacyContact: { name: " A ", email: " a@b.co " } })).toEqual({
      settings: { clubName: "Spaced", privacyContact: { name: "A", email: "a@b.co" }, website: "https://example.org/x" },
    });
  });

  it("accepts everything empty (nothing set)", () => {
    expect(parseSettingsInput({ clubName: "", privacyContact: { name: "", email: "" }, website: "" })).toEqual({
      settings: { clubName: "", privacyContact: { name: "", email: "" }, website: "" },
    });
    expect(parse({ clubName: "   ", website: "  " })).toMatchObject({ settings: { clubName: "", website: "" } });
  });

  it("accepts an email with no name", () => {
    expect(parse({ privacyContact: { name: "", email: "office@example.org" } })).toMatchObject({ settings: { privacyContact: { name: "", email: "office@example.org" } } });
  });

  it("requires all three parts, as text", () => {
    for (const key of ["clubName", "privacyContact", "website"]) {
      const { [key]: _omitted, ...rest } = ok as Record<string, unknown>;
      expect(Object.keys(fieldsOf(parseSettingsInput(rest))!), `missing ${key}`).toEqual([key]);
    }
    for (const value of [null, 5, true, [], {}, ["x"]]) {
      expect(fieldsOf(parse({ clubName: value })), JSON.stringify(value)).toHaveProperty("clubName");
      expect(fieldsOf(parse({ website: value })), JSON.stringify(value)).toHaveProperty("website");
    }
    for (const value of [null, "x", 5, [], [{}]]) {
      expect(fieldsOf(parse({ privacyContact: value })), JSON.stringify(value)).toHaveProperty("privacyContact");
    }
    expect(fieldsOf(parse({ privacyContact: { name: "x" } }))).toHaveProperty(["privacyContact.email"]);
    expect(fieldsOf(parse({ privacyContact: { email: "a@b.co" } }))).toHaveProperty(["privacyContact.name"]);
  });

  it("reports a field-level message for each bad field at once", () => {
    const fields = fieldsOf(parseSettingsInput({ clubName: 1, privacyContact: { name: "x".repeat(101), email: "nope" }, website: "http://x.org" }))!;
    expect(Object.keys(fields).sort()).toEqual(["clubName", "privacyContact.email", "privacyContact.name", "website"]);
  });

  describe("club name and contact name", () => {
    it("counts code points, not UTF-16 units: 80 emoji are fine, 81 are not", () => {
      expect(fieldsOf(parse({ clubName: "😀".repeat(80) }))).toBeNull();
      expect(fieldsOf(parse({ clubName: "😀".repeat(81) }))).toHaveProperty("clubName");
      expect(fieldsOf(parse({ clubName: "a".repeat(80) }))).toBeNull();
      expect(fieldsOf(parse({ clubName: "a".repeat(81) }))).toHaveProperty("clubName");
      const contact = (name: string) => parse({ privacyContact: { name, email: "a@b.co" } });
      expect(fieldsOf(contact("😀".repeat(100)))).toBeNull();
      expect(fieldsOf(contact("😀".repeat(101)))).toHaveProperty(["privacyContact.name"]);
    });

    it.each([
      ["a control character", "Club\u0000"], ["a tab inside", "Dog\tClub"], ["a newline", "Dog\nClub"], ["DEL", "Dog\u007fClub"],
      ["U+2028", "Dog Club"], ["U+2029", "Dog Club"], ["a zero-width space", "Dog​Club"], ["a bidi override", "Dog‮Club"],
      ["a BOM", "﻿Club"], ["an unpaired surrogate", "Club\ud800"],
    ])("rejects %s", (_name, value) => {
      expect(fieldsOf(parse({ clubName: value }))).toHaveProperty("clubName");
      expect(fieldsOf(parse({ privacyContact: { name: value, email: "a@b.co" } }))).toHaveProperty(["privacyContact.name"]);
    });
  });

  describe("format characters (Unicode category Cf)", () => {
    const settingsWith = (field: string, value: string) => {
      if (field === "clubName") return parse({ clubName: value });
      if (field === "website") return parse({ website: value });
      if (field === "privacyContact.name") return parse({ privacyContact: { name: value, email: "a@b.co" } });
      return parse({ privacyContact: { name: "", email: value } });
    };
    const textFields = ["clubName", "privacyContact.name", "privacyContact.email", "website"];
    const wrap = (field: string, ch: string) =>
      field === "website" ? `https://exa${ch}mple.org/` : field === "privacyContact.email" ? `a${ch}b@c.co` : `a${ch}b`;

    it("rejects every Cf character in every text field as invisible", () => {
      const wrong: string[] = [];
      for (const cp of FORMAT_CODE_POINTS) {
        for (const field of textFields) {
          const fields = fieldsOf(settingsWith(field, wrap(field, String.fromCodePoint(cp))));
          if (!fields?.[field]?.includes("invisible")) wrong.push(`${hex(cp)} in ${field}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    it("rejects each known format character (hand-listed, and in the scan) in every text field", () => {
      for (const cp of ANCHOR_CODE_POINTS) {
        expect(FORMAT_CODE_POINTS, hex(cp)).toContain(cp);
        for (const field of textFields) {
          expect(fieldsOf(settingsWith(field, wrap(field, String.fromCodePoint(cp))))?.[field], `${hex(cp)} in ${field}`).toContain("invisible");
        }
      }
    });

    it("rejects U+061C ARABIC LETTER MARK by name", () => {
      expect(fieldsOf(parse({ clubName: "Cl\u061Cub" }))?.clubName).toBe("The club name can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.");
    });

    it("rejects the joiners U+200C and U+200D", () => {
      for (const ch of ["\u200C", "\u200D"]) expect(fieldsOf(parse({ clubName: `a${ch}b` }))).toHaveProperty("clubName");
    });

    it.each(ORDINARY_NAMES)("still accepts %s as a club name and a contact name", (name) => {
      expect(fieldsOf(parse({ clubName: name }))).toBeNull();
      expect(fieldsOf(parse({ privacyContact: { name, email: "a@b.co" } }))).toBeNull();
    });
  });

  describe("privacy contact email", () => {
    const email = (value: unknown) => fieldsOf(parse({ privacyContact: { name: "", email: value } }))?.["privacyContact.email"];

    it.each(["a@b.co", "first.last+tag@mail.example.org", "o_neil-x@sub-domain.example.co.uk", "ünï@exämple.org", "1@2.3"])("accepts %s", (value) => {
      expect(email(value)).toBeUndefined();
    });

    it.each([
      "plain", "a@b", "@b.co", "a@", "a@.co", "a@b.", "a@b..co", "a@@b.co", "a@b@c.co", "a b@c.co", "a@b c.co", "a@b.co d@e.fr",
      "<a@b.co>", "Pat <a@b.co>", "\"a\"@b.co", "'a'@b.co", "a@b.co, d@e.fr", "a@b.co; d@e.fr", "a(b)@c.co", "a@b.co(x)", "a[b]@c.co",
      "a\\b@c.co", "a:b@c.co", "a@b.co?subject=x", "a@b.co/x", "a@b.co#x", "a%0d@b.co", "a\u0000@b.co", "a\n@b.co", "a@b.co\nBcc: x@y.zz",
      "mailto:a@b.co", "a@[127.0.0.1]", "a@b_c.co", "a&b@c.co", "a=b@c.co", "a/b@c.co", "a?b@c.co",
    ])("rejects %j", (value) => {
      expect(email(value), value).toBeTypeOf("string");
    });

    it("allows 254 characters and rejects 255", () => {
      const at = (n: number) => `${"a".repeat(n - "@b.co".length)}@b.co`;
      expect(email(at(254))).toBeUndefined();
      expect(email(at(255))).toMatch(/at most 254/);
    });

    it("rejects a name without an email, on the email field", () => {
      const fields = fieldsOf(parse({ privacyContact: { name: "Pat", email: "" } }));
      expect(fields).toEqual({ "privacyContact.email": "A privacy contact needs an email address." });
      expect(fieldsOf(parse({ privacyContact: { name: "Pat", email: "   " } }))).toHaveProperty(["privacyContact.email"]);
    });

    it("wants text", () => {
      for (const value of [undefined, null, 5, {}, ["a@b.co"]]) expect(email(value), JSON.stringify(value)).toBeTypeOf("string");
    });
  });

  describe("website", () => {
    const website = (value: unknown) => {
      const r = parse({ website: value });
      return "fields" in r ? { error: r.fields.website } : { stored: r.settings.website };
    };

    it("accepts https and stores the normalised href", () => {
      expect(website("https://example.org")).toEqual({ stored: "https://example.org/" });
      expect(website("HTTPS://Example.ORG/Path?q=1#top")).toEqual({ stored: "https://example.org/Path?q=1#top" });
      expect(website("https://example.org:8443/a b".replace(" ", "%20"))).toEqual({ stored: "https://example.org:8443/a%20b" });
      expect(website("https://bücher.example/")).toEqual({ stored: "https://xn--bcher-kva.example/" });
    });

    it.each([
      ["javascript:alert(1)"], ["JavaScript:alert(1)"], ["  javascript:alert(1)//https://x.org"], ["data:text/html,<script>alert(1)</script>"],
      ["http://example.org"], ["ftp://example.org"], ["file:///etc/passwd"], ["//example.org"], ["example.org"], ["www.example.org"],
      ["https:example.org"], ["https:/example.org"], ["https:\\\\example.org"], ["https://"], ["https:///"], ["https://user@example.org"],
      ["https://user:pass@example.org"], ["https://:pass@example.org"], ["https://exa mple.org"], ["https://example.org/a b"],
      ["https://example.org/\u0000"], ["https://example.org/\nx"], ["https://example.org/ "], ["https://exa\tmple.org"],
      ["mailto:a@b.co"], ["blob:https://example.org/x"], ["vbscript:x"], ["https://[::1"], ["https://exa<mple.org"],
    ])("rejects %j", (value) => {
      expect(website(value), value).toHaveProperty("error");
    });

    it("says what is wanted", () => {
      expect(website("javascript:alert(1)")).toEqual({ error: "Enter a full web address starting with https://, like https://example.org." });
      expect(website("https://u:p@example.org")).toEqual({ error: "The website address can't contain a user name or password." });
    });

    it("allows 200 characters and rejects 201", () => {
      const url = (n: number) => `https://example.org/${"a".repeat(n - "https://example.org/".length)}`;
      expect(website(url(200))).toEqual({ stored: url(200) });
      expect(website(url(201))).toHaveProperty("error");
    });

    it("measures the stored href too, which can be longer than what was typed", () => {
      expect(website(`https://example.org/${"é".repeat(150)}`)).toHaveProperty("error");
    });
  });
});

describe("the text settings in D1", () => {
  it("start empty and survive a round trip, including non-ASCII", async () => {
    expect(await loadSettings(t.env.DB)).toEqual({ clubName: "", privacyContact: { name: "", email: "" }, website: "" });
    const settings = { clubName: "Café Dogs 🐕", privacyContact: { name: "Zoë", email: "zoe@example.org" }, website: "https://example.org/" };
    await saveSettings(t.env.DB, settings);
    expect(await loadSettings(t.env.DB)).toEqual(settings);
  });

  it("keeps a single row however often it is saved, and leaves the theme alone", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = '#112233', theme_accent = '#aabbcc'").run();
    await saveSettings(t.env.DB, { clubName: "One", privacyContact: { name: "", email: "" }, website: "" });
    await saveSettings(t.env.DB, { clubName: "Two", privacyContact: { name: "", email: "" }, website: "" });
    const rows = await t.env.DB.prepare("SELECT club_name, theme_primary, theme_accent FROM site_settings").all();
    expect(rows.results).toEqual([{ club_name: "Two", theme_primary: "#112233", theme_accent: "#aabbcc" }]);
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = NULL, theme_accent = NULL").run();
  });

  it("refreshes updated_at when saved", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET updated_at = '2000-01-01T00:00:00Z'").run();
    await saveSettings(t.env.DB, ok);
    const row = await t.env.DB.prepare("SELECT updated_at FROM site_settings").first<{ updated_at: string }>();
    expect(row!.updated_at > "2020-01-01T00:00:00Z").toBe(true);
  });
});

describe("the logo in D1", () => {
  it("round-trips byte for byte, with every byte value including 0x00 and 0xFF", async () => {
    const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const data = Uint8Array.of(...allBytes, ...[...allBytes].reverse(), 0, 0, 255, 255, 0);
    await saveLogo(t.env.DB, data, { type: "image/png", width: 2, height: 3 });
    const loaded = await loadLogo(t.env.DB);
    expect(loaded!.data).toBeInstanceOf(Uint8Array);
    expect(loaded!.data.length).toBe(data.length);
    expect(Buffer.from(loaded!.data).equals(Buffer.from(data))).toBe(true);
    expect(loaded!.info).toMatchObject({ contentType: "image/png", width: 2, height: 3, bytes: data.length });
    const stored = await t.env.DB.prepare("SELECT typeof(bytes) AS t, length(bytes) AS n FROM site_logo").first();
    expect(stored).toEqual({ t: "blob", n: data.length });
  });

  it("round-trips a real-sized file", async () => {
    const data = Uint8Array.from({ length: 204_800 }, (_, i) => (i * 7 + (i >> 8)) & 255);
    await saveLogo(t.env.DB, data, { type: "image/webp", width: 512, height: 512 });
    const loaded = await loadLogo(t.env.DB);
    expect(Buffer.from(loaded!.data).equals(Buffer.from(data))).toBe(true);
  });

  it("stores the SHA-256 as lower-case hex, matching a reference digest", async () => {
    const data = makePng(3, 3);
    const info = await saveLogo(t.env.DB, data, { type: "image/png", width: 3, height: 3 });
    const { createHash } = await import("node:crypto");
    expect(info.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect((await loadLogoInfo(t.env.DB))!.sha256).toBe(info.sha256);
  });

  it("replaces in place and deletes, any number of times", async () => {
    expect(await loadLogo(t.env.DB)).toBeNull();
    expect(await loadLogoInfo(t.env.DB)).toBeNull();
    const first = await saveLogo(t.env.DB, makePng(4, 4), { type: "image/png", width: 4, height: 4 });
    const second = await saveLogo(t.env.DB, makePng(8, 6), { type: "image/png", width: 8, height: 6 });
    expect(second.sha256).not.toBe(first.sha256);
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM site_logo").first<{ n: number }>())!.n).toBe(1);
    expect(await loadLogoInfo(t.env.DB)).toEqual(second);
    await deleteLogo(t.env.DB);
    await deleteLogo(t.env.DB); // nothing there: not an error
    expect(await loadLogo(t.env.DB)).toBeNull();
  });
});

describe("MAX_ICON_BYTES", () => {
  it("is the same in the browser's icon drawing (public/admin/icon-image.js) as on the server, so the two can't drift apart", () => {
    expect(CLIENT_MAX_ICON_BYTES).toEqual(MAX_ICON_BYTES);
  });
});

describe("DEFAULT_MARK_SOURCE", () => {
  it("is the same in the browser's icon drawing as on the server, and has the shape of a SHA-256 digest (the table's CHECK)", () => {
    expect(CLIENT_DEFAULT_MARK_SOURCE).toBe(DEFAULT_MARK_SOURCE);
    expect(DEFAULT_MARK_SOURCE).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the icons in D1", () => {
  const BG = "#0b5cad";
  const png = (size: number) => makePng(size, size);
  const storeLogo = async (w = 4) => (await saveLogo(t.env.DB, makePng(w, w), { type: "image/png", width: w, height: w })).sha256;
  const storeIcons = async (logoSha256: string, background = BG) => {
    for (const size of [32, 180, 512] as const) expect(await saveIcon(t.env.DB, size, png(size), { background, logoSha256 })).toMatch(/^[0-9a-f]{64}$/);
  };
  const iconCount = async () => (await t.env.DB.prepare("SELECT COUNT(*) AS n FROM site_icons").first<{ n: number }>())!.n;
  beforeEach(() => resetTheme(t.env.DB)); // an icon's background must be the main colour in force: the default unless a test sets one

  it("round-trips byte for byte, with the digest as lower-case hex", async () => {
    const sha = await storeLogo();
    const data = Uint8Array.of(...Array.from({ length: 256 }, (_, i) => i), 0, 255);
    expect(await saveIcon(t.env.DB, 32, data, { background: BG, logoSha256: sha })).toMatch(/^[0-9a-f]{64}$/);
    const { createHash } = await import("node:crypto");
    const loaded = await loadIcon(t.env.DB, 32);
    expect(loaded!.info.sha256).toBe(await saveIcon(t.env.DB, 32, data, { background: BG, logoSha256: sha }));
    expect(Buffer.from(loaded!.data).equals(Buffer.from(data))).toBe(true);
    expect(loaded!.info).toEqual({ sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length });
    expect(await loadIconInfo(t.env.DB, 32)).toEqual(loaded!.info);
    expect(await loadIcon(t.env.DB, 180)).toBeNull();
    expect(await loadIconInfo(t.env.DB, 512)).toBeNull();
  });

  it("replaces a size in place with one statement", async () => {
    const sha = await storeLogo();
    await saveIcon(t.env.DB, 180, png(180), { background: BG, logoSha256: sha });
    const before = (await loadIconInfo(t.env.DB, 180))!.sha256;
    await saveTheme(t.env.DB, { primary: "#112233", accent: "#112233" });
    await saveIcon(t.env.DB, 180, makePng(180, 180, false), { background: "#112233", logoSha256: sha });
    expect(await iconCount()).toBe(1);
    expect((await loadIconInfo(t.env.DB, 180))!.sha256).not.toBe(before);
    expect(await t.env.DB.prepare("SELECT background, logo_sha256, width, height, content_type FROM site_icons").first())
      .toEqual({ background: "#112233", logo_sha256: sha, width: 180, height: 180, content_type: "image/png" });
  });

  it("stores nothing, and says so, when there is no logo or the logo is not the one the icon was made from", async () => {
    expect(await saveIcon(t.env.DB, 32, png(32), { background: BG, logoSha256: "a".repeat(64) })).toBeNull();
    const sha = await storeLogo();
    expect(await saveIcon(t.env.DB, 32, png(32), { background: BG, logoSha256: "b".repeat(64) })).toBeNull();
    expect(await iconCount()).toBe(0);
    expect(await saveIcon(t.env.DB, 32, png(32), { background: BG, logoSha256: sha })).toMatch(/^[0-9a-f]{64}$/);
  });

  describe("drawn from the default mark (DEFAULT_MARK_SOURCE)", () => {
    it("is stored while there is no logo, and then reported as the icons' source by the admin settings", async () => {
      expect(await loadLogoInfo(t.env.DB)).toBeNull();
      await storeIcons(DEFAULT_MARK_SOURCE);
      expect(await iconCount()).toBe(3);
      expect((await loadAdminSettings(t.env.DB)).icons).toEqual({ background: BG, logoSha256: DEFAULT_MARK_SOURCE });
    });

    it("stores nothing while a logo is stored, and says so", async () => {
      await storeLogo();
      expect(await saveIcon(t.env.DB, 32, png(32), { background: BG, logoSha256: DEFAULT_MARK_SOURCE })).toBeNull();
      expect(await iconCount()).toBe(0);
    });

    it("is not kept by an icon of a real logo's digest while there is no logo", async () => {
      expect(await saveIcon(t.env.DB, 32, png(32), { background: BG, logoSha256: "a".repeat(64) })).toBeNull();
      expect(await iconCount()).toBe(0);
    });

    it("still needs the main colour in force", async () => {
      expect(await saveIcon(t.env.DB, 32, png(32), { background: "#112233", logoSha256: DEFAULT_MARK_SOURCE })).toBeNull();
      await saveTheme(t.env.DB, { primary: "#1b6b3a", accent: "#1b6b3a" });
      expect(await saveIcon(t.env.DB, 32, png(32), { background: BG, logoSha256: DEFAULT_MARK_SOURCE })).toBeNull();
      expect(await saveIcon(t.env.DB, 32, png(32), { background: "#1b6b3a", logoSha256: DEFAULT_MARK_SOURCE })).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is dropped, all three sizes, when a logo is saved", async () => {
      await storeIcons(DEFAULT_MARK_SOURCE);
      await saveLogo(t.env.DB, makePng(5, 5), { type: "image/png", width: 5, height: 5 });
      expect(await iconCount()).toBe(0);
    });
  });

  it("stores nothing when the background is not the main colour in force now (the stored one, else the default)", async () => {
    const sha = await storeLogo();
    expect(await saveIcon(t.env.DB, 32, png(32), { background: "#112233", logoSha256: sha })).toBeNull(); // default theme in force
    await saveTheme(t.env.DB, { primary: "#1b6b3a", accent: "#1b6b3a" });
    expect(await saveIcon(t.env.DB, 32, png(32), { background: BG, logoSha256: sha })).toBeNull(); // the old colour
    expect(await iconCount()).toBe(0);
    expect(await saveIcon(t.env.DB, 32, png(32), { background: "#1b6b3a", logoSha256: sha })).toMatch(/^[0-9a-f]{64}$/);
    await resetTheme(t.env.DB);
    expect(await saveIcon(t.env.DB, 180, png(180), { background: DEFAULT_THEME.primary, logoSha256: sha })).toMatch(/^[0-9a-f]{64}$/);
    expect(await iconCount()).toBe(2);
  });

  it("is removed, all three sizes, in the same batch as a logo save or delete", async () => {
    await storeIcons(await storeLogo());
    expect(await iconCount()).toBe(3);
    const batches: unknown[][] = [];
    const spy = {
      prepare: (sql: string) => t.env.DB.prepare(sql),
      batch: (statements: D1PreparedStatement[]) => { batches.push(statements); return t.env.DB.batch(statements); },
    } as unknown as D1Database;
    await saveLogo(spy as D1Database, makePng(5, 5), { type: "image/png", width: 5, height: 5 });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(await iconCount()).toBe(0);

    await storeIcons((await loadLogoInfo(t.env.DB))!.sha256);
    await deleteLogo(spy as D1Database);
    expect(batches).toHaveLength(2);
    expect(await iconCount()).toBe(0);
    expect(await loadLogoInfo(t.env.DB)).toBeNull();
  });

  it("is kept when a logo save fails, because the icons are removed only together with the change", async () => {
    await storeIcons(await storeLogo());
    await expect(saveLogo(t.env.DB, new Uint8Array(0), { type: "image/png", width: 1, height: 1 })).rejects.toThrow();
    expect(await iconCount()).toBe(3);
    expect(await loadLogoInfo(t.env.DB)).not.toBeNull();
  });

  it("deleting a logo that isn't there still clears stray icons", async () => {
    await t.env.DB.prepare("DELETE FROM site_logo").run();
    await t.env.DB.prepare("INSERT INTO site_icons (size, content_type, bytes, width, height, sha256, background, logo_sha256) VALUES (32, 'image/png', x'01', 32, 32, ?, '#0b5cad', ?)")
      .bind("a".repeat(64), "b".repeat(64)).run();
    await deleteLogo(t.env.DB);
    expect(await iconCount()).toBe(0);
  });

  describe("in the admin settings", () => {
    it("are null with none stored, and with fewer than three sizes", async () => {
      const sha = await storeLogo();
      expect((await loadAdminSettings(t.env.DB)).icons).toBeNull();
      await saveIcon(t.env.DB, 32, png(32), { background: BG, logoSha256: sha });
      await saveIcon(t.env.DB, 180, png(180), { background: BG, logoSha256: sha });
      expect((await loadAdminSettings(t.env.DB)).icons).toBeNull();
    });

    it("are the background and logo digest once all three sizes are stored, never the bytes", async () => {
      const sha = await storeLogo();
      await saveTheme(t.env.DB, { primary: "#1b6b3a", accent: "#1b6b3a" });
      await storeIcons(sha, "#1b6b3a");
      const admin = await loadAdminSettings(t.env.DB);
      expect(admin.icons).toEqual({ background: "#1b6b3a", logoSha256: sha });
      expect(JSON.stringify(admin)).not.toMatch(/bytes"\s*:\s*\[/);
    });

    it("are null when the sizes were made on different backgrounds or from different logos (a half-redrawn set)", async () => {
      const sha = await storeLogo();
      await storeIcons(sha);
      await saveTheme(t.env.DB, { primary: "#112233", accent: "#112233" });
      await saveIcon(t.env.DB, 512, png(512), { background: "#112233", logoSha256: sha });
      expect((await loadAdminSettings(t.env.DB)).icons).toBeNull();
    });

    it("do not appear in the public settings", async () => {
      await storeIcons(await storeLogo());
      expect(Object.keys(await loadPublicSettings(t.env.DB)).sort()).toEqual(["clubName", "logo", "privacyContact", "website"]);
    });
  });
});

describe("loadPublicSettings and loadAdminSettings", () => {
  it("public: nulls for everything unset", async () => {
    expect(await loadPublicSettings(t.env.DB)).toEqual({ clubName: null, website: null, privacyContact: null, logo: null });
  });

  it("public: the contact counts as set only with an email", async () => {
    await saveSettings(t.env.DB, { clubName: "", privacyContact: { name: "Pat", email: "" }, website: "" });
    expect((await loadPublicSettings(t.env.DB)).privacyContact).toBeNull();
    await saveSettings(t.env.DB, { clubName: "", privacyContact: { name: "", email: "a@b.co" }, website: "" });
    expect((await loadPublicSettings(t.env.DB)).privacyContact).toEqual({ name: "", email: "a@b.co" });
  });

  it("public: carries the logo url with a 16-character version, and admin carries the extras", async () => {
    await saveSettings(t.env.DB, ok);
    const info = await saveLogo(t.env.DB, makePng(10, 20), { type: "image/png", width: 10, height: 20 });
    const url = `/api/logo?v=${info.sha256.slice(0, 16)}`;
    expect(await loadPublicSettings(t.env.DB)).toEqual({ ...ok, logo: { url, width: 10, height: 20 } });
    expect(await loadAdminSettings(t.env.DB)).toEqual({
      ...ok, logo: { url, width: 10, height: 20, contentType: "image/png", bytes: makePng(10, 20).length, sha256: info.sha256 },
      theme: { ...DEFAULT_THEME, isDefault: true }, icons: null,
    });
  });

  it("admin: carries the saved theme, public never does", async () => {
    await saveTheme(t.env.DB, { primary: "#1b6b3a", accent: "#a1235f" });
    expect((await loadAdminSettings(t.env.DB)).theme).toEqual({ primary: "#1b6b3a", accent: "#a1235f", isDefault: false });
    expect(JSON.stringify(await loadPublicSettings(t.env.DB))).not.toMatch(/theme|1b6b3a|a1235f/);
    await resetTheme(t.env.DB);
  });
});

describe("the theme in D1", () => {
  const DEFAULT = { ...DEFAULT_THEME, isDefault: true };
  const row = () => t.env.DB.prepare("SELECT theme_primary, theme_accent, updated_at FROM site_settings").first<{ theme_primary: string | null; theme_accent: string | null; updated_at: string }>();
  beforeEach(() => resetTheme(t.env.DB));

  it("is the default, flagged as such, when both columns are NULL", async () => {
    expect(await loadTheme(t.env.DB)).toEqual(DEFAULT);
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = '#1b6b3a'").run(); // only one of the two
    expect(await loadTheme(t.env.DB)).toEqual(DEFAULT);
  });

  it("is the default when the row is missing", async () => {
    await t.env.DB.prepare("DELETE FROM site_settings").run();
    try {
      expect(await loadTheme(t.env.DB)).toEqual(DEFAULT);
    } finally {
      await t.env.DB.prepare("INSERT INTO site_settings (id) VALUES (1)").run();
    }
  });

  it("saves and resets even when the singleton row is missing, instead of reporting a save that changed nothing", async () => {
    const rows = async () => (await t.env.DB.prepare("SELECT count(*) AS n FROM site_settings").first<{ n: number }>())!.n;
    try {
      await t.env.DB.prepare("DELETE FROM site_settings").run();
      await saveTheme(t.env.DB, { primary: "#1b6b3a", accent: "#a1235f" });
      expect(await rows()).toBe(1);
      expect(await loadTheme(t.env.DB)).toEqual({ primary: "#1b6b3a", accent: "#a1235f", isDefault: false });

      await t.env.DB.prepare("DELETE FROM site_settings").run();
      await resetTheme(t.env.DB);
      expect(await rows()).toBe(1);
      expect(await loadTheme(t.env.DB)).toEqual(DEFAULT);
    } finally {
      // Put the migration's row back for the other tests.
      await t.env.DB.prepare("INSERT OR IGNORE INTO site_settings (id) VALUES (1)").run();
    }
  });

  it("saves normalised colours and loads them back", async () => {
    await saveTheme(t.env.DB, { primary: " #1B6B3A ", accent: "#a1235f" });
    expect(await row()).toMatchObject({ theme_primary: "#1b6b3a", theme_accent: "#a1235f" });
    expect(await loadTheme(t.env.DB)).toEqual({ primary: "#1b6b3a", accent: "#a1235f", isDefault: false });
  });

  it("refuses to store anything that isn't a hex colour, leaving the old theme", async () => {
    await saveTheme(t.env.DB, { primary: "#1b6b3a", accent: "#1b6b3a" });
    for (const bad of ["red", "#fff;}x{", "url(//evil)", "", "#12345678", "</style>"]) {
      await expect(saveTheme(t.env.DB, { primary: bad, accent: "#1b6b3a" }), bad).rejects.toThrow(RangeError);
      await expect(saveTheme(t.env.DB, { primary: "#1b6b3a", accent: bad }), bad).rejects.toThrow(RangeError);
    }
    expect(await row()).toMatchObject({ theme_primary: "#1b6b3a", theme_accent: "#1b6b3a" });
  });

  it("refreshes updated_at on save and on reset, and reset is idempotent", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET updated_at = '2000-01-01T00:00:00Z'").run();
    await saveTheme(t.env.DB, { primary: "#1b6b3a", accent: "#1b6b3a" });
    expect((await row())!.updated_at > "2020-01-01T00:00:00Z").toBe(true);
    await t.env.DB.prepare("UPDATE site_settings SET updated_at = '2000-01-01T00:00:00Z'").run();
    await resetTheme(t.env.DB);
    await resetTheme(t.env.DB);
    const after = await row();
    expect(after).toMatchObject({ theme_primary: null, theme_accent: null });
    expect(after!.updated_at > "2020-01-01T00:00:00Z").toBe(true);
    expect(await loadTheme(t.env.DB)).toEqual(DEFAULT);
  });

  it("leaves the text settings alone", async () => {
    await saveSettings(t.env.DB, ok);
    await saveTheme(t.env.DB, { primary: "#1b6b3a", accent: "#1b6b3a" });
    await resetTheme(t.env.DB);
    expect(await loadSettings(t.env.DB)).toEqual(ok);
    await saveSettings(t.env.DB, { clubName: "", privacyContact: { name: "", email: "" }, website: "" });
  });

  // The CHECK in the migration only allows #rrggbb, which normaliseHex always accepts, so a stored value that gets
  // past it can only fail the contrast rules. All of these are valid hex.
  it.each([
    ["a pale accent", "#0b5cad", "#ffd400"],
    ["a grey accent", "#0b5cad", "#808080"],
    ["a primary that light button text can't sit on", "#0077dd", "#0b5cad"],
  ])("falls back to the default for stored colours that fail the contrast checks: %s", async (_name, primary, accent) => {
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = ?, theme_accent = ?").bind(primary, accent).run();
    expect(await loadTheme(t.env.DB)).toEqual(DEFAULT);
  });

  it("still serves a stored theme that only has warnings", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = '#ffd400', theme_accent = '#0b5cad'").run();
    expect(await loadTheme(t.env.DB)).toEqual({ primary: "#ffd400", accent: "#0b5cad", isDefault: false });
  });

  it("falls back to the default for values the CHECK forbids, if they get in some other way", async () => {
    // ignore_check_constraints stands in for a database edited by hand or restored from another version.
    const bad = ["red", "#fff;}body{display:none", "url(//evil)", "</style><script>", "", "#12345678", "rgb(0,0,0)"];
    try {
      await t.env.DB.prepare("PRAGMA ignore_check_constraints = ON").run();
      for (const value of bad) {
        await t.env.DB.prepare("UPDATE site_settings SET theme_primary = ?1, theme_accent = '#0b5cad'").bind(value).run();
        expect((await row())!.theme_primary, value).toBe(value); // it really is in the table
        expect(await loadTheme(t.env.DB), value).toEqual(DEFAULT);
        await t.env.DB.prepare("UPDATE site_settings SET theme_primary = '#0b5cad', theme_accent = ?1").bind(value).run();
        expect(await loadTheme(t.env.DB), value).toEqual(DEFAULT);
      }
    } finally {
      await t.env.DB.prepare("PRAGMA ignore_check_constraints = OFF").run();
    }
  });
});

describe("parseThemeInput", () => {
  it("accepts two colours, normalising them", () => {
    expect(parseThemeInput({ primary: "#1B6B3A", accent: " #a1b " })).toEqual({ theme: { primary: "#1b6b3a", accent: "#aa11bb" } });
  });

  it("names each colour that isn't hex, and only those", () => {
    const fields = (raw: Record<string, unknown>) => ("fields" in parseThemeInput(raw) ? Object.keys((parseThemeInput(raw) as { fields: object }).fields) : null);
    expect(fields({ primary: "red", accent: "#1b6b3a" })).toEqual(["primary"]);
    expect(fields({ primary: "#1b6b3a", accent: 5 })).toEqual(["accent"]);
    expect(fields({ primary: null, accent: undefined })).toEqual(["primary", "accent"]);
    expect(fields({})).toEqual(["primary", "accent"]);
  });

  it("lists only the blocking failures, and not the warnings", () => {
    const result = parseThemeInput({ primary: "#0b5cad", accent: "#ffd400" });
    expect(result).toHaveProperty("failures");
    const { failures } = result as { failures: { id: string; mode: string; ratio: number; min: number; label: string }[] };
    expect(failures.map((f) => f.id)).toContain("accent-light-page");
    for (const f of failures) {
      expect(Object.keys(f).sort()).toEqual(["id", "label", "min", "mode", "ratio"]);
      expect(f.ratio).toBeLessThan(f.min);
      expect(f.id).not.toMatch(/^button-shape/);
    }
  });

  it("lets a theme that only has non-blocking warnings through", () => {
    // A pale yellow primary fails button-shape (a warning) but its button text is readable.
    expect(parseThemeInput({ primary: "#ffd400", accent: "#0b5cad" })).toEqual({ theme: { primary: "#ffd400", accent: "#0b5cad" } });
  });

  it("reports a primary whose light-mode button text is just under the minimum", () => {
    const result = parseThemeInput({ primary: "#0077dd", accent: "#0b5cad" }) as { failures: { id: string }[] };
    expect(result.failures.map((f) => f.id)).toEqual(["button-text-light"]);
  });
});

describe("decodeBase64", () => {
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

  it("decodes standard padded base64", () => {
    for (const bytes of [[], [0], [0, 255], [0, 255, 128], [1, 2, 3, 4], [251, 255, 254]]) {
      expect(decodeBase64(b64(bytes)), JSON.stringify(bytes)).toEqual(Uint8Array.from(bytes));
    }
    expect(b64([251, 255, 254])).toContain("+");
    expect(b64([255, 255, 255])).toContain("/");
  });

  it.each([
    ["whitespace", "QUJD RA=="], ["a newline", "QUJD\nRA=="], ["a trailing newline", "QUJDRA==\n"], ["a leading space", " QUJD"],
    ["the URL-safe alphabet", "-_-_"], ["missing padding", "QUJDRA"], ["too much padding", "QUJDR==="], ["padding in the middle", "QQ==QUJD"],
    ["padding that isn't last", "QU=D"], ["a length of 1 mod 4", "QUJDR"], ["a non-base64 character", "QUJD$A=="], ["unicode", "QUJDé==="],
    ["a data: prefix", "data:image/png;base64,QUJD"], ["only padding", "===="],
  ])("rejects %s", (_name, text) => {
    expect(decodeBase64(text)).toBeNull();
  });

  it("round-trips every byte value, and a 200 KiB random buffer, byte for byte", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(decodeBase64(Buffer.from(all).toString("base64"))).toEqual(all);
    const big = new Uint8Array(200 * 1024);
    for (let offset = 0; offset < big.length; offset += 65_536) crypto.getRandomValues(big.subarray(offset, offset + 65_536));
    const decoded = decodeBase64(Buffer.from(big).toString("base64"));
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(decoded!).equals(Buffer.from(big))).toBe(true);
  });

  it("returns a Uint8Array of exactly the decoded length, for every padding", () => {
    for (const length of [0, 1, 2, 3, 4, 5]) {
      const bytes = Uint8Array.from({ length }, (_, i) => 200 + i);
      const out = decodeBase64(Buffer.from(bytes).toString("base64"));
      expect(out).toBeInstanceOf(Uint8Array);
      expect(out!.length).toBe(length);
    }
  });

  it("derives the encoded cap from the byte cap", () => {
    expect(MAX_LOGO_BASE64).toBe(Buffer.from(new Uint8Array(204_800)).toString("base64").length);
  });
});

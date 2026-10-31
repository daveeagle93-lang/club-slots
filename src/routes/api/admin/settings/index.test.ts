import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../../../../server/env";
import { saveIcon, saveLogo } from "../../../../server/settings";
import { createTestEnv, type TestEnv } from "../../../../test/db";
import { makePng } from "../../../../test/images";
import { onRequestGet, onRequestPut } from "./index";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());
beforeEach(async () => {
  await t.env.DB.prepare("DELETE FROM site_logo").run();
  await t.env.DB.prepare("DELETE FROM site_icons").run();
  await t.env.DB.prepare("UPDATE site_settings SET club_name = '', privacy_contact_name = '', privacy_contact_email = '', website_url = '', theme_primary = NULL, theme_accent = NULL").run();
});

const call = <H extends typeof onRequestGet>(handler: H, init: RequestInit & { data?: unknown } = {}) => {
  const { data, ...rest } = init;
  return Promise.resolve(handler({
    request: new Request("http://localhost/api/admin/settings", rest), env: t.env as AppEnv, data: "data" in init ? data : ADMIN,
  } as never));
};
const put = (body: unknown, extra: { raw?: string; contentType?: string | null; data?: unknown } = {}) => {
  const headers: Record<string, string> = {};
  if (extra.contentType !== null) headers["Content-Type"] = extra.contentType ?? "application/json";
  return call(onRequestPut, { method: "PUT", headers, body: extra.raw ?? JSON.stringify(body), ...("data" in extra ? { data: extra.data } : {}) });
};
const stored = () => t.env.DB.prepare("SELECT club_name, privacy_contact_name, privacy_contact_email, website_url FROM site_settings").first();

const DEFAULT_THEME_INFO = { primary: "#0b5cad", accent: "#0b5cad", isDefault: true };
const good = { clubName: "Example Dog Club", privacyContact: { name: "Pat", email: "pat@example.org" }, website: "https://example.org/" };

describe("GET /api/admin/settings", () => {
  it("returns plain empty strings and no logo when nothing is set", async () => {
    const res = await call(onRequestGet);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ clubName: "", privacyContact: { name: "", email: "" }, website: "", logo: null, theme: DEFAULT_THEME_INFO, icons: null });
  });

  it("returns the settings and the logo's details", async () => {
    await put(good);
    const png = makePng(40, 30);
    const info = await saveLogo(t.env.DB, png, { type: "image/png", width: 40, height: 30 });
    expect(await (await call(onRequestGet)).json()).toEqual({
      ...good, logo: { url: `/api/logo?v=${info.sha256.slice(0, 16)}`, width: 40, height: 30, contentType: "image/png", bytes: png.length, sha256: info.sha256 },
      theme: DEFAULT_THEME_INFO, icons: null,
    });
  });

  it("returns what the stored icons were drawn from once all three sizes are stored, and never their bytes", async () => {
    const info = await saveLogo(t.env.DB, makePng(40, 30), { type: "image/png", width: 40, height: 30 });
    for (const size of [32, 180] as const) await saveIcon(t.env.DB, size, makePng(size, size), { background: "#0b5cad", logoSha256: info.sha256 });
    expect(((await (await call(onRequestGet)).json()) as { icons: unknown }).icons).toBeNull();
    await saveIcon(t.env.DB, 512, makePng(512, 512), { background: "#0b5cad", logoSha256: info.sha256 });
    const text = await (await call(onRequestGet)).text();
    expect((JSON.parse(text) as { icons: unknown }).icons).toEqual({ background: "#0b5cad", logoSha256: info.sha256 });
    expect(text.length).toBeLessThan(1000);
  });

  it("returns the saved theme, and the default again once it is reset", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = '#1b6b3a', theme_accent = '#a1235f'").run();
    expect(((await (await call(onRequestGet)).json()) as { theme: unknown }).theme).toEqual({ primary: "#1b6b3a", accent: "#a1235f", isDefault: false });
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = NULL, theme_accent = NULL").run();
    expect(((await (await call(onRequestGet)).json()) as { theme: unknown }).theme).toEqual(DEFAULT_THEME_INFO);
  });

  it("returns the default, not a stored theme that fails the contrast checks", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = '#0b5cad', theme_accent = '#ffd400'").run();
    expect(((await (await call(onRequestGet)).json()) as { theme: unknown }).theme).toEqual(DEFAULT_THEME_INFO);
  });

  it("refuses with 401 unless the guard set an admin identity", async () => {
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await call(onRequestGet, { data });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("PUT /api/admin/settings", () => {
  it("saves and returns the settings in the shape GET gives", async () => {
    const res = await put(good);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ...good, logo: null, theme: DEFAULT_THEME_INFO, icons: null });
    expect(await (await call(onRequestGet)).json()).toEqual({ ...good, logo: null, theme: DEFAULT_THEME_INFO, icons: null });
  });

  it("stores trimmed text and the normalised website", async () => {
    const res = await put({ clubName: "  Padded  ", privacyContact: { name: " ", email: " a@b.co " }, website: "HTTPS://Example.org" });
    expect(await res.json()).toEqual({ clubName: "Padded", privacyContact: { name: "", email: "a@b.co" }, website: "https://example.org/", logo: null, theme: DEFAULT_THEME_INFO, icons: null });
  });

  it("clears everything when sent empty strings (a full replacement)", async () => {
    await put(good);
    const res = await put({ clubName: "", privacyContact: { name: "", email: "" }, website: "" });
    expect(await res.json()).toEqual({ clubName: "", privacyContact: { name: "", email: "" }, website: "", logo: null, theme: DEFAULT_THEME_INFO, icons: null });
  });

  it("leaves the logo and the theme alone", async () => {
    await saveLogo(t.env.DB, makePng(4, 4), { type: "image/png", width: 4, height: 4 });
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = '#112233', theme_accent = '#445566'").run();
    const body = (await (await put(good)).json()) as { logo: unknown; theme: unknown };
    expect(body.logo).not.toBeNull();
    expect(body.theme).toEqual({ primary: "#112233", accent: "#445566", isDefault: false });
    expect((await t.env.DB.prepare("SELECT theme_primary FROM site_settings").first<{ theme_primary: string }>())!.theme_primary).toBe("#112233");
  });

  it("answers 400 with a message per bad field and saves nothing", async () => {
    await put(good);
    const res = await put({ clubName: "x".repeat(81), privacyContact: { name: "Pat", email: "" }, website: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { error: { code: string }; fields: Record<string, string> };
    expect(body.error.code).toBe("invalid_input");
    expect(Object.keys(body.fields).sort()).toEqual(["clubName", "privacyContact.email", "website"]);
    expect(await stored()).toEqual({ club_name: good.clubName, privacy_contact_name: "Pat", privacy_contact_email: "pat@example.org", website_url: good.website });
  });

  it("saves a changed email when the club name stored earlier has a joiner and is sent unchanged", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET club_name = ?").bind("Dog\u200D Club").run();
    const res = await put({ ...good, clubName: "Dog\u200D Club", privacyContact: { name: "Pat", email: "new@example.org" } });
    expect(res.status).toBe(200);
    expect(await stored()).toMatchObject({ club_name: "Dog\u200D Club", privacy_contact_email: "new@example.org" });
  });

  it("refuses a club name changed to a new value with a joiner, in plain words, saving nothing", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET club_name = ?").bind("Dog\u200D Club").run();
    const res = await put({ ...good, clubName: "Cat\u200D Club" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({
      clubName: "The club name can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.",
    });
    expect(await stored()).toMatchObject({ club_name: "Dog\u200D Club" });
  });

  it("requires all three parts: a partial update is refused and saves nothing", async () => {
    await put(good);
    for (const partial of [{ clubName: "New" }, { website: "https://new.example/" }, { privacyContact: { name: "", email: "" } }, {}]) {
      const res = await put(partial);
      expect(res.status, JSON.stringify(partial)).toBe(400);
    }
    expect(await stored()).toMatchObject({ club_name: good.clubName });
  });

  it("answers 415, 400 and 413 for bad bodies, saving nothing", async () => {
    expect((await put(good, { contentType: "text/plain" })).status).toBe(415);
    expect((await put(good, { contentType: null })).status).toBe(415);
    expect((await put(undefined, { raw: "{nope" })).status).toBe(400);
    expect((await put(undefined, { raw: "[1]" })).status).toBe(400);
    expect((await put({ ...good, padding: "x".repeat(40_000) })).status).toBe(413);
    expect(await stored()).toMatchObject({ club_name: "" });
  });

  it("refuses with 401 unless the guard set an admin identity, saving nothing", async () => {
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await put(good, { data });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await stored()).toMatchObject({ club_name: "" });
  });
});

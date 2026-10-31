import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../server/env";
import { saveLogo, saveSettings } from "../../server/settings";
import { createTestEnv, type TestEnv } from "../../test/db";
import { makePng } from "../../test/images";
import { onRequestGet } from "./settings";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());
beforeEach(async () => {
  await t.env.DB.prepare("DELETE FROM site_logo").run();
  await t.env.DB.prepare("UPDATE site_settings SET club_name = '', privacy_contact_name = '', privacy_contact_email = '', website_url = '', theme_primary = '#112233', theme_accent = '#445566'").run();
});

const get = () => Promise.resolve(onRequestGet({ request: new Request("http://localhost/api/settings"), env: t.env as AppEnv } as never));

describe("GET /api/settings", () => {
  it("answers with every key null when nothing is set", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clubName: null, website: null, privacyContact: null, logo: null });
  });

  it("is never cached, and carries the API headers", async () => {
    const res = await get();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("returns exactly the public keys, and nothing that is only for admins", async () => {
    await saveSettings(t.env.DB, { clubName: "Example Dog Club", privacyContact: { name: "Pat", email: "pat@example.org" }, website: "https://example.org/" });
    const logo = await saveLogo(t.env.DB, makePng(30, 20), { type: "image/png", width: 30, height: 20 });
    const body = (await (await get()).json()) as Record<string, any>;
    expect(Object.keys(body).sort()).toEqual(["clubName", "logo", "privacyContact", "website"]);
    expect(Object.keys(body.privacyContact).sort()).toEqual(["email", "name"]);
    expect(Object.keys(body.logo).sort()).toEqual(["height", "url", "width"]);
    expect(body).toEqual({
      clubName: "Example Dog Club", website: "https://example.org/", privacyContact: { name: "Pat", email: "pat@example.org" },
      logo: { url: `/api/logo?v=${logo.sha256.slice(0, 16)}`, width: 30, height: 20 },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(logo.sha256); // only the 16-character version, not the full digest
    expect(text).not.toMatch(/#112233|#445566|theme|updated|created|contentType|bytes|sha/i);
  });

  it("treats a contact name without an email as no contact, and empty text as null", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET privacy_contact_name = 'Pat'").run();
    expect(((await (await get()).json()) as { privacyContact: unknown }).privacyContact).toBeNull();
  });
});

describe("GET /api/settings when the database fails", () => {
  it("answers a clean JSON 500, logs only the message, and is never cached", async () => {
    const broken = { DB: { prepare: () => { throw new Error("D1 is down: SELECT secret FROM x"); } } };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await Promise.resolve(onRequestGet({ request: new Request("http://localhost/api/settings"), env: broken } as never));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: "internal_error", message: "Something went wrong. Please try again." } });
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0].every((a) => typeof a === "string")).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../server/env";
import { resetTheme, saveSettings, saveTheme } from "../../server/settings";
import { createTestEnv, type TestEnv } from "../../test/db";
import { onRequest } from "./manifest.webmanifest";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

const setName = (clubName: string) => saveSettings(t.env.DB, { clubName, privacyContact: { name: "", email: "" }, website: "" });
beforeEach(async () => {
  await setName("");
  await resetTheme(t.env.DB);
});

const call = (query = "", init: RequestInit = {}, env: Partial<AppEnv> = {}) =>
  Promise.resolve(onRequest({ request: new Request(`http://localhost/api/manifest.webmanifest${query}`, init), env: { DB: t.env.DB, ...env } } as never));
type Manifest = Record<string, any>;
const manifest = async (query = "") => (await (await call(query)).json()) as Manifest;

describe("GET /api/manifest.webmanifest", () => {
  it("is a minimal installable-app manifest for a club with nothing set", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    expect(await res.json()).toEqual({
      name: "Slot booker", short_name: "Slot booker", start_url: "/", scope: "/", display: "standalone",
      theme_color: "#0b5cad", background_color: "#ffffff",
      icons: [
        { src: "/api/icon/180", sizes: "180x180", type: "image/png" },
        { src: "/api/icon/512", sizes: "512x512", type: "image/png" },
      ],
    });
  });

  it("does not declare the icons maskable (they have only a small padding, not a safe zone)", async () => {
    expect(JSON.stringify(await manifest())).not.toMatch(/maskable|purpose/);
  });

  it("uses the club name, and the first 12 code points of it as the short name", async () => {
    await setName("Barkside Agility Club");
    expect(await manifest()).toMatchObject({ name: "Barkside Agility Club", short_name: "Barkside Agi" });
    await setName("Short");
    expect(await manifest()).toMatchObject({ name: "Short", short_name: "Short" });
    await setName("x".repeat(12));
    expect((await manifest()).short_name).toBe("x".repeat(12));
  });

  it("counts code points, not UTF-16 units, so an emoji is never split", async () => {
    await setName("😀".repeat(13));
    const m = await manifest();
    expect(m.short_name).toBe("😀".repeat(12));
    expect(m.short_name.isWellFormed()).toBe(true);
    expect(m.name).toBe("😀".repeat(13));
  });

  it("cuts the short name at 12 grapheme clusters, so a flag (two code points) stays whole", async () => {
    await setName("Dog Club 1 🇬🇧");
    const m = await manifest();
    expect(m.short_name).toBe("Dog Club 1 🇬🇧");
    expect(m.short_name.isWellFormed()).toBe(true);
    expect(m.name).toBe("Dog Club 1 🇬🇧");
  });

  it("cuts a long plain name at exactly 12 clusters, a letter with a combining accent counting as one", async () => {
    await setName("Hillside Dog Training Club");
    expect((await manifest()).short_name).toBe("Hillside Dog");
    await setName("e\u0301".repeat(13)); // e with a combining accent: one cluster, two code points
    expect((await manifest()).short_name).toBe("e\u0301".repeat(12));
  });

  it("carries a club name with quotes, backslashes, markup and non-ASCII exactly, as JSON", async () => {
    const name = `Dogs "R" Us \\ <b>&amp;</b> </script> é日本 ☃`;
    await setName(name);
    const res = await call();
    const text = await res.text();
    expect(JSON.parse(text).name).toBe(name);
    expect(text).toBe(JSON.stringify(JSON.parse(text)));
    expect(JSON.parse(text).short_name).toBe([...name].slice(0, 12).join(""));
  });

  it("uses the theme's main colour as theme_color, and the default when it is unset", async () => {
    expect((await manifest()).theme_color).toBe("#0b5cad");
    await saveTheme(t.env.DB, { primary: "#1b6b3a", accent: "#a1235f" });
    expect(await manifest()).toMatchObject({ theme_color: "#1b6b3a", background_color: "#ffffff" });
  });

  it("falls back to the default colour for a stored value that fails the theme checks", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = '#ffff00', theme_accent = '#ffff00'").run();
    expect((await manifest()).theme_color).toBe("#0b5cad");
  });

  describe("start_url", () => {
    it("is / normally and /admin/ only for exactly ?for=admin", async () => {
      expect((await manifest()).start_url).toBe("/");
      expect((await manifest("?for=admin")).start_url).toBe("/admin/");
    });

    it.each(["?for=Admin", "?for=admin&x=1", "?x=1&for=admin", "?for=", "?for", "?for=%61dmin", "?for=admin%20", "?for=other", "?for=/evil", "?for=https://evil.example", "?FOR=admin", "?", "?for=admin&for=admin", "?for[]=admin"])(
      "is / for %s", async (query) => {
        const m = await manifest(query);
        expect(m.start_url).toBe("/");
        expect(m.scope).toBe("/");
      },
    );

    it("never echoes the query", async () => {
      const res = await call("?for=%3Cscript%3E&reflected-marker=1");
      expect(JSON.stringify([...res.headers.entries()]) + (await res.text())).not.toMatch(/script|reflected-marker/);
    });
  });

  it("carries the defensive headers and a five-minute cache lifetime", async () => {
    const res = await call();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("answers HEAD with the headers and no body", async () => {
    const res = await call("", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    expect(await res.text()).toBe("");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("answers %s with 405 and an Allow header", async (method) => {
    const res = await call("", { method, body: method === "POST" || method === "PUT" || method === "PATCH" ? "x" : undefined });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("serves the defaults, not an error, and does not cache them when D1 fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("?for=admin", {}, { DB: { prepare: () => { throw new Error("SECRET sql text"); } } as unknown as D1Database });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    const m = (await res.json()) as Manifest;
    expect(m).toMatchObject({ name: "Slot booker", theme_color: "#0b5cad", start_url: "/admin/" });
    expect(JSON.stringify(m)).not.toMatch(/SECRET/);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

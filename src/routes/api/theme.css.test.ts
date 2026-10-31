import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME, themeCss } from "../../../public/theme.js";
import type { AppEnv } from "../../server/env";
import { createTestEnv, type TestEnv } from "../../test/db";
import { onRequest } from "./theme.css";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());
beforeEach(() => t.env.DB.prepare("UPDATE site_settings SET theme_primary = NULL, theme_accent = NULL").run());

const request = (query = "", init: RequestInit = {}, env: unknown = t.env) =>
  Promise.resolve(onRequest({ request: new Request(`http://localhost/api/theme.css${query}`, init), env } as never));
const setTheme = (primary: string, accent: string) =>
  t.env.DB.prepare("UPDATE site_settings SET theme_primary = ?, theme_accent = ?").bind(primary, accent).run();
const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// The same strict shape public/theme.test.ts holds themeCss to: nothing else may ever be served.
const SHAPE = new RegExp(
  "^:root\\{--primary:#[0-9a-f]{6};--on-primary:#[0-9a-f]{6};--accent:#[0-9a-f]{6}\\}" +
  "@media \\(prefers-color-scheme:dark\\)\\{:root\\{--primary:#[0-9a-f]{6};--on-primary:#[0-9a-f]{6};--accent:#[0-9a-f]{6}\\}\\}\\n$",
);

const DEFAULT_CSS =
  ":root{--primary:#0b5cad;--on-primary:#ffffff;--accent:#0b5cad}@media (prefers-color-scheme:dark){:root{--primary:#236cb5;--on-primary:#ffffff;--accent:#4f8ac4}}\n";
const GREEN_CSS =
  ":root{--primary:#1b6b3a;--on-primary:#ffffff;--accent:#a1235f}@media (prefers-color-scheme:dark){:root{--primary:#2d774a;--on-primary:#ffffff;--accent:#c16e95}}\n";

describe("GET /api/theme.css", () => {
  it("serves exactly the default colours when no theme is set", async () => {
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DEFAULT_CSS);
    expect(DEFAULT_CSS).toBe(themeCss(DEFAULT_THEME));
  });

  it("serves exactly the saved colours", async () => {
    await setTheme("#1b6b3a", "#a1235f");
    const css = await (await request()).text();
    expect(css).toBe(themeCss({ primary: "#1b6b3a", accent: "#a1235f" }));
    expect(css).toMatch(SHAPE);
    expect(css).toContain("--primary:#1b6b3a");
    expect(css).toContain("--accent:#a1235f");
    expect(css).not.toBe(DEFAULT_CSS);
  });

  it("sends the headers that make it a stylesheet and nothing else", async () => {
    const res = await request();
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");
  });

  it("has a strong ETag that is the SHA-256 of the body", async () => {
    for (const colours of [null, ["#1b6b3a", "#a1235f"]] as const) {
      if (colours) await setTheme(...colours);
      const res = await request();
      const etag = res.headers.get("etag")!;
      expect(etag).toBe(`"${await sha256(await res.text())}"`);
      expect(etag).not.toMatch(/^W\//);
    }
  });

  it("changes the ETag when the theme changes", async () => {
    const before = (await request()).headers.get("etag");
    await setTheme("#1b6b3a", "#a1235f");
    expect((await request()).headers.get("etag")).not.toBe(before);
  });

  it("ignores the query string, so ?v= only busts caches", async () => {
    await setTheme("#1b6b3a", "#a1235f");
    const plain = await request();
    for (const q of ["?v=123", "?v=%3C%2Fstyle%3E&primary=%23ff0000&accent=red", "?primary=%23ff0000"]) {
      const res = await request(q);
      expect(await res.text(), q).toBe(GREEN_CSS);
      expect(res.headers.get("etag"), q).toBe(plain.headers.get("etag"));
    }
  });

  describe("revalidation", () => {
    it("answers a matching If-None-Match with 304, no body and the same headers", async () => {
      const etag = (await request()).headers.get("etag")!;
      for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
        const res = await request("?v=1", { headers: { "If-None-Match": header } });
        expect(res.status, header).toBe(304);
        expect(await res.text()).toBe("");
        expect(res.headers.get("etag")).toBe(etag);
        expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      }
    });

    it("sends the stylesheet again for a different tag, and once the theme has changed", async () => {
      const etag = (await request()).headers.get("etag")!;
      expect((await request("", { headers: { "If-None-Match": '"nope"' } })).status).toBe(200);
      expect((await request("", { headers: { "If-None-Match": etag.slice(1, -1) } })).status).toBe(200); // unquoted is not a valid tag
      await setTheme("#1b6b3a", "#a1235f");
      const res = await request("", { headers: { "If-None-Match": etag } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(GREEN_CSS);
    });
  });

  it("answers HEAD with the headers and no body", async () => {
    const get = await request();
    const res = await request("", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(get.headers.get("etag"));
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await res.text()).toBe("");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("answers %s with 405 and an Allow header, changing nothing", async (method) => {
    await setTheme("#1b6b3a", "#a1235f");
    const res = await request("", { method, body: method === "POST" || method === "PUT" || method === "PATCH" ? "x" : undefined });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await t.env.DB.prepare("SELECT theme_primary FROM site_settings").first()).toEqual({ theme_primary: "#1b6b3a" });
  });

  describe("never serves anything that themeCss didn't produce", () => {
    // Values the CHECK forbids can only get in by bypassing it; ones it allows but the contrast rules refuse are plain updates.
    it.each([
      ["a pale accent", "#0b5cad", "#ffd400"],
      ["a primary that light button text misses", "#0077dd", "#0b5cad"],
    ])("falls back to the default for a poisoned-but-valid-hex row: %s", async (_name, primary, accent) => {
      await setTheme(primary, accent);
      const res = await request();
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(DEFAULT_CSS);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");
    });

    it("falls back to the default when the CHECK was bypassed with CSS", async () => {
      const injected = ["#fff;}body{display:none}", "url(//evil)", "expression(alert(1))", "</style><script>alert(1)</script>", "red", "#FFF"];
      try {
        await t.env.DB.prepare("PRAGMA ignore_check_constraints = ON").run();
        for (const value of injected) {
          for (const [p, a] of [[value, "#0b5cad"], ["#0b5cad", value]]) {
            await setTheme(p, a);
            const css = await (await request()).text();
            expect(css, value).toMatch(SHAPE);
            expect(css, value).not.toMatch(/evil|script|display|expression|red/);
            // Only the value that merely needs normalising ("#FFF" is a valid colour) may change the output.
            if (value !== "#FFF") expect(css, value).toBe(DEFAULT_CSS);
          }
        }
      } finally {
        await t.env.DB.prepare("PRAGMA ignore_check_constraints = OFF").run();
      }
    });

    it("always matches the strict shape, for a spread of saved themes", async () => {
      for (const c of ["#000000", "#ffffff", "#123456", "#1b6b3a", "#a1235f", "#0b5cad", "#3d4a5c", "#b4400f", "#0f6b6e", "#808080"]) {
        await setTheme(c, "#0b5cad");
        const css = await (await request()).text();
        expect(css, c).toMatch(SHAPE);
      }
    });
  });

  describe("when the database fails", () => {
    const failing = (message: string) => ({
      DB: { prepare: () => { throw new Error(message); } },
    });

    it("answers the default stylesheet, uncacheable, and logs the error", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await request("", {}, failing("D1_ERROR: boom"));
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(DEFAULT_CSS);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("etag")).toBeNull();
        expect(log).toHaveBeenCalledTimes(1);
        expect(String(log.mock.calls[0])).toContain("D1_ERROR: boom");
      } finally {
        log.mockRestore();
      }
    });

    it("does not answer 304 to a revalidation, and a rejected query does the same as a thrown one", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const rejecting = { DB: { prepare: () => ({ first: () => Promise.reject(new Error("later")) }) } };
        for (const env of [failing("now"), rejecting]) {
          const res = await request("", { headers: { "If-None-Match": "*" } }, env);
          expect(res.status).toBe(200);
          expect(await res.text()).toBe(DEFAULT_CSS);
          expect(res.headers.get("cache-control")).toBe("no-store");
        }
        const head = await request("", { method: "HEAD" }, failing("x"));
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
      } finally {
        log.mockRestore();
      }
    });
  });
});

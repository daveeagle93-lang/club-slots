import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../../server/env";
import { saveIcon, saveLogo } from "../../../server/settings";
import { publicAssets } from "../../../test/assets";
import { createTestEnv, type TestEnv } from "../../../test/db";
import { makePng, pngOfSize } from "../../../test/images";
import { onRequest } from "./[size]";

let t: TestEnv;
let logoSha: string;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());
beforeEach(async () => {
  await t.env.DB.prepare("DELETE FROM site_icons").run();
  logoSha = (await saveLogo(t.env.DB, makePng(10, 10), { type: "image/png", width: 10, height: 10 })).sha256;
});

const file = (name: string) => readFileSync(join(import.meta.dirname, "../../../../public/icons", name));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const call = (size: string, init: RequestInit = {}, env: Partial<AppEnv> = {}) =>
  Promise.resolve(onRequest({
    request: new Request(`http://localhost/api/icon/${size}`, init), params: { size }, env: { DB: t.env.DB, ASSETS: publicAssets(), ...env },
  } as never));
const store = (size: 32 | 180 | 512, bytes = pngOfSize(600, size, size)) =>
  saveIcon(t.env.DB, size, bytes, { background: "#0b5cad", logoSha256: logoSha }).then((s) => ({ bytes, sha256: s! }));

describe("GET /api/icon/[size]: a stored icon", () => {
  it.each([32, 180, 512] as const)("serves the stored %i px PNG: exact bytes, type, length and ETag", async (size) => {
    const stored = await store(size);
    const res = await call(String(size));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(stored.bytes.length));
    expect(res.headers.get("etag")).toBe(`"${stored.sha256}"`);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(stored.bytes))).toBe(true);
  });

  it("sends the headers that stop it being sniffed, framed or run as a page, and a five-minute cache lifetime", async () => {
    await store(32);
    const res = await call("32");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("never reflects the query string, and ignores what the request says it accepts", async () => {
    await store(32);
    const res = await call("32", { headers: { Accept: "text/html" } });
    expect(res.headers.get("content-type")).toBe("image/png");
    const q = await Promise.resolve(onRequest({
      request: new Request("http://localhost/api/icon/32?x=reflected-marker&type=text/html"), params: { size: "32" }, env: { DB: t.env.DB, ASSETS: publicAssets() },
    } as never));
    expect(JSON.stringify([...q.headers.entries()])).not.toMatch(/reflected-marker/);
  });

  it("answers a matching If-None-Match with 304, an empty body and the same headers, without reading the image", async () => {
    const { sha256 } = await store(180);
    const sql: string[] = [];
    const spy = { prepare: (q: string) => { sql.push(q); return t.env.DB.prepare(q); } } as unknown as D1Database;
    for (const header of [`"${sha256}"`, `W/"${sha256}"`, `"other", "${sha256}"`, "*"]) {
      const res = await call("180", { headers: { "If-None-Match": header } }, { DB: spy });
      expect(res.status, header).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("etag")).toBe(`"${sha256}"`);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    for (const q of sql) expect(q.replace(/length\(bytes\)( AS bytes)?/g, "")).not.toMatch(/\bbytes\b/);
  });

  it("sends the icon again for a different tag, and after the icon changes", async () => {
    const { sha256 } = await store(32);
    expect((await call("32", { headers: { "If-None-Match": '"nope"' } })).status).toBe(200);
    expect((await call("32", { headers: { "If-None-Match": sha256 } })).status).toBe(200); // unquoted is not a valid tag
    await store(32, pngOfSize(700, 32, 32));
    expect((await call("32", { headers: { "If-None-Match": `"${sha256}"` } })).status).toBe(200);
  });

  it("builds the tag and length of a non-matching conditional GET from the read that supplied the bytes", async () => {
    const first = await store(32);
    const second = pngOfSize(700, 32, 32);
    // The icon is replaced right after the metadata read, so the body read finds a different row.
    const db = {
      prepare: (q: string) => {
        const statement = t.env.DB.prepare(q);
        if (!/length\(bytes\) AS bytes FROM/.test(q)) return statement;
        return { bind: (...values: unknown[]) => ({ first: async () => { const row = await statement.bind(...values).first(); await store(32, second); return row; } }) };
      },
    } as unknown as D1Database;
    const res = await call("32", { headers: { "If-None-Match": '"nope"' } }, { DB: db });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(Buffer.from(second))).toBe(true);
    expect(res.headers.get("etag")).toBe(`"${sha(second)}"`);
    expect(res.headers.get("etag")).not.toBe(`"${first.sha256}"`);
    expect(res.headers.get("content-length")).toBe(String(second.length));
  });

  it("answers HEAD with the GET's headers and no body, from the metadata row", async () => {
    const stored = await store(512);
    const sql: string[] = [];
    const spy = { prepare: (q: string) => { sql.push(q); return t.env.DB.prepare(q); } } as unknown as D1Database;
    const head = await call("512", { method: "HEAD" }, { DB: spy });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(stored.bytes.length));
    for (const q of sql) expect(q.replace(/length\(bytes\)( AS bytes)?/g, "")).not.toMatch(/\bbytes\b/);
    const get = await call("512");
    expect([...head.headers.entries()].sort()).toEqual([...get.headers.entries()].sort());
  });
});

describe("GET /api/icon/[size]: no stored icon", () => {
  it.each([32, 180, 512])("serves the bundled default %i px icon, never a 404", async (size) => {
    const assets = publicAssets();
    const res = await call(String(size), {}, { ASSETS: assets });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    const want = file(`default-${size}.png`);
    expect(Buffer.from(await res.arrayBuffer()).equals(want)).toBe(true);
    expect(res.headers.get("content-length")).toBe(String(want.length));
    expect(res.headers.get("etag")).toBe(`"${sha(want)}"`);
    expect(assets.requested).toEqual([`/icons/default-${size}.png`]);
  });

  it("serves the defaults when only some sizes are stored, per size", async () => {
    const stored = await store(32);
    expect(Buffer.from(await (await call("32")).arrayBuffer()).equals(Buffer.from(stored.bytes))).toBe(true);
    expect(Buffer.from(await (await call("180")).arrayBuffer()).equals(file("default-180.png"))).toBe(true);
  });

  it("answers HEAD and a matching If-None-Match for the default too", async () => {
    const head = await call("32", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(file("default-32.png").length));
    const res = await call("32", { headers: { "If-None-Match": `"${sha(file("default-32.png"))}"` } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("serves the default for a logo-less site, and after the logo (and so the icons) are gone", async () => {
    await store(32);
    await t.env.DB.prepare("DELETE FROM site_logo").run();
    await t.env.DB.prepare("DELETE FROM site_icons").run();
    expect(Buffer.from(await (await call("32")).arrayBuffer()).equals(file("default-32.png"))).toBe(true);
  });

  it("answers the default, not an error, and does not cache it when D1 fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { prepare: () => { throw new Error("SECRET sql text"); } } as unknown as D1Database;
    for (const init of [{}, { method: "HEAD" }, { headers: { "If-None-Match": '"x"' } }]) {
      const res = await call("180", init, { DB: broken });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toBe("image/png");
      if (!("method" in init)) expect(Buffer.from(await res.arrayBuffer()).equals(file("default-180.png"))).toBe(true);
    }
    const rejecting = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error("SECRET")) }), first: () => Promise.reject(new Error("SECRET")) }) } as unknown as D1Database;
    expect((await call("32", {}, { DB: rejecting })).headers.get("cache-control")).toBe("no-store");
    expect(error).toHaveBeenCalled(); // the failure is logged (message only), not shown
    error.mockRestore();
  });

  it("answers 503, uncached and in JSON, only if the default itself can't be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = { fetch: async () => new Response("<!doctype html><script>alert(1)</script>", { headers: { "Content-Type": "text/html" } }) };
    const missing = { fetch: async () => new Response("nope", { status: 404 }) };
    const throwing = { fetch: async () => { throw new Error("no assets"); } };
    for (const ASSETS of [html, missing, throwing, undefined]) {
      const res = await call("32", {}, { ASSETS: ASSETS as Fetcher | undefined });
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: { code: "icon_unavailable" } });
    }
    error.mockRestore();
  });
});

describe("GET /api/icon/[size]: other sizes and methods", () => {
  it.each(["16", "64", "192", "0", "033", "32.0", " 32", "+32", "0x20", "abc", "", "-32", "1e9", "32%2F", "512x512"])("answers 404 for %j, and never looks at the database", async (size) => {
    const sql = vi.fn();
    const res = await call(size, {}, { DB: { prepare: sql } as unknown as D1Database });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    expect(sql).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("answers %s with 405 and an Allow header, changing nothing", async (method) => {
    await store(32);
    const res = await call("32", { method, body: method === "GET" ? undefined : method === "OPTIONS" || method === "DELETE" ? undefined : "x" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM site_icons").first<{ n: number }>())!.n).toBe(1);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../../server/env";
import { deleteLogo, saveLogo } from "../../server/settings";
import { createTestEnv, type TestEnv } from "../../test/db";
import { makeJpeg, makePng, webpLossless } from "../../test/images";
import { onRequest } from "./logo";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());
beforeEach(() => deleteLogo(t.env.DB));

const request = (query = "", init: RequestInit = {}) =>
  Promise.resolve(onRequest({ request: new Request(`http://localhost/api/logo${query}`, init), env: t.env as AppEnv } as never));

const FILES = [
  ["image/png", makePng(30, 20), { width: 30, height: 20 }],
  ["image/jpeg", makeJpeg(30, 20), { width: 30, height: 20 }],
  ["image/webp", webpLossless(30, 20), { width: 30, height: 20 }],
] as const;

describe("GET /api/logo", () => {
  it.each(FILES)("serves a stored %s with the stored type, the exact bytes and a correct length", async (type, data, size) => {
    const info = await saveLogo(t.env.DB, data, { type, ...size });
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("content-length")).toBe(String(data.length));
    expect(res.headers.get("etag")).toBe(`"${info.sha256}"`);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(body).equals(Buffer.from(data))).toBe(true);
  });

  it("sends the headers that stop it being sniffed, framed or run as a page", async () => {
    await saveLogo(t.env.DB, makePng(4, 4), { type: "image/png", width: 4, height: 4 });
    const res = await request();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("serves the stored type even when the bytes aren't what that type claims (nothing is re-derived from the request)", async () => {
    await saveLogo(t.env.DB, makePng(4, 4), { type: "image/png", width: 4, height: 4 });
    const res = await request("?type=text/html&content-type=text/html", { headers: { Accept: "text/html", "Content-Type": "text/html" } });
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  describe("caching", () => {
    let sha: string;
    beforeEach(async () => {
      sha = (await saveLogo(t.env.DB, makePng(4, 4), { type: "image/png", width: 4, height: 4 })).sha256;
    });

    it("is cacheable for a year, immutable, when v is the current version", async () => {
      expect((await request(`?v=${sha.slice(0, 16)}`)).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    });

    it.each([["no v", ""], ["a stale v", "?v=0000000000000000"], ["garbage", "?v=%3Cscript%3E"], ["an empty v", "?v="], ["the full digest", "?v=SHA"],
      ["a prefix", "?v=ab"], ["the right version plus more", "?v=SHA16x"], ["a repeated v with the wrong one first", "?v=bad&v=SHA16"],
    ])("is cached for five minutes only with %s", async (_name, query) => {
      const res = await request(query.replace("SHA16", sha.slice(0, 16)).replace("SHA", sha));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    });

    it("never reflects a query parameter into the response", async () => {
      const res = await request("?v=%3Cscript%3Ealert(1)%3C%2Fscript%3E&x=reflected-marker");
      const everything = JSON.stringify([...res.headers.entries()]) + (await res.text());
      expect(everything).not.toMatch(/script|reflected-marker/);
    });

    it("answers a matching If-None-Match with 304, an empty body and the cache headers", async () => {
      for (const header of [`"${sha}"`, `W/"${sha}"`, `"other", "${sha}"`, "*"]) {
        const res = await request(`?v=${sha.slice(0, 16)}`, { headers: { "If-None-Match": header } });
        expect(res.status, header).toBe(304);
        expect(await res.text()).toBe("");
        expect(res.headers.get("etag")).toBe(`"${sha}"`);
        expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      }
    });

    it("sends the image again for a different tag, and after the logo changes", async () => {
      expect((await request("", { headers: { "If-None-Match": '"nope"' } })).status).toBe(200);
      expect((await request("", { headers: { "If-None-Match": sha } })).status).toBe(200); // unquoted is not a valid tag
      await saveLogo(t.env.DB, makePng(5, 5), { type: "image/png", width: 5, height: 5 });
      const res = await request(`?v=${sha.slice(0, 16)}`, { headers: { "If-None-Match": `"${sha}"` } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300"); // the old version is stale now
    });
  });

  it("answers HEAD with the headers and no body", async () => {
    const data = makePng(4, 4);
    const info = await saveLogo(t.env.DB, data, { type: "image/png", width: 4, height: 4 });
    const res = await request("", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(data.length));
    expect(res.headers.get("etag")).toBe(`"${info.sha256}"`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await res.text()).toBe("");
    // Same headers as the GET, so a HEAD tells a client exactly what a GET would.
    const get = await request();
    expect([...res.headers.entries()].sort()).toEqual([...get.headers.entries()].sort());
  });

  it("answers HEAD from the metadata row, without reading the image bytes", async () => {
    await saveLogo(t.env.DB, makePng(4, 4), { type: "image/png", width: 4, height: 4 });
    const sql: string[] = [];
    const spy = { DB: { prepare: (q: string) => { sql.push(q); return t.env.DB.prepare(q); } } };
    const res = await Promise.resolve(onRequest({ request: new Request("http://localhost/api/logo", { method: "HEAD" }), env: spy } as never));
    expect(res.status).toBe(200);
    expect(sql.length).toBeGreaterThan(0);
    // length(bytes) is fine; selecting the column itself is not.
    for (const q of sql) expect(q.replace(/length\(bytes\)/g, "")).not.toMatch(/\bbytes\b/);
  });

  it("answers 404 JSON, cached for five minutes, when there is no logo", async () => {
    for (const init of [{}, { headers: { "If-None-Match": "*" } }, { method: "HEAD" }]) {
      const res = await request("?v=abc", init);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      if (init.method !== "HEAD") expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("answers %s with 405 and an Allow header, changing nothing", async (method) => {
    await saveLogo(t.env.DB, makePng(4, 4), { type: "image/png", width: 4, height: 4 });
    const res = await request("", { method, body: method === "POST" || method === "PUT" || method === "PATCH" ? "x" : undefined });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM site_logo").first<{ n: number }>())!.n).toBe(1);
  });
});

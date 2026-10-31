import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../server/env";
import { saveIcon, saveLogo } from "../server/settings";
import { publicAssets } from "../test/assets";
import { createTestEnv, type TestEnv } from "../test/db";
import { makePng, pngOfSize } from "../test/images";
import { onRequest } from "./favicon.ico";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

const call = (init: RequestInit = {}) =>
  Promise.resolve(onRequest({ request: new Request("http://localhost/favicon.ico", init), env: { DB: t.env.DB, ASSETS: publicAssets() } as AppEnv } as never));

describe("/favicon.ico", () => {
  it("is not a static file, which would be served instead of the function", () => {
    expect(existsSync(join(import.meta.dirname, "../../public/favicon.ico"))).toBe(false);
  });

  it("serves the default 32 px icon when none is stored", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(import.meta.dirname, "../../public/icons/default-32.png")))).toBe(true);
  });

  it("serves the stored 32 px icon, with the same headers as /api/icon/32", async () => {
    const sha = (await saveLogo(t.env.DB, makePng(10, 10), { type: "image/png", width: 10, height: 10 })).sha256;
    const bytes = pngOfSize(700, 32, 32);
    const etag = await saveIcon(t.env.DB, 32, bytes, { background: "#0b5cad", logoSha256: sha });
    const res = await call();
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(res.headers.get("etag")).toBe(`"${etag}"`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await call({ headers: { "If-None-Match": `"${etag}"` } })).status).toBe(304);
    expect((await call({ method: "HEAD" })).status).toBe(200);
  });

  it("answers other methods with 405", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) expect((await call({ method })).status).toBe(405);
  });
});

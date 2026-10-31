import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../../../../../server/env";
import { deleteLogo, DEFAULT_MARK_SOURCE, resetTheme, saveLogo, saveTheme } from "../../../../../server/settings";
import { createTestEnv, type TestEnv } from "../../../../../test/db";
import {
  makeApng, makeJpeg, makePng, pngOfSize, toBase64, webpLossless, withTrailing,
} from "../../../../../test/images";
import { onRequestPut } from "./[size]";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };
const DEFAULT_BG = "#0b5cad";

let t: TestEnv;
let logoSha: string;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());
beforeEach(async () => {
  await resetTheme(t.env.DB);
  await t.env.DB.prepare("DELETE FROM site_icons").run();
  logoSha = (await saveLogo(t.env.DB, makePng(10, 10), { type: "image/png", width: 10, height: 10 })).sha256;
});

interface Options { env?: unknown; contentType?: string | null; raw?: string; data?: unknown; headers?: Record<string, string>; body?: BodyInit; duplex?: boolean; params?: Record<string, string> }

const put = (size: string | number, body: unknown, o: Options = {}): Promise<Response> => {
  const headers: Record<string, string> = { ...o.headers };
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  const init: RequestInit & { duplex?: string } = { method: "PUT", headers, body: o.body ?? o.raw ?? JSON.stringify(body) };
  if (o.duplex) init.duplex = "half";
  return Promise.resolve(onRequestPut({
    request: new Request(`http://localhost/api/admin/settings/icons/${size}`, init),
    env: (o.env ?? t.env) as AppEnv, params: o.params ?? { size: String(size) }, data: "data" in o ? o.data : ADMIN,
  } as never));
};
/** The body the browser sends, with each part overridable. */
const send = (size: number, png: Uint8Array, extra: Record<string, unknown> = {}, o: Options = {}) =>
  put(size, { data: toBase64(png), background: DEFAULT_BG, logoSha256: logoSha, ...extra }, o);

const unreadable = (onPull: () => void) =>
  new ReadableStream<Uint8Array>({ pull(controller) { onPull(); controller.error(new Error("body was read")); } }, { highWaterMark: 0 });

const iconRows = async () => (await t.env.DB.prepare("SELECT size, sha256, background, logo_sha256 FROM site_icons ORDER BY size").all()).results;
type ErrorBody = { error: { code: string; message: string }; reason?: string; fields?: Record<string, string> };
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("PUT /api/admin/settings/icons/[size]: the happy path", () => {
  it.each([32, 180, 512])("stores a %i px PNG and returns what was stored, never the bytes", async (size) => {
    const png = makePng(size, size);
    const res = await send(size, png);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const sha = createHash("sha256").update(png).digest("hex");
    expect(await res.json()).toEqual({ icon: { size, sha256: sha, bytes: png.length, background: DEFAULT_BG, logoSha256: logoSha } });
    const row = await t.env.DB.prepare("SELECT bytes, content_type, width, height FROM site_icons WHERE size = ?").bind(size).first<{ bytes: number[]; content_type: string; width: number; height: number }>();
    expect(Buffer.from(row!.bytes).equals(Buffer.from(png))).toBe(true);
    expect(row).toMatchObject({ content_type: "image/png", width: size, height: size });
  });

  it("replaces an icon in place, one row per size", async () => {
    expect((await send(32, makePng(32, 32))).status).toBe(200);
    expect((await send(32, pngOfSize(500, 32, 32))).status).toBe(200);
    expect(await iconRows()).toHaveLength(1);
  });

  it("takes the size from the URL parameter and ignores the body's idea of it", async () => {
    const res = await send(180, makePng(180, 180), { size: 32, width: 32 });
    expect(res.status).toBe(200);
    expect((await iconRows()).map((r) => r.size)).toEqual([180]);
  });

  it("accepts the background of a saved theme, and only that one", async () => {
    await saveTheme(t.env.DB, { primary: "#1b6b3a", accent: "#1b6b3a" });
    expect((await send(32, makePng(32, 32), { background: "#1b6b3a" })).status).toBe(200);
    const stale = await send(32, makePng(32, 32), { background: DEFAULT_BG });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as ErrorBody).error.code).toBe("stale_theme");
  });

  it("trusts nothing the client says about the file's type", async () => {
    const res = await send(32, makePng(32, 32), { contentType: "image/svg+xml", type: "text/html", filename: "x.svg" }, { headers: { "X-Content-Type": "text/html" } });
    expect(res.status).toBe(200);
    expect((await t.env.DB.prepare("SELECT content_type FROM site_icons").first<{ content_type: string }>())!.content_type).toBe("image/png");
  });
});

describe("PUT /api/admin/settings/icons/[size]: the size", () => {
  it.each(["16", "64", "192", "0", "033", "32.0", " 32", "32 ", "+32", "0x20", "abc", "", "-32", "3e1", "512x512", "1e9"])("refuses the size %j with 404, reading nothing", async (size) => {
    let pulls = 0;
    const res = await put(size, undefined, { body: unreadable(() => pulls++), duplex: true, params: { size } });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
    expect(pulls).toBe(0);
    expect(await iconRows()).toEqual([]);
  });

  it("is a 404 when there is no size parameter at all", async () => {
    expect((await put(32, {}, { params: {} })).status).toBe(404);
  });
});

describe("PUT /api/admin/settings/icons/[size]: what must match", () => {
  it("refuses with 409 stale_logo when there is no logo", async () => {
    await deleteLogo(t.env.DB);
    const res = await send(32, makePng(32, 32));
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("stale_logo");
    expect(await iconRows()).toEqual([]);
  });

  it("refuses with 409 stale_logo when there is no logo and the digest is a real logo's, not the default mark's", async () => {
    await deleteLogo(t.env.DB);
    for (const logoSha256 of ["a".repeat(64), logoSha]) {
      const res = await send(32, makePng(32, 32), { logoSha256 });
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe("stale_logo");
    }
    expect(await iconRows()).toEqual([]);
  });

  it("refuses with 409 stale_logo when the digest is not the stored logo's", async () => {
    const res = await send(32, makePng(32, 32), { logoSha256: "f".repeat(64) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("stale_logo");
    expect(await iconRows()).toEqual([]);
  });

  describe("the default mark's source id", () => {
    it("is accepted while there is no logo, and stored as the icon's source", async () => {
      await deleteLogo(t.env.DB);
      const res = await send(32, makePng(32, 32), { logoSha256: DEFAULT_MARK_SOURCE });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { icon: { logoSha256: string } }).icon.logoSha256).toBe(DEFAULT_MARK_SOURCE);
      expect((await iconRows()).map((r) => [r.size, r.logo_sha256])).toEqual([[32, DEFAULT_MARK_SOURCE]]);
    });

    it("is accepted on the stored colour only", async () => {
      await deleteLogo(t.env.DB);
      await saveTheme(t.env.DB, { primary: "#1b6b3a", accent: "#1b6b3a" });
      const stale = await send(32, makePng(32, 32), { logoSha256: DEFAULT_MARK_SOURCE });
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as ErrorBody).error.code).toBe("stale_theme");
      expect((await send(32, makePng(32, 32), { logoSha256: DEFAULT_MARK_SOURCE, background: "#1b6b3a" })).status).toBe(200);
    });

    it("is refused with 409 stale_logo, like any other wrong digest, while a logo is stored", async () => {
      const res = await send(32, makePng(32, 32), { logoSha256: DEFAULT_MARK_SOURCE });
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe("stale_logo");
      expect(await iconRows()).toEqual([]);
    });
  });

  it("refuses with 409 stale_logo when the logo was replaced after the icon was drawn", async () => {
    await saveLogo(t.env.DB, makePng(11, 11), { type: "image/png", width: 11, height: 11 });
    const res = await send(32, makePng(32, 32));
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("stale_logo");
  });

  describe("a change between the checks and the write", () => {
    /** The same database, except that `change` runs just before the icon's INSERT: the moment between the reads and the write. */
    const changingBefore = (change: () => Promise<unknown>) => {
      const db = {
        prepare: (sql: string) => {
          const statement = t.env.DB.prepare(sql);
          if (!sql.includes("INSERT INTO site_icons")) return statement;
          return { bind: (...values: unknown[]) => ({ run: async () => { await change(); return statement.bind(...values).run(); } }) };
        },
      };
      return { env: { ...t.env, DB: db } };
    };

    it("refuses with 409 stale_theme when the main colour changed, and stores nothing", async () => {
      const o = changingBefore(() => t.env.DB.prepare("UPDATE site_settings SET theme_primary = '#1b6b3a', theme_accent = '#a1235f'").run());
      const res = await send(32, makePng(32, 32), {}, o);
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe("stale_theme");
      expect(await iconRows()).toEqual([]);
    });

    it("refuses with 409 stale_logo when the logo changed, and stores nothing", async () => {
      const o = changingBefore(() => saveLogo(t.env.DB, makePng(11, 11), { type: "image/png", width: 11, height: 11 }));
      const res = await send(32, makePng(32, 32), {}, o);
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe("stale_logo");
      expect(await iconRows()).toEqual([]);
    });

    it("refuses a default-mark icon with 409 stale_logo when a logo was uploaded after the checks, and stores nothing", async () => {
      await deleteLogo(t.env.DB);
      const o = changingBefore(() => saveLogo(t.env.DB, makePng(11, 11), { type: "image/png", width: 11, height: 11 }));
      const res = await send(32, makePng(32, 32), { logoSha256: DEFAULT_MARK_SOURCE }, o);
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe("stale_logo");
      expect(await iconRows()).toEqual([]);
    });

    it("refuses a logo's icon with 409 stale_logo when the logo was removed after the checks, and stores nothing", async () => {
      const o = changingBefore(() => deleteLogo(t.env.DB));
      const res = await send(32, makePng(32, 32), {}, o);
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe("stale_logo");
      expect(await iconRows()).toEqual([]);
    });
  });

  it("refuses a malformed background or digest with 400 on that field", async () => {
    const bad: [string, unknown][] = [
      ["background", "#0B5CAD"], ["background", "#fff"], ["background", "0b5cad"], ["background", "red"], ["background", ""],
      ["background", " #0b5cad"], ["background", "#0b5cad\n"], ["background", null], ["background", 5], ["background", ["#0b5cad"]],
      ["logoSha256", logoSha.toUpperCase()], ["logoSha256", logoSha.slice(1)], ["logoSha256", `${logoSha}0`], ["logoSha256", ""],
      ["logoSha256", null], ["logoSha256", 5], ["logoSha256", `${logoSha.slice(0, 63)}g`], ["logoSha256", `${logoSha}\n`],
    ];
    for (const [field, value] of bad) {
      const res = await send(32, makePng(32, 32), { [field]: value });
      expect(res.status, `${field}=${JSON.stringify(value)}`).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("invalid_input");
      expect(Object.keys(body.fields!)).toEqual([field]);
    }
    expect(await iconRows()).toEqual([]);
  });

  it("refuses a body without a data string, with 400", async () => {
    for (const data of [undefined, null, 5, true, [], ["AAAA"], {}]) {
      const res = await put(32, { data, background: DEFAULT_BG, logoSha256: logoSha });
      expect(res.status, JSON.stringify(data)).toBe(400);
      expect(Object.keys(((await res.json()) as ErrorBody).fields!)).toEqual(["data"]);
    }
  });
});

describe("PUT /api/admin/settings/icons/[size]: refused images", () => {
  const refusals: [string, number, Uint8Array, string][] = [
    ["a JPEG renamed as an icon", 32, makeJpeg(32, 32), "unsupported_type"],
    ["a WebP", 32, webpLossless(32, 32), "unsupported_type"],
    ["an SVG", 32, text('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><script>alert(1)</script></svg>'), "unsupported_type"],
    ["an HTML page", 180, text("<!doctype html><script>alert(1)</script>"), "unsupported_type"],
    ["an empty file", 32, new Uint8Array(0), "empty"],
    ["a PNG of the wrong size for the URL", 32, makePng(180, 180), "dimensions"],
    ["a 32 px PNG sent to 512", 512, makePng(32, 32), "dimensions"],
    ["a PNG one pixel too narrow", 180, makePng(179, 180), "dimensions"],
    ["a PNG one pixel too tall", 180, makePng(180, 181), "dimensions"],
    ["a non-square PNG", 32, makePng(32, 16), "dimensions"],
    ["a PNG too big for any logo", 32, makePng(20000, 20000, false), "dimensions"],
    ["a PNG with a byte after IEND", 32, withTrailing(makePng(32, 32), 0), "corrupt"],
    ["a PNG with a script after IEND", 180, withTrailing(makePng(180, 180), ...text("<script>alert(1)</script>")), "corrupt"],
    ["a truncated PNG", 32, makePng(32, 32).subarray(0, 40), "corrupt"],
    ["an animated PNG", 32, makeApng(32, 32), "corrupt"],
  ];

  it.each(refusals)("refuses %s with 422 and says why", async (_name, size, bytes, reason) => {
    const res = await send(size, bytes);
    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("invalid_image");
    expect(body.reason).toBe(reason);
    expect(body.error.message.length).toBeGreaterThan(10);
    expect(await iconRows()).toEqual([]);
  });

  it("leaves an earlier icon untouched when a later one is refused", async () => {
    await send(32, makePng(32, 32));
    const before = await iconRows();
    expect((await send(32, withTrailing(makePng(32, 32), 0))).status).toBe(422);
    expect(await iconRows()).toEqual(before);
  });
});

describe("PUT /api/admin/settings/icons/[size]: size caps", () => {
  it.each([[32, 16 * 1024], [180, 96 * 1024], [512, 200 * 1024]])("takes a %i px PNG of exactly the cap (%i bytes) and refuses one more byte", async (size, cap) => {
    const ok = await send(size, pngOfSize(cap, size, size));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { icon: { bytes: number } }).icon.bytes).toBe(cap);
    const before = await iconRows();
    const over = await send(size, pngOfSize(cap + 1, size, size));
    expect(over.status).toBe(413);
    expect(((await over.json()) as ErrorBody).error.code).toBe("too_large");
    expect(await iconRows()).toEqual(before);
  });

  it("refuses base64 that is already too long for the size before decoding it", async () => {
    // 16 KiB needs 21,848 characters of base64; this is not even base64 and is refused on length first.
    const res = await put(32, { data: "!".repeat(21_852), background: DEFAULT_BG, logoSha256: logoSha });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ErrorBody).error.code).toBe("too_large");
  });
});

describe("PUT /api/admin/settings/icons/[size]: the request", () => {
  const BAD_BASE64: [string, string][] = [
    ["whitespace", `${toBase64(makePng(32, 32)).slice(0, 8)} ${toBase64(makePng(32, 32)).slice(8)}`],
    ["a newline", `${toBase64(makePng(32, 32))}\n`],
    ["the URL-safe alphabet", toBase64(Uint8Array.of(251, 255, 254, 251)).replace(/\+/g, "-").replace(/\//g, "_")],
    ["missing padding", "AQIDBA"],
    ["a data: URL", `data:image/png;base64,${toBase64(makePng(32, 32))}`],
    ["bad characters", "!!!!"],
  ];

  it.each(BAD_BASE64)("refuses base64 with %s with 400 on the data field", async (_name, data) => {
    const res = await put(32, { data, background: DEFAULT_BG, logoSha256: logoSha });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("invalid_input");
    expect(Object.keys(body.fields!)).toEqual(["data"]);
    expect(await iconRows()).toEqual([]);
  });

  it("refuses anything but JSON with 415, even a real image", async () => {
    for (const contentType of ["text/plain", "image/png", "application/octet-stream", "multipart/form-data; boundary=x", null]) {
      expect((await send(32, makePng(32, 32), {}, { contentType })).status, String(contentType)).toBe(415);
    }
    expect((await put(32, undefined, { contentType: "image/png", body: makePng(32, 32) })).status).toBe(415);
    expect(await iconRows()).toEqual([]);
  });

  it("refuses malformed JSON and non-objects with 400", async () => {
    for (const raw of ["{nope", "[1]", "", "null", "5"]) expect((await put(32, undefined, { raw })).status, raw).toBe(400);
    expect(await iconRows()).toEqual([]);
  });

  it("refuses a body over the limit with 413 too_large", async () => {
    const res = await put(32, undefined, { raw: JSON.stringify({ data: "A".repeat(300_000) }) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ErrorBody).error.code).toBe("too_large");
  });

  it("stops reading a body that never ends, instead of buffering it", async () => {
    let pulls = 0;
    const chunk = new TextEncoder().encode("A".repeat(50_000));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 40) controller.error(new Error("the handler kept reading an oversized body"));
        else controller.enqueue(chunk);
      },
    });
    const res = await put(32, undefined, { body: endless, duplex: true });
    expect(res.status).toBe(413);
    expect(pulls).toBeLessThan(10);
  });

  it("refuses an oversized Content-Length without reading the body at all", async () => {
    let pulls = 0;
    const res = await put(512, undefined, { body: unreadable(() => pulls++), duplex: true, headers: { "Content-Length": "5000000" } });
    expect(res.status).toBe(413);
    expect(pulls).toBe(0);
  });

  it("refuses with 401 unless the guard set an admin identity, reading and storing nothing", async () => {
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      let pulls = 0;
      const res = await put(32, undefined, { body: unreadable(() => pulls++), duplex: true, data });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(pulls).toBe(0);
      expect((await send(32, makePng(32, 32), {}, { data })).status).toBe(401);
    }
    expect(await iconRows()).toEqual([]);
  });

  it("answers 500 without leaking the error when the database fails", async () => {
    const res = await Promise.resolve(onRequestPut({
      request: new Request("http://localhost/api/admin/settings/icons/32", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: toBase64(makePng(32, 32)), background: DEFAULT_BG, logoSha256: logoSha }),
      }),
      env: { DB: { prepare: () => { throw new Error("SECRET sql text"); } } }, params: { size: "32" }, data: ADMIN,
    } as never));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/SECRET/);
  });
});

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../../../../server/env";
import { saveIcon, saveLogo } from "../../../../server/settings";
import { createTestEnv, type TestEnv } from "../../../../test/db";
import {
  makeJpeg, makePng, PNG_SIGNATURE, pngOfSize, toBase64, webpExtended, webpLossless, webpLossy, withRiffSize, withTrailing,
} from "../../../../test/images";
import { onRequestDelete, onRequestPut } from "./logo";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());
beforeEach(() => t.env.DB.prepare("DELETE FROM site_logo").run());

interface Options { contentType?: string | null; raw?: string; data?: unknown; headers?: Record<string, string>; body?: BodyInit; duplex?: boolean }

const upload = (body: unknown, o: Options = {}): Promise<Response> => {
  const headers: Record<string, string> = { ...o.headers };
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  const init: RequestInit & { duplex?: string } = { method: "PUT", headers, body: o.body ?? o.raw ?? JSON.stringify(body) };
  if (o.duplex) init.duplex = "half";
  return Promise.resolve(onRequestPut({
    request: new Request("http://localhost/api/admin/settings/logo", init), env: t.env as AppEnv, data: "data" in o ? o.data : ADMIN,
  } as never));
};
const send = (bytes: Uint8Array, extra: Record<string, unknown> = {}, o: Options = {}) => upload({ data: toBase64(bytes), ...extra }, o);

// highWaterMark 0: the stream is only pulled when a reader asks, so a pull means the handler read the body.
const unreadable = (onPull: () => void) =>
  new ReadableStream<Uint8Array>({ pull(controller) { onPull(); controller.error(new Error("body was read")); } }, { highWaterMark: 0 });

const rowCount = async () => (await t.env.DB.prepare("SELECT COUNT(*) AS n FROM site_logo").first<{ n: number }>())!.n;
const storedSha = async () => (await t.env.DB.prepare("SELECT sha256 FROM site_logo").first<{ sha256: string }>())?.sha256;
type ErrorBody = { error: { code: string; message: string }; reason?: string; fields?: Record<string, string> };

describe("PUT /api/admin/settings/logo: accepted images", () => {
  it.each([
    ["image/png", makePng(120, 80), 120, 80], ["image/jpeg", makeJpeg(300, 200), 300, 200],
    ["image/webp", webpLossy(64, 64), 64, 64], ["image/webp", webpLossless(512, 1), 512, 1], ["image/webp", webpExtended(33, 44), 33, 44],
  ])("stores a %s and returns its details", async (contentType, bytes, width, height) => {
    const res = await send(bytes);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(await res.json()).toEqual({ logo: { url: `/api/logo?v=${sha.slice(0, 16)}`, width, height, contentType, bytes: bytes.length, sha256: sha } });
    expect(await storedSha()).toBe(sha);
  });

  it("stores the bytes exactly, and the type found in them", async () => {
    const bytes = makePng(5, 5);
    await send(bytes);
    const row = await t.env.DB.prepare("SELECT bytes, content_type FROM site_logo").first<{ bytes: number[]; content_type: string }>();
    expect(Buffer.from(row!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(row!.content_type).toBe("image/png");
  });

  it("replaces the logo in place, then deletes it", async () => {
    const first = makePng(4, 4);
    const second = makeJpeg(8, 9);
    await send(first);
    const sha1 = await storedSha();
    const res = await send(second);
    expect(res.status).toBe(200);
    expect(await rowCount()).toBe(1);
    expect(await storedSha()).not.toBe(sha1);
    expect(((await res.json()) as { logo: { contentType: string } }).logo.contentType).toBe("image/jpeg");

    const deleted = await onRequestDelete({ env: t.env as AppEnv, data: ADMIN } as never);
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("cache-control")).toBe("no-store");
    expect(await deleted.json()).toEqual({ logo: null });
    expect(await rowCount()).toBe(0);
  });

  it("takes exactly 204800 bytes and refuses 204801", async () => {
    const res = await send(pngOfSize(204_800));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { logo: { bytes: number } }).logo.bytes).toBe(204_800);
    const sha = await storedSha();

    const over = await send(pngOfSize(204_801));
    expect(over.status).toBe(413);
    expect(((await over.json()) as ErrorBody).error.code).toBe("too_large");
    expect(await storedSha()).toBe(sha); // the earlier logo is untouched
  });

  it("refuses a file whose base64 is already over the limit before decoding it", async () => {
    // 204,802 bytes encode to 273,072 characters, over the 273,068 that 204,800 bytes need.
    const res = await send(pngOfSize(204_802));
    expect(res.status).toBe(413);
    expect(((await res.json()) as ErrorBody).error.code).toBe("too_large");
    const garbage = await upload({ data: "!".repeat(273_072) }); // not even base64: refused on length first
    expect(garbage.status).toBe(413);
    expect(await rowCount()).toBe(0);
  });

  it("trusts nothing the client says about the file", async () => {
    // A real PNG labelled as SVG is still stored as a PNG...
    const res = await send(makePng(4, 4), { contentType: "image/svg+xml", type: "text/html", filename: "evil.svg", mime: "text/html" });
    expect(res.status).toBe(200);
    expect((await t.env.DB.prepare("SELECT content_type FROM site_logo").first<{ content_type: string }>())!.content_type).toBe("image/png");
    await t.env.DB.prepare("DELETE FROM site_logo").run();
    // ...and an SVG labelled as a PNG is refused.
    const svg = await send(text("<svg xmlns='http://www.w3.org/2000/svg'/>"), { contentType: "image/png", type: "image/png", filename: "logo.png" });
    expect(svg.status).toBe(422);
    expect(await rowCount()).toBe(0);
  });
});

describe("the app icons follow the logo", () => {
  const iconCount = async () => (await t.env.DB.prepare("SELECT COUNT(*) AS n FROM site_icons").first<{ n: number }>())!.n;
  const withIcons = async () => {
    const sha = (await saveLogo(t.env.DB, makePng(4, 4), { type: "image/png", width: 4, height: 4 })).sha256;
    for (const size of [32, 180, 512] as const) await saveIcon(t.env.DB, size, makePng(size, size), { background: "#0b5cad", logoSha256: sha });
    expect(await iconCount()).toBe(3);
  };

  it("replacing the logo removes the icons made from the old one", async () => {
    await withIcons();
    expect((await send(makePng(9, 9))).status).toBe(200);
    expect(await iconCount()).toBe(0);
  });

  it("deleting the logo removes the icons", async () => {
    await withIcons();
    expect((await onRequestDelete({ env: t.env as AppEnv, data: ADMIN } as never)).status).toBe(200);
    expect(await iconCount()).toBe(0);
  });

  it("a refused upload leaves the icons alone", async () => {
    await withIcons();
    expect((await send(withTrailing(makePng(4, 4), 0))).status).toBe(422);
    expect(await iconCount()).toBe(3);
  });
});

describe("PUT /api/admin/settings/logo: refused images", () => {
  const refusals: [string, Uint8Array, string][] = [
    ["an SVG", text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'), "unsupported_type"],
    ["an SVG with an XML prolog", text('<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"/>'), "unsupported_type"],
    ["an SVG with leading whitespace", text('\n  \t<svg xmlns="http://www.w3.org/2000/svg"/>'), "unsupported_type"],
    ["an SVG after a UTF-8 BOM", Uint8Array.of(0xef, 0xbb, 0xbf, ...text("<svg/>")), "unsupported_type"],
    ["an SVG in UTF-16", Uint8Array.of(0xff, 0xfe, ...[..."<svg/>"].flatMap((c) => [c.charCodeAt(0), 0])), "unsupported_type"],
    ["an HTML page", text("<!doctype html><script>alert(1)</script>"), "unsupported_type"],
    ["a GIF", text("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), "unsupported_type"],
    ["an ICO", Uint8Array.of(0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0), "unsupported_type"],
    ["a PDF", text("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF"), "unsupported_type"],
    ["plain text", text("hello"), "unsupported_type"],
    ["an empty file", new Uint8Array(0), "empty"],
    ["a 20000 x 20000 PNG in a tiny file", makePng(20000, 20000, false), "dimensions"],
    ["a PNG 513 pixels wide", makePng(513, 10), "dimensions"],
    ["a JPEG declaring 65535 x 65535", makeJpeg(65535, 65535), "dimensions"],
    ["a WebP 600 pixels tall", webpLossy(10, 600), "dimensions"],
    ["a PNG with bytes after IEND", withTrailing(makePng(4, 4), ...text("<script>alert(1)</script>")), "corrupt"],
    ["a JPEG with bytes after the EOI", withTrailing(makeJpeg(4, 4), ...text("<script>alert(1)</script>")), "corrupt"],
    ["a WebP with bytes after the last chunk", withTrailing(webpLossless(4, 4), 0, 0), "corrupt"],
    ["a WebP whose RIFF size is wrong", withRiffSize(webpLossless(4, 4), 1000), "corrupt"],
    ["a truncated PNG", makePng(4, 4).subarray(0, 40), "corrupt"],
    ["a truncated JPEG", makeJpeg(4, 4).subarray(0, 40), "corrupt"],
    ["a PNG signature and nothing else", PNG_SIGNATURE, "corrupt"],
  ];

  it.each(refusals)("refuses %s with 422 and says why", async (_name, bytes, reason) => {
    await saveLogo(t.env.DB, makePng(2, 2), { type: "image/png", width: 2, height: 2 });
    const sha = await storedSha();
    const res = await send(bytes);
    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("invalid_image");
    expect(body.reason).toBe(reason);
    expect(body.error.message.length).toBeGreaterThan(10);
    expect(await storedSha()).toBe(sha); // the existing logo is untouched
  });

  it("explains SVG in plain English", async () => {
    const body = (await (await send(text("<svg/>"))).json()) as ErrorBody;
    expect(body.error.message).toBe("Use a PNG, JPEG or WebP image. SVG isn't allowed.");
  });
});

describe("PUT /api/admin/settings/logo: the request", () => {
  const BAD_BASE64: [string, string][] = [
    ["whitespace", `${toBase64(makePng(4, 4)).slice(0, 8)} ${toBase64(makePng(4, 4)).slice(8)}`],
    ["a newline", `${toBase64(makePng(4, 4))}\n`],
    ["the URL-safe alphabet", toBase64(Uint8Array.of(251, 255, 254, 251)).replace(/\+/g, "-").replace(/\//g, "_")],
    ["missing padding", "AQIDBA"],
    ["a data: URL", `data:image/png;base64,${toBase64(makePng(4, 4))}`],
    ["bad characters", "!!!!"], ["a single character", "A"],
  ];

  it.each(BAD_BASE64)("refuses base64 with %s with 400 on the data field", async (_name, data) => {
    const res = await upload({ data });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("invalid_input");
    expect(Object.keys(body.fields!)).toEqual(["data"]);
    expect(await rowCount()).toBe(0);
  });

  it("treats an empty data string as an empty file", async () => {
    const res = await upload({ data: "" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).reason).toBe("empty");
  });

  it("refuses a body without a usable data string, with 400", async () => {
    for (const body of [{}, { data: null }, { data: 5 }, { data: true }, { data: [] }, { data: ["AAAA"] }, { data: {} }, { image: toBase64(makePng(4, 4)) }]) {
      const res = await upload(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe("invalid_input");
    }
    expect((await upload(undefined, { raw: "{nope" })).status).toBe(400);
    expect((await upload(undefined, { raw: "[1]" })).status).toBe(400);
    expect((await upload(undefined, { raw: "" })).status).toBe(400);
    expect(await rowCount()).toBe(0);
  });

  it("refuses anything but JSON with 415, even a real image", async () => {
    for (const contentType of ["text/plain", "image/png", "application/octet-stream", "multipart/form-data; boundary=x", null]) {
      const res = await upload({ data: toBase64(makePng(4, 4)) }, { contentType });
      expect(res.status, String(contentType)).toBe(415);
    }
    expect((await upload(undefined, { contentType: "image/png", body: makePng(4, 4) })).status).toBe(415);
    expect(await rowCount()).toBe(0);
  });

  it("refuses a body over 300,000 bytes with 413 too_large", async () => {
    const res = await upload(undefined, { raw: JSON.stringify({ data: "A".repeat(300_000) }) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ErrorBody).error.code).toBe("too_large");
    expect(await rowCount()).toBe(0);
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
    const res = await upload(undefined, { body: endless, duplex: true });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ErrorBody).error.code).toBe("too_large");
    expect(pulls).toBeLessThan(10); // 300,000 bytes is 6 chunks; a couple more may be prefetched
  });

  it("refuses an oversized Content-Length without reading the body at all", async () => {
    let pulls = 0;
    const stream = unreadable(() => pulls++);
    const res = await upload(undefined, { body: stream, duplex: true, headers: { "Content-Length": "5000000" } });
    expect(res.status).toBe(413);
    expect(pulls).toBe(0);
  });

  it("refuses with 401 unless the guard set an admin identity, storing nothing and reading nothing", async () => {
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      let pulls = 0;
      const stream = unreadable(() => pulls++);
      const res = await upload(undefined, { body: stream, duplex: true, data });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(pulls).toBe(0);
      expect((await send(makePng(4, 4), {}, { data })).status).toBe(401);
    }
    expect(await rowCount()).toBe(0);
  });
});

describe("DELETE /api/admin/settings/logo", () => {
  const del = (...args: [data?: unknown]) => Promise.resolve(onRequestDelete({ env: t.env as AppEnv, data: args.length ? args[0] : ADMIN } as never));

  it("answers 200 with a null logo whether or not there was one", async () => {
    for (const _ of [1, 2]) {
      const res = await del();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ logo: null });
    }
  });

  it("refuses with 401 unless the guard set an admin identity, deleting nothing", async () => {
    await send(makePng(4, 4));
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await del(data);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await rowCount()).toBe(1);
  });
});

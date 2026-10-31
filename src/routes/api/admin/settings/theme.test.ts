import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME } from "../../../../../public/theme.js";
import type { AppEnv } from "../../../../server/env";
import { createTestEnv, type TestEnv } from "../../../../test/db";
import { onRequestGet } from "./index";
import { onRequestDelete, onRequestPut } from "./theme";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };
const DEFAULT = { ...DEFAULT_THEME, isDefault: true };

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());
beforeEach(() => t.env.DB.prepare("UPDATE site_settings SET theme_primary = NULL, theme_accent = NULL, updated_at = '2000-01-01T00:00:00Z'").run());

const call = (handler: typeof onRequestPut, init: RequestInit & { data?: unknown } = {}) => {
  const { data, ...rest } = init;
  return Promise.resolve(handler({
    request: new Request("http://localhost/api/admin/settings/theme", rest), env: t.env as AppEnv, data: "data" in init ? data : ADMIN,
  } as never));
};
const put = (body: unknown, extra: { raw?: string; contentType?: string | null; data?: unknown } = {}) => {
  const headers: Record<string, string> = {};
  if (extra.contentType !== null) headers["Content-Type"] = extra.contentType ?? "application/json";
  return call(onRequestPut, { method: "PUT", headers, body: extra.raw ?? JSON.stringify(body), ...("data" in extra ? { data: extra.data } : {}) });
};
const del = (extra: { data?: unknown } = {}) => call(onRequestDelete, { method: "DELETE", ...extra });
const stored = () => t.env.DB.prepare("SELECT theme_primary, theme_accent, updated_at FROM site_settings").first();
const NOTHING = { theme_primary: null, theme_accent: null, updated_at: "2000-01-01T00:00:00Z" };
const GREEN = { primary: "#1b6b3a", accent: "#1b6b3a" };

describe("PUT /api/admin/settings/theme", () => {
  it("saves, normalising short and upper-case colours, and answers with the stored theme", async () => {
    const res = await put({ primary: "#ABC", accent: "  #1B6B3A " });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ theme: { primary: "#aabbcc", accent: "#1b6b3a", isDefault: false } });
    expect(await stored()).toMatchObject({ theme_primary: "#aabbcc", theme_accent: "#1b6b3a" });
    expect((await stored() as { updated_at: string }).updated_at > "2020-01-01").toBe(true);
  });

  it("is what GET /api/admin/settings then reports", async () => {
    await put({ primary: "#a1235f", accent: "#1b6b3a" });
    const body = (await (await call(onRequestGet, { method: "GET" })).json()) as { theme: unknown };
    expect(body.theme).toEqual({ primary: "#a1235f", accent: "#1b6b3a", isDefault: false });
  });

  it("saves a theme that has warnings but no blocking failure (a pale yellow primary)", async () => {
    const res = await put({ primary: "#ffd400", accent: "#0b5cad" });
    expect(res.status).toBe(200);
    expect(await stored()).toMatchObject({ theme_primary: "#ffd400" });
  });

  // Everything here either isn't a hex colour or tries to smuggle CSS in. Each must be refused and nothing stored.
  const HOSTILE = [
    "red", "rgb(0,0,0)", "hsl(0,0%,0%)", "#fff;}body{display:none}", "#fff;}x{", "url(//evil)", "url(https://evil.example/x.css)", "expression(alert(1))",
    "</style><script>alert(1)</script>", "#fff</style><script>", "#ffffffff", "#ffff", "#12345", "#1234567", "#ggg", "fff", "", " ", "#", "var(--x)",
    "#fff/*", "#fff\n", "#fff\n}", "\\", "#fff\\", "@import url(//evil)", "#ＦＦＦ", "#fff\u0000", "😀", "#" + "f".repeat(10_000), "x".repeat(10_000),
    " ".repeat(10_000) + "#fff",
  ];
  const NOT_STRINGS = [null, undefined, 5, 0, true, false, [], ["#ffffff"], {}, { toString: () => "#ffffff" }];

  it.each(["primary", "accent"] as const)("answers 400 with fields naming %s for every hostile or non-string value, storing nothing", async (key) => {
    for (const value of [...HOSTILE, ...NOT_STRINGS]) {
      const body = { ...GREEN, [key]: value };
      const res = await put(body);
      const label = `${key}=${JSON.stringify(value)?.slice(0, 40)}`;
      expect(res.status, label).toBe(400);
      expect(res.headers.get("cache-control"), label).toBe("no-store");
      const json = (await res.json()) as { error: { code: string }; fields: Record<string, string> };
      expect(json.error.code, label).toBe("invalid_input");
      expect(Object.keys(json.fields), label).toEqual([key]);
      expect(JSON.stringify(json), label).not.toContain("evil");
    }
    expect(await stored()).toEqual(NOTHING);
  });

  it("names both colours when both are bad, and when both are missing", async () => {
    for (const body of [{ primary: "red", accent: "blue" }, {}, { primary: 1, accent: 2 }]) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect(Object.keys(((await res.json()) as { fields: object }).fields)).toEqual(["primary", "accent"]);
    }
    expect(await stored()).toEqual(NOTHING);
  });

  it("answers 422 theme_contrast, listing only the blocking failures, and stores nothing", async () => {
    const pale = await put({ primary: "#0b5cad", accent: "#ffd400" });
    expect(pale.status).toBe(422);
    expect(pale.headers.get("cache-control")).toBe("no-store");
    const body = (await pale.json()) as { error: { code: string; message: string }; failures: { id: string; label: string; mode: string; ratio: number; min: number }[] };
    expect(body.error.code).toBe("theme_contrast");
    expect(body.error.message).toMatch(/hard to read/);
    expect(body.failures.map((f) => f.id)).toEqual(["accent-light-page", "accent-light-card"]);
    expect(body.failures[0]).toEqual({
      id: "accent-light-page", label: "Links and outlined buttons on the page background (light mode)", mode: "light", ratio: 1.33, min: 4.5,
    });
    expect(await stored()).toEqual(NOTHING);
  });

  it("refuses #0077dd as the primary because light-mode button text just misses, naming only that check", async () => {
    const res = await put({ primary: "#0077dd", accent: "#0b5cad" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { failures: { id: string; ratio: number; min: number }[] };
    expect(body.failures).toEqual([expect.objectContaining({ id: "button-text-light", ratio: 4.48, min: 4.5 })]);
    expect(await stored()).toEqual(NOTHING);
  });

  it("keeps the previous theme when a later save is refused", async () => {
    await put(GREEN);
    expect((await put({ primary: "#0b5cad", accent: "#808080" })).status).toBe(422);
    expect((await put({ primary: "#0b5cad", accent: "red" })).status).toBe(400);
    expect(await stored()).toMatchObject({ theme_primary: "#1b6b3a", theme_accent: "#1b6b3a" });
  });

  it("ignores extra keys", async () => {
    const res = await put({ ...GREEN, css: "}body{display:none}", isDefault: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: { ...GREEN, isDefault: false } });
  });

  it("answers 415, 400 and 413 for bad bodies, storing nothing", async () => {
    expect((await put(GREEN, { contentType: "text/plain" })).status).toBe(415);
    expect((await put(GREEN, { contentType: null })).status).toBe(415);
    expect((await put(undefined, { raw: "{nope" })).status).toBe(400);
    expect((await put(undefined, { raw: "[1]" })).status).toBe(400);
    expect((await put({ ...GREEN, padding: "x".repeat(40_000) })).status).toBe(413);
    expect(await stored()).toEqual(NOTHING);
  });

  it("refuses with 401 unless the guard set an admin identity, storing nothing", async () => {
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await put(GREEN, { data });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await stored()).toEqual(NOTHING);
  });
});

describe("DELETE /api/admin/settings/theme", () => {
  it("resets to the default and says so, every time", async () => {
    await put(GREEN);
    for (let i = 0; i < 2; i++) {
      const res = await del();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ theme: DEFAULT });
    }
    expect(await stored()).toMatchObject({ theme_primary: null, theme_accent: null });
    expect((await stored() as { updated_at: string }).updated_at > "2020-01-01").toBe(true);
    const body = (await (await call(onRequestGet, { method: "GET" })).json()) as { theme: unknown };
    expect(body.theme).toEqual(DEFAULT);
  });

  it("refuses with 401 unless the guard set an admin identity, changing nothing", async () => {
    await put(GREEN);
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await del({ data });
      expect(res.status).toBe(401);
    }
    expect(await stored()).toMatchObject({ theme_primary: "#1b6b3a" });
  });
});

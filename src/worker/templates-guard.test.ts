import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOW, ORIGIN, passwordEnv, TEST_PASSWORD, writeHeaders } from "../server/auth/test-harness";
import type { AppEnv } from "../server/env";
import { countRows, createTestEnv, type TestEnv } from "../test/db";
import { createWorker } from "../worker";

// The template routes through the whole Worker: the real guard (sign-in, then Origin, CSRF token and JSON type for writes) and the router.

let t: TestEnv;
let env: AppEnv;
let cookie: string;
let csrfToken: string;
beforeAll(async () => {
  t = await createTestEnv();
  env = await passwordEnv(t.env.DB);
  const login = await send("/api/admin/login", {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.90" }, body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  ({ csrfToken } = (await login.json()) as { csrfToken: string });
});
afterAll(async () => { await t.dispose(); });

const worker = createWorker({ now: () => NOW });
const send = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);

const TEMPLATE = {
  name: "Saturday", details: "", venuePostcode: "AB1 2CD", costPence: 1500, start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 0,
  breaks: [], shareMessage: "Book {event}",
};
const json = (body: unknown = TEMPLATE) => JSON.stringify(body);
const signedIn = (extra: Record<string, string> = {}) => ({ ...writeHeaders(csrfToken), Cookie: cookie, ...extra });

const WRITES: [string, string][] = [["POST", "/api/admin/templates"], ["PUT", "/api/admin/templates/1"], ["DELETE", "/api/admin/templates/1"]];
const ALL: [string, string][] = [["GET", "/api/admin/templates"], ["GET", "/api/admin/templates/1"], ...WRITES];

describe("the template routes behind the admin guard", () => {
  it("answers every one with 401 when not signed in, with or without CSRF headers, touching nothing", async () => {
    for (const [method, path] of ALL) {
      for (const headers of [{}, writeHeaders(csrfToken)]) {
        const res = await send(path, { method, headers, body: method === "GET" || method === "DELETE" ? undefined : json() });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" } });
      }
    }
    expect(await countRows(t.env.DB, "event_templates")).toBe(0);
  });

  it("refuses a write with no CSRF token, a wrong one, no Origin, a foreign Origin or a cross-site request: 403, nothing written", async () => {
    const made = await send("/api/admin/templates", { method: "POST", headers: signedIn(), body: json() });
    expect(made.status).toBe(201);
    const { template } = (await made.json()) as { template: { id: number } };
    const bad: [string, Record<string, string>][] = [
      ["no token", { Origin: ORIGIN, "Content-Type": "application/json", Cookie: cookie }],
      ["a wrong token", { ...writeHeaders("wrong"), Cookie: cookie }],
      ["no Origin", { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, Cookie: cookie }],
      ["a foreign Origin", { ...writeHeaders(csrfToken, { Origin: "https://evil.example" }), Cookie: cookie }],
      ["a cross-site fetch", { ...writeHeaders(csrfToken, { "Sec-Fetch-Site": "cross-site" }), Cookie: cookie }],
    ];
    for (const [what, headers] of bad) {
      for (const [method, path] of [["POST", "/api/admin/templates"], ["PUT", `/api/admin/templates/${template.id}`], ["DELETE", `/api/admin/templates/${template.id}`]]) {
        const res = await send(path, { method, headers, body: method === "DELETE" ? undefined : json({ ...TEMPLATE, name: "Changed" }) });
        expect(res.status, `${method} ${path} with ${what}`).toBe(403);
        expect(await res.json()).toMatchObject({ error: { code: "csrf_failed" } });
      }
    }
    const wrongType = await send("/api/admin/templates", { method: "POST", headers: signedIn({ "Content-Type": "text/plain" }), body: json({ ...TEMPLATE, name: "Plain" }) });
    expect(wrongType.status).toBe(415);
    const listed = (await (await send("/api/admin/templates", { headers: { Cookie: cookie } })).json()) as { templates: { name: string }[] };
    expect(listed.templates.map((x) => x.name)).toEqual(["Saturday"]); // not changed, not deleted, no second one
  });

  it("lets a signed-in admin read without a token, and write with the full set, end to end", async () => {
    expect(await countRows(t.env.DB, "event_templates")).toBe(1);
    const read = await send("/api/admin/templates", { headers: { Cookie: cookie } });
    expect(read.status).toBe(200);
    const created = await send("/api/admin/templates", { method: "POST", headers: signedIn(), body: json({ ...TEMPLATE, name: "Sunday" }) });
    expect(created.status).toBe(201);
    const { template } = (await created.json()) as { template: { id: number; isDefault: boolean } };
    expect(template.isDefault).toBe(false);
    expect((await send(`/api/admin/templates/${template.id}`, { headers: { Cookie: cookie } })).status).toBe(200);
    const edited = await send(`/api/admin/templates/${template.id}`, { method: "PUT", headers: signedIn(), body: json({ ...TEMPLATE, name: "Sunday 2", isDefault: true }) });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ template: { name: "Sunday 2", isDefault: true } });
    const removed = await send(`/api/admin/templates/${template.id}`, { method: "DELETE", headers: signedIn() });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: { id: template.id, name: "Sunday 2" } });
    expect((await send(`/api/admin/templates/${template.id}`, { headers: { Cookie: cookie } })).status).toBe(404);
    expect(await countRows(t.env.DB, "event_templates")).toBe(1);
  });

  it("answers 404 for an :id that isn't a positive whole number, and 405 for a method the route doesn't have", async () => {
    expect((await send("/api/admin/templates/abc", { headers: { Cookie: cookie } })).status).toBe(404);
    expect((await send("/api/admin/templates/0", { method: "DELETE", headers: signedIn() })).status).toBe(404);
    const patch = await send("/api/admin/templates", { method: "PATCH", headers: signedIn() });
    expect(patch.status).toBe(405);
    expect(patch.headers.get("allow")).toBe("GET, HEAD, POST");
    expect((await send("/api/admin/templates/1", { method: "POST", headers: signedIn(), body: "{}" })).status).toBe(405);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createApi } from "./api.js";

const reply = (status: number, body: unknown = null) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const SESSION = (csrfToken: string) => reply(200, { identity: "ann@example.com", provider: "password", csrfToken });
const CSRF_FAILED = () => reply(403, { error: { code: "csrf_failed", message: "Bad token" } });

type Call = { url: string; init?: RequestInit };

function setup(handler: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init }, calls.length);
  });
  const navigate = vi.fn();
  return { api: createApi({ fetch: fetch as unknown as typeof globalThis.fetch, navigate }), calls, navigate };
}
const header = (call: Call, name: string) => (call.init?.headers as Record<string, string> | undefined)?.[name];

describe("loadSession", () => {
  it("returns the session", async () => {
    const { api } = setup(() => SESSION("t1"));
    expect(await api.loadSession()).toEqual({ identity: "ann@example.com", provider: "password", csrfToken: "t1" });
  });

  it("sends a 401 to the login page and returns null", async () => {
    const { api, navigate } = setup(() => reply(401, { error: { code: "unauthorized" } }));
    expect(await api.loadSession()).toBeNull();
    expect(navigate).toHaveBeenCalledWith("/admin/login");
  });

  it("throws for other failures", async () => {
    const { api, navigate } = setup(() => reply(500, null));
    await expect(api.loadSession()).rejects.toThrow();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("request", () => {
  it("sends no CSRF header on GET", async () => {
    const { api, calls } = setup(() => reply(200, { events: [] }));
    expect(await api.request("GET", "/api/admin/events")).toEqual({ status: 200, data: { events: [] } });
    expect(calls).toHaveLength(1); // no session fetch needed
    expect(calls[0].init?.headers).toBeUndefined();
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("sends the token and JSON content type on writes, fetching the session first if needed", async () => {
    const { api, calls } = setup((c) => (c.url === "/api/admin/session" ? SESSION("t1") : reply(201, { ok: 1 })));
    const r = await api.request("POST", "/api/admin/events", { name: "x" });
    expect(r).toEqual({ status: 201, data: { ok: 1 } });
    expect(calls.map((c) => c.url)).toEqual(["/api/admin/session", "/api/admin/events"]);
    expect(header(calls[1], "X-CSRF-Token")).toBe("t1");
    expect(header(calls[1], "Content-Type")).toBe("application/json");
    expect(calls[1].init?.body).toBe('{"name":"x"}');
  });

  it("passes the abort signal through", async () => {
    const { api, calls } = setup((c) => (c.url === "/api/admin/session" ? SESSION("t1") : reply(200, {})));
    const ctl = new AbortController();
    await api.request("POST", "/api/admin/events/preview", {}, ctl.signal);
    expect(calls[1].init?.signal).toBe(ctl.signal);
  });

  it("refetches the session and retries once after csrf_failed", async () => {
    let token = "old";
    const { api, calls } = setup((c) => {
      if (c.url === "/api/admin/session") return SESSION(token);
      return header(c, "X-CSRF-Token") === "new" ? reply(201, { done: true }) : CSRF_FAILED();
    });
    await api.loadSession();
    token = "new";
    const r = await api.request("POST", "/api/admin/events", { a: 1 });
    expect(r).toEqual({ status: 201, data: { done: true } });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/admin/session", "/api/admin/events", "/api/admin/session", "/api/admin/events",
    ]);
    expect(header(calls[3], "X-CSRF-Token")).toBe("new");
    expect(calls[3].init?.body).toBe('{"a":1}');
  });

  it("surfaces a second csrf_failed instead of looping", async () => {
    const { api, calls, navigate } = setup((c) => (c.url === "/api/admin/session" ? SESSION("t") : CSRF_FAILED()));
    const r = await api.request("POST", "/api/admin/events", {});
    expect(r.status).toBe(403);
    expect(r.data).toEqual({ error: { code: "csrf_failed", message: "Bad token" } });
    expect(calls.filter((c) => c.url === "/api/admin/events")).toHaveLength(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not retry other 403s", async () => {
    const { api, calls } = setup((c) => (c.url === "/api/admin/session" ? SESSION("t") : reply(403, { error: { code: "forbidden" } })));
    expect((await api.request("POST", "/x", {})).status).toBe(403);
    expect(calls.filter((c) => c.url === "/x")).toHaveLength(1);
  });

  it("navigates to the login page on 401", async () => {
    const { api, navigate } = setup((c) => (c.url === "/api/admin/session" ? SESSION("t") : reply(401, { error: { code: "unauthorized" } })));
    expect((await api.request("POST", "/x", {})).status).toBe(401);
    expect(navigate).toHaveBeenCalledWith("/admin/login");
    navigate.mockClear();
    expect((await api.request("GET", "/x")).status).toBe(401);
    expect(navigate).toHaveBeenCalledWith("/admin/login");
  });

  it("navigates to the login page if the session has gone when a write needs it", async () => {
    const { api, calls, navigate } = setup(() => reply(401));
    expect(await api.request("POST", "/x", {})).toEqual({ status: 401, data: null });
    expect(calls).toHaveLength(1);
    expect(navigate).toHaveBeenCalledWith("/admin/login");
  });

  it("rejects on network errors", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("offline"); });
    const api = createApi({ fetch: fetch as unknown as typeof globalThis.fetch, navigate: vi.fn() });
    await expect(api.request("GET", "/x")).rejects.toThrow("offline");
  });
});

describe("logout", () => {
  it("goes to the login page for a password session", async () => {
    const { api, calls, navigate } = setup((c) => (c.url === "/api/admin/session" ? SESSION("t") : reply(200, { ok: true })));
    await api.logout();
    expect(calls[1].url).toBe("/api/admin/logout");
    expect(calls[1].init?.method).toBe("POST");
    expect(header(calls[1], "X-CSRF-Token")).toBe("t");
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/admin/login");
  });

  it("goes to the logout URL for an Access session", async () => {
    const { api, navigate } = setup((c) => (c.url === "/api/admin/session" ? SESSION("t") : reply(200, { logoutUrl: "/cdn-cgi/access/logout" })));
    await api.logout();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/cdn-cgi/access/logout");
  });

  it("throws when sign-out fails, without navigating", async () => {
    const { api, navigate } = setup((c) => (c.url === "/api/admin/session" ? SESSION("t") : reply(500, null)));
    await expect(api.logout()).rejects.toThrow();
    expect(navigate).not.toHaveBeenCalled();
  });
});

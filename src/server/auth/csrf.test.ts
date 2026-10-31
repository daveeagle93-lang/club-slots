import { describe, expect, it } from "vitest";
import { csrfFailure, csrfToken, hasSameOrigin } from "./csrf";

const URL_ = "https://club.example/api/admin/events";
const make = (headers: Record<string, string>, method = "POST") => new Request(URL_, { method, headers });
const good = { Origin: "https://club.example", "Content-Type": "application/json" };

describe("csrfToken", () => {
  it("is a 43-character base64url SHA-256 that differs per binding", async () => {
    const a = await csrfToken("binding-a");
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await csrfToken("binding-a")).toBe(a);
    expect(await csrfToken("binding-b")).not.toBe(a);
  });

  it("matches the documented derivation", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("slot-booker-csrf-v1:abc")));
    expect(await csrfToken("abc")).toBe(btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  });
});

describe("hasSameOrigin", () => {
  it("needs an Origin equal to the request's own, and any Sec-Fetch-Site to be same-origin", () => {
    expect(hasSameOrigin(make({ Origin: "https://club.example" }))).toBe(true);
    expect(hasSameOrigin(make({ Origin: "https://club.example", "Sec-Fetch-Site": "same-origin" }))).toBe(true);
    expect(hasSameOrigin(make({}))).toBe(false);
    expect(hasSameOrigin(make({ Origin: "null" }))).toBe(false);
    expect(hasSameOrigin(make({ Origin: "https://evil.example" }))).toBe(false);
    expect(hasSameOrigin(make({ Origin: "http://club.example" }))).toBe(false);
    expect(hasSameOrigin(make({ Origin: "https://club.example:8443" }))).toBe(false);
    expect(hasSameOrigin(make({ Origin: "https://club.example", "Sec-Fetch-Site": "cross-site" }))).toBe(false);
    expect(hasSameOrigin(make({ Origin: "https://club.example", "Sec-Fetch-Site": "same-site" }))).toBe(false);
    expect(hasSameOrigin(make({ Origin: "https://club.example", "Sec-Fetch-Site": "none" }))).toBe(false);
  });
});

describe("csrfFailure", () => {
  const token = () => csrfToken("session-1");
  const withToken = async (extra: Record<string, string> = {}) => make({ ...good, "X-CSRF-Token": await token(), ...extra });

  it("lets a same-origin JSON request with the right token through", async () => {
    expect(await csrfFailure(await withToken(), "session-1")).toBeNull();
  });

  it("refuses with 403 csrf_failed when the token is missing, wrong, or another session's", async () => {
    for (const request of [
      make(good), make({ ...good, "X-CSRF-Token": "" }), make({ ...good, "X-CSRF-Token": "wrong" }),
      make({ ...good, "X-CSRF-Token": await csrfToken("session-2") }),
      make({ ...good, "X-CSRF-Token": `${await token()}x` }),
    ]) {
      const res = (await csrfFailure(request, "session-1"))!;
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("csrf_failed");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("refuses a foreign, missing or cross-site origin even with a valid token", async () => {
    for (const extra of [{ Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
      expect((await csrfFailure(await withToken(extra), "session-1"))?.status).toBe(403);
    }
    const noOrigin = new Request(URL_, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": await token() } });
    expect((await csrfFailure(noOrigin, "session-1"))?.status).toBe(403);
  });

  it("refuses a body that is not declared as JSON with 415", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = (await csrfFailure(await withToken({ "Content-Type": type }), "session-1"))!;
      expect(res.status).toBe(415);
    }
    const none = new Request(URL_, { method: "POST", headers: { Origin: good.Origin, "X-CSRF-Token": await token() } });
    expect((await csrfFailure(none, "session-1"))?.status).toBe(415);
    expect(await csrfFailure(await withToken({ "Content-Type": "application/json; charset=utf-8" }), "session-1")).toBeNull();
  });
});

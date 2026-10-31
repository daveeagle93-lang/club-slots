import { describe, expect, it } from "vitest";
import { refuseUnlessAdmin } from "./admin-context";

describe("refuseUnlessAdmin", () => {
  it("lets a request through when the guard set a non-empty identity", () => {
    expect(refuseUnlessAdmin({ admin: { identity: "test@example.com", csrfBinding: "x" } })).toBeNull();
  });

  it.each([
    ["undefined data", undefined],
    ["null data", null],
    ["empty data", {}],
    ["null admin", { admin: null }],
    ["a string admin", { admin: "test@example.com" }],
    ["no identity", { admin: { csrfBinding: "x" } }],
    ["an empty identity", { admin: { identity: "", csrfBinding: "x" } }],
    ["a non-string identity", { admin: { identity: 42, csrfBinding: "x" } }],
  ])("refuses with 401 unauthenticated, no-store, for %s", async (_name, data) => {
    const res = refuseUnlessAdmin(data);
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(res!.headers.get("cache-control")).toBe("no-store");
    expect(await res!.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } });
  });
});

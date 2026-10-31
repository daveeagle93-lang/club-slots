import { describe, expect, it } from "vitest";
import { errorResponse, json } from "./http";

const hardening = { "x-content-type-options": "nosniff", "x-robots-tag": "noindex" };

describe("json", () => {
  it("adds nosniff and noindex, keeps the caller's headers and status", async () => {
    const res = json({ a: 1 }, 201, { "Cache-Control": "no-store" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
    for (const [k, v] of Object.entries(hardening)) expect(res.headers.get(k)).toBe(v);
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("adds them with no extra headers at all", () => {
    const res = json({});
    for (const [k, v] of Object.entries(hardening)) expect(res.headers.get(k)).toBe(v);
  });
});

describe("errorResponse", () => {
  it("adds nosniff and noindex", () => {
    const res = errorResponse(404, "not_found", "Nope");
    for (const [k, v] of Object.entries(hardening)) expect(res.headers.get(k)).toBe(v);
  });
});

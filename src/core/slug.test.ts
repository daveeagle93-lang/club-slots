import { describe, expect, it } from "vitest";
import { generateBookingToken, generateSlug, isValidSlug, isValidToken } from "./slug";

describe("generateSlug", () => {
  it("is 22 base64url characters", () => {
    expect(generateSlug()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("is unique across 1000 calls", () => {
    expect(new Set(Array.from({ length: 1000 }, generateSlug)).size).toBe(1000);
  });
});

describe("isValidSlug", () => {
  it("accepts generated slugs", () => {
    for (let i = 0; i < 100; i++) expect(isValidSlug(generateSlug())).toBe(true);
  });

  it("accepts the 16 and 64 character bounds", () => {
    expect(isValidSlug("a".repeat(16))).toBe(true);
    expect(isValidSlug("a".repeat(64))).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["short", "abc"],
    ["15 characters", "a".repeat(15)],
    ["spaces", "a".repeat(15) + " b"],
    ["path traversal", "../x" + "a".repeat(16)],
    ["unicode", "é".repeat(20)],
    ["over 64 characters", "a".repeat(65)],
    ["trailing newline", "a".repeat(22) + "\n"],
  ])("rejects %s", (_label, s) => {
    expect(isValidSlug(s)).toBe(false);
  });
});

describe("generateBookingToken", () => {
  it("is 22 base64url characters (128 bits)", () => {
    expect(generateBookingToken()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("is unique across 1000 calls, and not the same stream as slugs", () => {
    const tokens = Array.from({ length: 1000 }, generateBookingToken);
    expect(new Set(tokens).size).toBe(1000);
    expect(tokens).not.toContain(generateSlug());
  });
});

describe("isValidToken", () => {
  it("accepts generated tokens and SQL-backfilled 32-hex tokens", () => {
    for (let i = 0; i < 100; i++) expect(isValidToken(generateBookingToken())).toBe(true);
    expect(isValidToken("0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["short", "abc"],
    ["15 characters", "a".repeat(15)],
    ["spaces", "a".repeat(15) + " b"],
    ["path traversal", "../x" + "a".repeat(16)],
    ["unicode", "é".repeat(20)],
    ["over 64 characters", "a".repeat(65)],
    ["trailing newline", "a".repeat(22) + "\n"],
  ])("rejects %s", (_label, s) => {
    expect(isValidToken(s)).toBe(false);
  });
});

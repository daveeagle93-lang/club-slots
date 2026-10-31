import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS, withSecurityHeaders } from "./headers";

/** The `/*` block of public/_headers: the headers Cloudflare applies to static files served without the Worker. */
const staticHeaders = (): Record<string, string> => {
  const text = readFileSync(join(import.meta.dirname, "../../public/_headers"), "utf8");
  const blocks = text.split(/\n(?=\S)/).map((b) => b.split("\n").map((l) => l.trimEnd()).filter(Boolean));
  const star = blocks.filter((b) => b[0] === "/*");
  expect(star).toHaveLength(1);
  return Object.fromEntries(star[0].slice(1).map((line) => {
    const at = line.indexOf(":");
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
};

describe("SECURITY_HEADERS", () => {
  it("is identical to the /* block of public/_headers (the two must not drift)", () => {
    expect(SECURITY_HEADERS).toEqual(staticHeaders());
  });

  it("has the five headers, and HSTS is one year with no includeSubDomains or preload", () => {
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual(["Content-Security-Policy", "Referrer-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "X-Robots-Tag"]);
    expect(SECURITY_HEADERS["Strict-Transport-Security"]).toBe("max-age=31536000");
  });
});

describe("withSecurityHeaders", () => {
  it("adds every header to a response that has none, keeping status, body and other headers", async () => {
    const res = withSecurityHeaders(new Response("hello", { status: 201, statusText: "Made", headers: { "X-Mine": "1" } }));
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Made");
    expect(res.headers.get("x-mine")).toBe("1");
    expect(await res.text()).toBe("hello");
  });

  it("never overrides a header the response already sets (icon and logo CSP, the API's own nosniff)", () => {
    const res = withSecurityHeaders(new Response("x", { headers: { "Content-Security-Policy": "default-src 'none'; sandbox", "X-Robots-Tag": "none" } }));
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-robots-tag")).toBe("none");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("works on a redirect, keeping its Location, and on a body-less response", () => {
    const res = withSecurityHeaders(new Response(null, { status: 302, headers: { Location: "/admin/login" } }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/login");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(withSecurityHeaders(new Response(null, { status: 304 })).status).toBe(304);
  });

  it("works on a response whose headers are immutable (as the ASSETS binding's can be)", () => {
    const frozen = Response.redirect("https://club.example/admin/login", 307);
    expect(() => frozen.headers.set("A", "1")).toThrow();
    const res = withSecurityHeaders(frozen);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://club.example/admin/login");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRoutes } from "./routes";
import type { Route } from "./router";

const table = createRoutes();
const ROUTES_DIR = join(import.meta.dirname, "../routes");

/** Patterns for things that are not files under src/routes/: the public pages the Worker sees first. */
const PAGE_PATTERNS = ["/", "/e/:slug", "/setup"];

/** `api/admin/events/[slug]/export.csv.ts` -> `/api/admin/events/:slug/export.csv`; `index.ts` stands for its directory. */
const patternOf = (file: string): string => {
  const segments = file.replace(/\.ts$/, "").split("/");
  if (segments.at(-1) === "index") segments.pop();
  return `/${segments.map((s) => s.replace(/^\[(.+)\]$/, ":$1")).join("/")}`;
};

const handlerFiles = readdirSync(ROUTES_DIR, { recursive: true, encoding: "utf8" })
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .sort();

const METHOD_OF: Record<string, Route["method"]> = {
  onRequest: "*", onRequestGet: "GET", onRequestPost: "POST", onRequestPut: "PUT", onRequestDelete: "DELETE",
};
const label = (r: Route) => `${r.method} ${r.pattern}`;

describe("the route table matches the handler files", () => {
  it("has a pattern for every file under src/routes/, and no pattern without a file (apart from the pages)", () => {
    const fromFiles = handlerFiles.map(patternOf).sort();
    const fromTable = [...new Set(table.map((r) => r.pattern))].filter((p) => !PAGE_PATTERNS.includes(p)).sort();
    expect(fromTable).toEqual(fromFiles);
  });

  it("lists exactly the methods each file exports, wired to the handler it exports", async () => {
    for (const file of handlerFiles) {
      const pattern = patternOf(file);
      const module = (await import(/* @vite-ignore */ join(ROUTES_DIR, file))) as Record<string, unknown>;
      const exported = Object.keys(module).filter((k) => k in METHOD_OF).sort();
      const entries = table.filter((r) => r.pattern === pattern);
      expect(entries.map((r) => r.method).sort(), file).toEqual(exported.map((k) => METHOD_OF[k]).sort());
      for (const entry of entries) {
        const name = Object.keys(METHOD_OF).find((k) => METHOD_OF[k] === entry.method)!;
        // The login and setup handlers are built per Worker (so tests can inject a clock); they are not the exported instances.
        if (pattern === "/api/admin/login" || pattern === "/api/setup") expect(typeof entry.handler, label(entry)).toBe("function");
        else expect(entry.handler, `${label(entry)} -> ${file}`).toBe(module[name]);
      }
    }
  });

  it("has no duplicate method and pattern", () => {
    expect(new Set(table.map(label)).size).toBe(table.length);
  });
});

describe("access", () => {
  it("marks every /api/admin route admin, and no other route", () => {
    for (const r of table) expect(r.access, label(r)).toBe(r.pattern.startsWith("/api/admin/") ? "admin" : "public");
    expect(table.filter((r) => r.access === "admin").length).toBeGreaterThan(20);
  });

  // Adding a public route is a conscious edit: it must be added to this list as well as to routes.ts.
  it("pins the public routes", () => {
    expect(table.filter((r) => r.access === "public").map(label)).toEqual([
      "GET /api/events",
      "GET /api/events/:slug",
      "POST /api/events/:slug/bookings",
      "GET /api/events/:slug/bookings/:token/ics",
      "GET /api/health",
      "* /api/icon/:size",
      "* /api/logo",
      "* /api/manifest.webmanifest",
      "GET /api/settings",
      "GET /api/setup",
      "POST /api/setup",
      "* /api/theme.css",
      "* /favicon.ico",
      "GET /",
      "GET /e/:slug",
      "GET /setup",
    ]);
  });

  it("pins the admin routes", () => {
    expect(table.filter((r) => r.access === "admin").map(label).sort()).toEqual([
      "DELETE /api/admin/events/:slug",
      "DELETE /api/admin/events/:slug/bookings/:id",
      "DELETE /api/admin/settings/logo",
      "DELETE /api/admin/settings/theme",
      "DELETE /api/admin/templates/:id",
      "GET /api/admin/events",
      "GET /api/admin/events/:slug",
      "GET /api/admin/events/:slug/export.csv",
      "GET /api/admin/session",
      "GET /api/admin/settings",
      "GET /api/admin/templates",
      "GET /api/admin/templates/:id",
      "POST /api/admin/events",
      "POST /api/admin/events/:slug/archive",
      "POST /api/admin/events/:slug/bookings",
      "POST /api/admin/events/:slug/bookings/:id/move",
      "POST /api/admin/events/:slug/bookings/swap",
      "POST /api/admin/events/:slug/preview",
      "POST /api/admin/events/clear-past",
      "POST /api/admin/events/preview",
      "POST /api/admin/login",
      "POST /api/admin/logout",
      "POST /api/admin/templates",
      "PUT /api/admin/events/:slug",
      "PUT /api/admin/settings",
      "PUT /api/admin/settings/icons/:size",
      "PUT /api/admin/settings/logo",
      "PUT /api/admin/settings/theme",
      "PUT /api/admin/templates/:id",
    ]);
  });
});

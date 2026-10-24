import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const PUBLIC = join(ROOT, "public");
const ROUTES = join(ROOT, "src/routes");

const htmlFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith(".html") ? [join(dir, e.name)] : []));
const PAGES = htmlFiles(PUBLIC).map((f) => relative(PUBLIC, f).replaceAll("\\", "/")).sort();

/** Every <link> in the page, as its attributes. */
const links = (html: string): Record<string, string>[] =>
  [...html.matchAll(/<link\b([^>]*)>/g)].map(([, attrs]) =>
    Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v])));

/** True if the app would answer this path: a file in public/, or a route file under src/routes/ (a [name] segment matches any one segment; src/worker/routes.test.ts holds the route table to those files). */
function isServed(pathname: string): boolean {
  if (existsSync(join(PUBLIC, pathname))) return true;
  const segments = pathname.split("/").filter(Boolean);
  const walk = (dir: string, rest: string[]): boolean => {
    if (rest.length === 0) return false;
    const [head, ...tail] = rest;
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.some((e) => {
      const name = e.name.replace(/\.ts$/, "");
      const matchesSegment = name === head || /^\[[^\]]+\]$/.test(name);
      if (e.isDirectory()) return e.name === head || /^\[[^\]]+\]$/.test(e.name) ? walk(join(dir, e.name), tail) : false;
      return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && tail.length === 0 && matchesSegment;
    });
  };
  return walk(ROUTES, segments);
}

describe("the icon, touch icon and manifest links in every page", () => {
  it("covers every page: the public pages and all the admin pages", () => {
    expect(PAGES).toEqual([
      "admin/edit.html", "admin/index.html", "admin/login.html", "admin/new.html", "admin/schedule.html", "admin/settings.html", "admin/templates.html",
      "event.html", "index.html", "recover.html", "setup.html",
    ]);
  });

  describe.each(PAGES)("%s", (page) => {
    const html = readFileSync(join(PUBLIC, page), "utf8");
    const all = links(html);
    const admin = page.startsWith("admin/");

    it("has exactly one icon, one apple-touch-icon and one manifest link, with these attributes", () => {
      expect(all.filter((l) => l.rel === "icon")).toEqual([{ rel: "icon", type: "image/png", sizes: "32x32", href: "/api/icon/32" }]);
      expect(all.filter((l) => l.rel === "apple-touch-icon")).toEqual([{ rel: "apple-touch-icon", href: "/api/icon/180" }]);
      expect(all.filter((l) => l.rel === "manifest")).toEqual([
        { rel: "manifest", href: admin ? "/api/manifest.webmanifest?for=admin" : "/api/manifest.webmanifest" },
      ]);
    });

    it("has no static SVG icon (browsers would prefer it to the generated PNG icon, and branding.js adds none either)", () => {
      expect(html).not.toMatch(/image\/svg\+xml|\.svg/);
    });

    it("no longer uses the logo as the page icon", () => {
      for (const l of all) if (/\bicon\b/.test(l.rel ?? "")) expect(l.href).not.toMatch(/\/api\/logo/);
      expect(html).not.toMatch(/rel="[^"]*icon[^"]*"[^>]*\/api\/logo/);
    });

    it("links only paths that something serves", () => {
      for (const l of all.filter((x) => /icon|manifest/.test(x.rel ?? ""))) {
        expect(isServed(new URL(l.href, "http://localhost").pathname), l.href).toBe(true);
      }
    });
  });

  it("the CSP lets the page load its manifest and icons from its own origin (default-src is 'none', so each needs its own source)", () => {
    const csp = readFileSync(join(PUBLIC, "_headers"), "utf8").match(/Content-Security-Policy: (.*)/)![1];
    const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
    expect(directive("default-src")).toBe("default-src 'none'");
    expect(directive("manifest-src")).toBe("manifest-src 'self'");
    expect(directive("img-src")).toBe("img-src 'self' data:");
  });

  it("the path check itself can tell a served path from an unserved one", () => {
    expect(isServed("/api/icon/32")).toBe(true);
    expect(isServed("/api/icon/32/extra")).toBe(false);
    expect(isServed("/api/manifest.webmanifest")).toBe(true);
    expect(isServed("/favicon.ico")).toBe(true);
    expect(isServed("/icons/default.svg")).toBe(true);
    expect(isServed("/api/logo")).toBe(true);
    expect(isServed("/api/nothing-here")).toBe(false);
    expect(isServed("/api/icons/32")).toBe(false);
  });
});

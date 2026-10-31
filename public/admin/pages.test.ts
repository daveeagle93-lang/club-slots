import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every static admin page: the navigation between them, and the stylesheet and script each one needs.

const DIR = import.meta.dirname;
const pages = readdirSync(DIR).filter((f) => f.endsWith(".html")).sort();
const SCRIPT: Record<string, string> = {
  "edit.html": "edit.js", "index.html": "list.js", "login.html": "login.js", "new.html": "new.js",
  "schedule.html": "schedule.js", "settings.html": "settings.js", "templates.html": "templates.js",
};
const EVENTS_PAGES = ["index.html", "new.html", "edit.html", "schedule.html"];
const NAV = [["/admin/", "Events"], ["/admin/templates", "Templates"], ["/admin/settings", "Settings"]];

const read = (page: string) => readFileSync(join(DIR, page), "utf8");
const navOf = (html: string) => /<nav\b[^>]*class="admin-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
const linksIn = (nav: string) => [...nav.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map(([, attrs, label]) => ({
  href: /href="([^"]*)"/.exec(attrs)![1], current: /aria-current="([^"]*)"/.exec(attrs)?.[1] ?? null, label,
}));

describe("the admin pages", () => {
  it("are the seven expected files", () => {
    expect(pages).toEqual(Object.keys(SCRIPT).sort());
  });

  describe.each(pages.filter((p) => p !== "login.html"))("%s", (page) => {
    const html = read(page);

    it("has the Admin navigation with Events, Templates and Settings, in that order", () => {
      const nav = navOf(html);
      expect(nav, "nav.admin-nav").not.toBeNull();
      expect(html.match(/<nav\b/g)).toHaveLength(1);
      expect(nav![0]).toContain('aria-label="Admin"');
      expect(linksIn(nav![1]).map((l) => [l.href, l.label])).toEqual(NAV);
    });

    it("marks only the current page with aria-current", () => {
      const current = EVENTS_PAGES.includes(page) ? "/admin/" : page === "templates.html" ? "/admin/templates" : "/admin/settings";
      const marked = linksIn(navOf(html)![1]).filter((l) => l.current !== null);
      // The Events link is the page itself on the list, and only the section it belongs to on the pages reached from it.
      expect(marked.map((l) => [l.href, l.current])).toEqual([[current, page === "index.html" || !EVENTS_PAGES.includes(page) ? "page" : "true"]]);
    });

    it("puts the navigation inside <body>, before <main>", () => {
      const body = html.slice(html.indexOf("<body>"));
      expect(body.indexOf('<nav class="admin-nav"')).toBeGreaterThan(-1);
      expect(body.indexOf('<nav class="admin-nav"')).toBeLessThan(body.indexOf("<main"));
    });

    it("links the shared and admin stylesheets, the theme, and its own script", () => {
      for (const href of ["/style.css", "/admin/admin.css", "/api/theme.css"]) expect(html).toContain(`<link rel="stylesheet" href="${href}" />`);
      expect(html).toContain(`<script type="module" src="/admin/${SCRIPT[page]}"></script>`);
      expect(existsSync(join(DIR, SCRIPT[page]))).toBe(true);
      expect(existsSync(join(DIR, "admin.css"))).toBe(true);
    });

    it("starts its script from <main id=app data-autostart>", () => {
      expect(html).toMatch(/<main id="app" class="admin" data-autostart>/);
    });
  });

  describe("login.html", () => {
    const html = read("login.html");

    it("has no navigation", () => {
      expect(navOf(html)).toBeNull();
      expect(html).not.toContain("<nav");
      expect(html).not.toContain("/admin/templates");
    });

    it("keeps its own script and the shared stylesheet", () => {
      expect(html).toContain('<script type="module" src="/admin/login.js"></script>');
      expect(html).toContain('<link rel="stylesheet" href="/style.css" />');
    });
  });
});

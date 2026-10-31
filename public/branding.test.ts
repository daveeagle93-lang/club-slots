// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBranding, brandPage, loadSettings, pageTitle, safeWebsite } from "./branding.js";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const asFetch = (fn: unknown) => fn as typeof globalThis.fetch;
const ALL = {
  clubName: "Barkside Agility", website: "https://barkside.example/club",
  privacyContact: { name: "Ann Lee", email: "ann@barkside.example" },
  logo: { url: "/api/logo?v=0123456789abcdef", width: 120, height: 60 },
};

afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

describe("loadSettings", () => {
  it("returns the settings, fetched uncached", async () => {
    const fetch = vi.fn(async () => reply(200, ALL));
    expect(await loadSettings(asFetch(fetch))).toEqual({ ...ALL, loaded: true });
    expect(fetch).toHaveBeenCalledWith("/api/settings", { cache: "no-store" });
  });

  it("gives the all-null defaults, marked not loaded, on a network, HTTP or JSON failure", async () => {
    const none = { clubName: null, website: null, privacyContact: null, logo: null, loaded: false };
    expect(await loadSettings(asFetch(async () => { throw new TypeError("offline"); }))).toEqual(none);
    expect(await loadSettings(asFetch(async () => reply(500, {})))).toEqual(none);
    expect(await loadSettings(asFetch(async () => new Response("<html>", { status: 200 })))).toEqual(none);
  });

  it("treats a loaded but empty answer as loaded with nothing set", async () => {
    const nulls = { clubName: null, website: null, privacyContact: null, logo: null };
    expect(await loadSettings(asFetch(async () => reply(200, nulls)))).toEqual({ ...nulls, loaded: true });
    expect(await loadSettings(asFetch(async () => reply(200, null)))).toEqual({ ...nulls, loaded: true });
  });

  it("drops malformed parts instead of passing them on", async () => {
    const s = await loadSettings(asFetch(async () => reply(200, {
      clubName: 5, website: "", privacyContact: { name: "x", email: "" },
      logo: { url: "//evil.example/x.png", width: 10, height: 10 },
    })));
    expect(s).toEqual({ clubName: null, website: null, privacyContact: null, logo: null, loaded: true });
    const bad = [
      "/\t/evil.example/x.png", "/\n/evil.example", "//evil.example/x.png", "/\\evil", "https://evil/x", "/evil.png",
      "/api/logo", "/api/logo?v=0123456789abcde", "/api/logo?v=0123456789abcdef0", "/api/logo?v=0123456789ABCDEF",
      "/api/logo?v=0123456789abcdef\n", "api/logo", "javascript:alert(1)",
    ];
    for (const url of bad) {
      const r = await loadSettings(asFetch(async () => reply(200, { logo: { url, width: 10, height: 10 } })));
      expect(r.logo, url).toBeNull();
    }
    const sizes = await loadSettings(asFetch(async () => reply(200, { logo: { url: "/api/logo", width: 0, height: 1.5 } })));
    expect(sizes.logo).toBeNull();
  });

  it("keeps the exact logo url the server builds", async () => {
    const url = "/api/logo?v=0123456789abcdef";
    const s = await loadSettings(asFetch(async () => reply(200, { logo: { url, width: 10, height: 5 } })));
    expect(s.logo).toEqual({ url, width: 10, height: 5 });
  });
});

describe("pageTitle", () => {
  it("joins page and club, or falls back", () => {
    expect(pageTitle("Events", "Barkside")).toBe("Events – Barkside");
    expect(pageTitle("Events", null)).toBe("Events");
    expect(pageTitle(null, "Barkside")).toBe("Barkside");
    expect(pageTitle(null, null)).toBe("Slot booker");
  });
});

describe("safeWebsite", () => {
  it("accepts https only", () => {
    expect(safeWebsite("https://club.example/a")?.hostname).toBe("club.example");
    for (const bad of ["http://club.example", "javascript:alert(1)", "data:text/html,x", "//club.example", "nonsense", ""]) {
      expect(safeWebsite(bad), bad).toBeNull();
    }
  });
});

describe("applyBranding", () => {
  const setup = () => { document.body.innerHTML = '<main id="app"></main>'; };

  it("puts the header with logo and club link before main, and sets the title", () => {
    setup();
    applyBranding(document, { ...ALL, website: null }, { pageTitle: "Events", home: "/admin/" });
    const header = document.body.firstElementChild!;
    expect(header.tagName).toBe("HEADER");
    expect(header.className).toBe("site-header");
    expect(header.nextElementSibling!.id).toBe("app");
    const img = header.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/logo?v=0123456789abcdef");
    expect(img.getAttribute("width")).toBe("120");
    expect(img.getAttribute("height")).toBe("60");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.className).toBe("site-logo");
    const link = header.querySelector("a")!;
    expect(link.textContent).toBe("Barkside Agility");
    expect(link.getAttribute("href")).toBe("/admin/");
    expect(document.title).toBe("Events – Barkside Agility");
    expect(document.querySelector("footer")).toBeNull();
  });

  it("puts the header first in the body, above an admin nav that sits before main", () => {
    document.body.innerHTML = '<nav class="admin-nav"></nav><main id="app"></main>';
    applyBranding(document, { ...ALL, website: null }, { pageTitle: "Events", home: "/admin/" });
    expect([...document.body.children].map((n) => n.tagName)).toEqual(["HEADER", "NAV", "MAIN"]);
  });

  it("uses the default name, no image and the page title alone when nothing is set", () => {
    setup();
    applyBranding(document, null, { pageTitle: "Events", home: "/" });
    expect(document.querySelector(".site-header a")!.textContent).toBe("Slot booker");
    expect(document.querySelector("img")).toBeNull();
    expect(document.title).toBe("Events");
  });

  it("adds a footer link to the website showing its hostname", () => {
    setup();
    applyBranding(document, ALL, { pageTitle: "x", home: "/" });
    const a = document.querySelector<HTMLAnchorElement>("footer.site-footer a")!;
    expect(a.textContent).toBe("barkside.example");
    expect(a.getAttribute("href")).toBe("https://barkside.example/club");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("re-checks the website and never uses a non-https one", () => {
    for (const website of ["javascript:alert(1)", "http://club.example", "not a url"]) {
      setup();
      applyBranding(document, { ...ALL, website }, { pageTitle: "x", home: "/" });
      expect(document.querySelector("footer"), website).toBeNull();
      document.body.innerHTML = "";
    }
  });

  it("treats markup in the club name as text", () => {
    setup();
    applyBranding(document, { ...ALL, clubName: "<img src=x onerror=alert(1)>" }, { pageTitle: null, home: "/" });
    expect(document.querySelectorAll("img")).toHaveLength(1); // the logo only
    expect(document.querySelector(".site-header a")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("the page icon links", () => {
  const setup = () => {
    document.head.innerHTML = '<link rel="icon" type="image/png" sizes="32x32" href="/api/icon/32" />';
    document.body.innerHTML = '<main id="app"></main>';
  };
  const icons = () => [...document.head.querySelectorAll("link[rel~='icon']")].map((l) => [l.getAttribute("type"), l.getAttribute("href")]);
  const opts = { pageTitle: "x", home: "/" };
  const PNG_ONLY = [["image/png", "/api/icon/32"]];

  it("adds no SVG icon, with or without a logo, so the generated PNG is the one the browser uses", () => {
    for (const settings of [{ clubName: null, website: null, privacyContact: null, logo: null, loaded: true }, { ...ALL, loaded: true }]) {
      setup();
      applyBranding(document, settings as never, opts);
      expect(icons()).toEqual(PNG_ONLY);
    }
  });

  it("adds none when the settings could not be loaded, or through brandPage", async () => {
    setup();
    applyBranding(document, await loadSettings(async () => { throw new TypeError("offline"); }), opts);
    applyBranding(document, null, opts);
    expect(icons()).toEqual(PNG_ONLY);
    setup();
    await brandPage(document, loadSettings(asFetch(async () => reply(200, { ...ALL, logo: null }))), opts);
    expect(icons()).toEqual(PNG_ONLY);
  });

  it("no longer exports setDefaultIconLink", async () => {
    expect(await import("./branding.js")).not.toHaveProperty("setDefaultIconLink");
  });
});

describe("brandPage", () => {
  it("brands once the settings arrive and resolves to them", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const s = await brandPage(document, Promise.resolve(ALL), { pageTitle: "Events", home: "/" });
    expect(s).toBe(ALL);
    expect(document.querySelectorAll("header")).toHaveLength(1);
  });

  it("never rejects", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    expect(await brandPage(document, Promise.reject(new Error("no")), { pageTitle: "Events", home: "/" })).toBeNull();
    expect(document.querySelector("header")).toBeNull();
  });
});

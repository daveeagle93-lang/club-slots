import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pageTitle } from "../../public/branding.js";
import { ageWindow } from "../server/auth/test-harness";
import type { AppEnv } from "../server/env";
import { saveSettings } from "../server/settings";
import { insertBooking, insertBreak, insertEvent, createTestEnv, type TestEnv } from "../test/db";
import { PAGE_ETAG, pageAssets } from "../test/assets";
import { createWorker } from "../worker";
import { SECURITY_HEADERS } from "./headers";
import { formatLondonDate } from "./open-graph";

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  await ageWindow(t.env.DB, 31 * 60_000); // the first-run claim window is over, so GET / is the landing page and not a redirect to /setup
});
afterAll(async () => { await t.dispose(); });
afterEach(() => { vi.restoreAllMocks(); });

const worker = createWorker();
const PUBLIC_DIR = join(import.meta.dirname, "../../public");
const ORIGIN = "https://club.example";

const setClub = (clubName: string) =>
  saveSettings(t.env.DB, { clubName, privacyContact: { name: "Pat Contact", email: "pat.contact@example.org" }, website: "" });

const envWith = (assets = pageAssets()): AppEnv & { ASSETS: Fetcher & { requests: Request[] } } => ({ DB: t.env.DB, ASSETS: assets });
const get = (path: string, init: RequestInit = {}, env: AppEnv = envWith(), origin = ORIGIN) => worker.fetch(new Request(`${origin}${path}`, init), env);

/** The page the way a browser parses it: what the title and each tag really say, whatever the escaping. */
function parse(html: string) {
  const doc = new (new Window().DOMParser)().parseFromString(html, "text/html");
  const tag = (property: string) => doc.querySelectorAll(`meta[property="${property}"], meta[name="${property}"]`);
  const one = (property: string): string | null => {
    const found = tag(property);
    expect(found.length, `${property} appears at most once`).toBeLessThanOrEqual(1);
    return found[0]?.getAttribute("content") ?? null;
  };
  return {
    doc,
    title: doc.querySelector("title")?.textContent ?? null,
    titles: doc.querySelectorAll("title").length,
    scripts: doc.querySelectorAll("script").length,
    ogTitle: one("og:title"), ogDescription: one("og:description"), ogImage: one("og:image"), siteName: one("og:site_name"),
    ogUrl: one("og:url"), ogType: one("og:type"), twitterCard: one("twitter:card"), one,
  };
}

const page = async (path: string, club: string | null, init?: RequestInit, origin?: string) => {
  await setClub(club ?? "");
  const res = await get(path, init, envWith(), origin);
  return { res, html: await res.text() };
};

describe("formatLondonDate", () => {
  it.each([
    ["2026-06-13T08:00:00Z", "Sat 13 Jun 2026"],
    // London is on GMT until 01:00 UTC on 2026-03-29, then BST: 23:30Z on the 28th is still the 28th, 23:30Z on the 29th is 00:30 on the 30th.
    ["2026-03-28T23:30:00Z", "Sat 28 Mar 2026"],
    ["2026-03-29T00:30:00Z", "Sun 29 Mar 2026"],
    ["2026-03-29T23:30:00Z", "Mon 30 Mar 2026"],
    // And back on 2026-10-25 at 01:00 UTC.
    ["2026-10-24T23:30:00Z", "Sun 25 Oct 2026"],
    ["2026-10-25T23:30:00Z", "Sun 25 Oct 2026"],
    ["2026-10-26T00:00:00Z", "Mon 26 Oct 2026"],
    // The tests run in Pacific/Auckland, where this instant is already Sunday the 14th.
    ["2026-06-13T22:30:00Z", "Sat 13 Jun 2026"],
  ])("%s is %s", (iso, expected) => { expect(formatLondonDate(iso)).toBe(expected); });
});

describe("the event page", () => {
  it("has the event's title, date, club, venue and cost, and an absolute icon", async () => {
    const { slug } = await insertEvent(t.env.DB, { slug: "spring-fun0000000000", name: "Spring Fun Day", startUtc: "2026-03-29T23:30:00Z", endUtc: "2026-03-30T02:30:00Z", costPence: 1250, venuePostcode: "AB1 2CD" });
    const { res, html } = await page(`/e/${slug}`, "Example Dog Club");
    expect(res.status).toBe(200);
    const p = parse(html);
    expect(p.titles).toBe(1);
    expect(p.title).toBe(pageTitle("Spring Fun Day", "Example Dog Club"));
    expect(p.title).toBe("Spring Fun Day – Example Dog Club");
    expect(p.ogTitle).toBe("Spring Fun Day · Mon 30 Mar 2026");
    expect(p.ogDescription).toBe("Example Dog Club · AB1 2CD · £12.50");
    expect(p.siteName).toBe("Example Dog Club");
    expect(p.ogType).toBe("website");
    expect(p.ogUrl).toBe(`${ORIGIN}/e/spring-fun0000000000`);
    expect(p.ogImage).toBe(`${ORIGIN}/api/icon/512`);
    expect(p.one("og:image:width")).toBe("512");
    expect(p.one("og:image:height")).toBe("512");
    expect(p.one("og:image:type")).toBe("image/png");
    expect(p.twitterCard).toBe("summary");
  });

  it("has no club name parts when none is set, and says Free for a free event", async () => {
    const { slug } = await insertEvent(t.env.DB, { slug: "free-one000000000000", name: "Free Fun", costPence: 0, venuePostcode: "ZZ9 9ZZ" });
    const { html } = await page(`/e/${slug}`, null);
    const p = parse(html);
    expect(p.title).toBe(pageTitle("Free Fun", null));
    expect(p.title).toBe("Free Fun");
    expect(p.ogTitle).toBe("Free Fun · Sat 13 Jun 2026");
    expect(p.ogDescription).toBe("ZZ9 9ZZ · Free");
    expect(p.siteName).toBeNull();
  });

  it("uses the request's origin and scheme for the absolute URLs", async () => {
    const { slug } = await insertEvent(t.env.DB, { slug: "where-am-i0000000000" });
    const { html } = await page(`/e/${slug}?utm=x#frag`, "Club", undefined, "http://localhost:8787");
    const p = parse(html);
    expect(p.ogImage).toBe("http://localhost:8787/api/icon/512");
    expect(p.ogUrl).toBe("http://localhost:8787/e/where-am-i0000000000");
  });

  it("builds og:url from the stored slug, not the request path: a percent-encoded spelling is not echoed", async () => {
    await insertEvent(t.env.DB, { slug: "encoded-url0000000000", name: "Encoded Url" });
    for (const path of ["/e/encoded%2Durl0000000000", "/e/%65ncoded-url0000000000?x=%2F", "/e/encoded-url0000000000/"]) {
      const { res, html } = await page(path, "Club");
      expect(res.status, path).toBe(200);
      const p = parse(html);
      expect(p.ogTitle, path).toMatch(/^Encoded Url · /);
      expect(p.ogUrl, path).toBe(`${ORIGIN}/e/encoded-url0000000000`);
      expect(html, path).not.toContain("%2D");
      expect(html, path).not.toContain("%65");
    }
  });

  it("keeps everything else in the static page, and replaces its title rather than adding one", async () => {
    const { slug } = await insertEvent(t.env.DB, { slug: "keep-rest00000000000" });
    const { html } = await page(`/e/${slug}`, "Club");
    const original = readFileSync(join(PUBLIC_DIR, "event.html"), "utf8");
    for (const line of original.split("\n").map((l) => l.trim()).filter((l) => l && !l.includes("<title>"))) expect(html).toContain(line);
    expect(parse(html).titles).toBe(1);
    expect(parse(html).scripts).toBe(1);
  });

  it("exposes nothing beyond the public summary: no details, break labels, booking names, ids or privacy contact", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { slug: "no-leaks000000000000", details: "SECRET-DETAILS-TEXT", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T11:00:00Z" });
    await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z", "SECRET-BREAK-LABEL");
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "SECRETDOG", "SECRETHANDLER");
    const { html } = await page(`/e/${slug}`, "Club");
    for (const secret of ["SECRET-DETAILS-TEXT", "SECRET-BREAK-LABEL", "SECRETDOG", "SECRETHANDLER", "pat.contact@example.org", "Pat Contact"]) {
      expect(html, secret).not.toContain(secret);
    }
  });

  it("is a 200 HTML page without the asset's ETag, with no-cache, and with the security headers", async () => {
    const { slug } = await insertEvent(t.env.DB, { slug: "headers-ok0000000000" });
    const { res } = await page(`/e/${slug}`, "Club");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Last-Modified")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    for (const name of Object.keys(SECURITY_HEADERS)) expect(res.headers.get(name), name).not.toBeNull();
  });

  it("does not pass conditional or range headers on: the asset's ETag in If-None-Match still gets the full injected page", async () => {
    const { slug } = await insertEvent(t.env.DB, { slug: "conditional000000000", name: "Conditional Event" });
    await setClub("Club");
    const assets = pageAssets();
    const res = await get(`/e/${slug}`, { headers: { "If-None-Match": PAGE_ETAG, "If-Modified-Since": "Wed, 01 Jan 2031 00:00:00 GMT", Range: "bytes=0-10", "Accept-Language": "en-GB", Cookie: "a=b" } }, envWith(assets));
    expect(res.status).toBe(200);
    expect(parse(await res.text()).ogTitle).toMatch(/^Conditional Event · /);
    expect(assets.requests).toHaveLength(1);
    const sent = assets.requests[0];
    expect(new URL(sent.url).pathname).toBe("/event");
    expect(sent.method).toBe("GET");
    for (const h of ["If-None-Match", "If-Modified-Since", "If-Match", "If-Unmodified-Since", "If-Range", "Range", "Cookie"]) expect(sent.headers.get(h), h).toBeNull();
  });

  it("HEAD gives the headers and no body, without asking the database", async () => {
    const { slug } = await insertEvent(t.env.DB, { slug: "head-req000000000000" });
    const noDb = new Proxy({}, { get: (_t, key) => { throw new Error(`The database was used (${String(key)})`); } }) as D1Database;
    const res = await get(`/e/${slug}`, { method: "HEAD" }, { DB: noDb, ASSETS: pageAssets() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await res.text()).toBe("");
  });
});

describe("escaping", () => {
  const HOSTILE = [
    ['"><script>alert(1)</script>', "quote-and-tag"],
    ["</title><script>alert(1)</script>", "closing-title"],
    ["Tom &amp; Jerry &lt;b&gt; & more", "entities"],
    ["O'Brien's \"quoted\" <b>bold</b>", "quotes"],
    ["Dogs 🐕‍🦺 and 🎉 ☃", "emoji"],
    ["$& $1 $` $' $$", "replacement-patterns"],
    ["x".repeat(80), "eighty-chars"],
    ["a\\b</style><!-- c -->", "backslash-comment"],
  ] as const;

  for (const [hostile, label] of HOSTILE) {
    it(`event name ${label} is shown as text and nothing else`, async () => {
      const { slug } = await insertEvent(t.env.DB, { slug: `esc-${label}`.padEnd(20, "0"), name: hostile, venuePostcode: "AB1 2CD" });
      const { html } = await page(`/e/${slug}`, "Club");
      const p = parse(html);
      expect(p.title).toBe(`${hostile} – Club`);
      expect(p.ogTitle).toBe(`${hostile} · Sat 13 Jun 2026`);
      expect(p.scripts).toBe(1);
      expect(p.titles).toBe(1);
      expect(p.doc.querySelectorAll("head > meta").length).toBeGreaterThan(8);
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("<b>bold</b>");
    });

    it(`club name ${label} is shown as text and nothing else, on the event page and the landing page`, async () => {
      const { slug } = await insertEvent(t.env.DB, { slug: `escc-${label}`.padEnd(20, "0"), name: "Plain Event", venuePostcode: "P1 1PP" });
      for (const path of [`/e/${slug}`, "/", "/e/does-not-exist000000"]) {
        const { html } = await page(path, hostile);
        const p = parse(html);
        expect(p.scripts, path).toBe(1);
        expect(p.titles, path).toBe(1);
        expect(p.siteName, path).toBe(hostile);
        expect(p.title, path).toContain(hostile);
        if (path === "/e/does-not-exist000000" || path === "/") expect(p.ogTitle, path).toBe(hostile);
        else expect(p.ogDescription, path).toBe(`${hostile} · P1 1PP · £12.50`);
        expect(html, path).not.toContain("<script>alert");
        expect(html, path).not.toContain("<b>bold</b>");
      }
    });
  }
});

describe("the landing page", () => {
  it("has the club name in the title, the og tags and a short generic description", async () => {
    const { res, html } = await page("/", "Example Dog Club");
    expect(res.status).toBe(200);
    const p = parse(html);
    expect(p.title).toBe(pageTitle(null, "Example Dog Club"));
    expect(p.ogTitle).toBe("Example Dog Club");
    expect(p.ogDescription).toBe("Book a slot at Example Dog Club's upcoming events.");
    expect(p.siteName).toBe("Example Dog Club");
    expect(p.ogType).toBe("website");
    expect(p.ogUrl).toBe(`${ORIGIN}/`);
    expect(p.ogImage).toBe(`${ORIGIN}/api/icon/512`);
    expect(p.twitterCard).toBe("summary");
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Content-Security-Policy")).not.toBeNull();
  });

  it("uses the default name and a description without a club when none is set", async () => {
    const { html } = await page("/", null);
    const p = parse(html);
    expect(p.title).toBe("Slot booker");
    expect(p.ogTitle).toBe("Slot booker");
    expect(p.ogDescription).toBe("Book a slot at upcoming events.");
    expect(p.siteName).toBeNull();
  });

  it("carries no event data even when events exist, and ignores conditional headers", async () => {
    await insertEvent(t.env.DB, { slug: "landing-ev0000000000", name: "LANDING-EVENT-NAME", details: "LANDING-DETAILS", venuePostcode: "LL1 1LL" });
    await setClub("Club");
    const assets = pageAssets();
    const res = await get("/", { headers: { "If-None-Match": PAGE_ETAG } }, envWith(assets));
    const html = await res.text();
    expect(res.status).toBe(200);
    for (const s of ["LANDING-EVENT-NAME", "LANDING-DETAILS", "LL1 1LL"]) expect(html).not.toContain(s);
    expect(assets.requests.map((r) => new URL(r.url).pathname)).toEqual(["/"]);
  });

  it("HEAD gives headers and no body", async () => {
    const res = await get("/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("unknown, invalid and archived events", () => {
  it("get one and the same generic page, with no event data and status 200", async () => {
    await insertEvent(t.env.DB, { slug: "was-archived00000000", name: "ARCHIVED-EVENT-NAME", details: "ARCHIVED-DETAILS", venuePostcode: "AR1 1AR", archived: true });
    await setClub("Example Dog Club");
    const paths = ["/e/never-existed0000000", "/e/was-archived00000000", "/e/bad%20slug", "/e/x.y", "/e/short", `/e/${"a".repeat(200)}`];
    const bodies: string[] = [];
    for (const path of paths) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("ETag"), path).toBeNull();
      expect(res.headers.get("Cache-Control"), path).toBe("no-cache");
      bodies.push(await res.text());
    }
    for (const [i, body] of bodies.entries()) expect(body, paths[i]).toBe(bodies[0]);
    const p = parse(bodies[0]);
    expect(p.title).toBe(pageTitle("Book a slot", "Example Dog Club"));
    expect(p.ogTitle).toBe("Example Dog Club");
    expect(p.ogDescription).toBe("Book a slot at Example Dog Club's upcoming events.");
    expect(p.ogImage).toBe(`${ORIGIN}/api/icon/512`);
    expect(p.ogUrl).toBe(`${ORIGIN}/`);
    for (const s of ["ARCHIVED-EVENT-NAME", "ARCHIVED-DETAILS", "AR1 1AR", "was-archived", "never-existed"]) expect(bodies[0]).not.toContain(s);
  });

  it("get that same page for the other paths under /e/ too (/e/x/, /e/a/b, /e//), and /e/<archived slug>/ is generic as well", async () => {
    await insertEvent(t.env.DB, { slug: "archived-slash000000", name: "ARCHIVED-SLASH-NAME", archived: true });
    await setClub("Example Dog Club");
    const expected = await (await get("/e/never-existed0000000")).text();
    for (const path of ["/e/x/", "/e/a/b", "/e/a/b/c/", "/e//", "/e/archived-slash000000/", "/e/bad%zz/", "/e/%E0%A4%A/", "/e/never-existed0000000/more"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(expected);
    }
  });

  it("gives /e/<slug>/ (one trailing slash) that event's tags", async () => {
    await insertEvent(t.env.DB, { slug: "slash-event00000000", name: "Slash Event", venuePostcode: "SL1 1SL" });
    await setClub("Example Dog Club");
    const plain = parse(await (await get("/e/slash-event00000000")).text());
    const slashed = await get("/e/slash-event00000000/");
    expect(slashed.status).toBe(200);
    const p = parse(await slashed.text());
    expect(p.ogTitle).toMatch(/^Slash Event · /);
    expect(p.ogUrl).toBe(`${ORIGIN}/e/slash-event00000000`);
    expect(p.title).toBe(plain.title);
    expect(p.ogDescription).toBe(plain.ogDescription);
    expect((await get("/e/slash-event00000000/", { method: "HEAD" })).status).toBe(200);
  });

  it("have the plain default title when no club name is set", async () => {
    await setClub("");
    const res = await get("/e/never-existed0000000");
    const p = parse(await res.text());
    expect(p.title).toBe("Book a slot");
    expect(p.ogTitle).toBe("Slot booker");
    expect(p.ogDescription).toBe("Book a slot at upcoming events.");
  });
});

describe("when the database fails", () => {
  const failing = (message: string) => ({
    prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error(message)), all: () => Promise.reject(new Error(message)) }), first: () => Promise.reject(new Error(message)), all: () => Promise.reject(new Error(message)) }),
    batch: () => Promise.reject(new Error(message)),
  }) as unknown as D1Database;

  it("serves the generic page with status 200 and logs only the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await insertEvent(t.env.DB, { slug: "db-down0000000000000", name: "DB-DOWN-NAME" });
    const res = await get("/e/db-down0000000000000", {}, { DB: failing("D1_ERROR: boom"), ASSETS: pageAssets() });
    expect(res.status).toBe(200);
    const p = parse(await res.text());
    expect(p.title).toBe("Book a slot");
    expect(p.ogTitle).toBe("Slot booker");
    expect(p.ogImage).toBe(`${ORIGIN}/api/icon/512`);
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      expect(call.every((a) => typeof a === "string")).toBe(true);
      expect(call.join(" ")).toContain("D1_ERROR: boom");
    }
  });

  it("does the same for the landing page and when the DB binding is missing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await get("/", {}, { DB: failing("nope"), ASSETS: pageAssets() });
    expect(a.status).toBe(200);
    expect(parse(await a.text()).ogTitle).toBe("Slot booker");
    const b = await get("/e/anything-0000000000000", {}, { ASSETS: pageAssets() } as unknown as AppEnv);
    expect(b.status).toBe(200);
    expect(parse(await b.text()).title).toBe("Book a slot");
    expect(spy.mock.calls.every((call) => call.every((arg) => typeof arg === "string"))).toBe(true);
  });

  it("passes the asset's own answer through when it is not a page (here a 404)", async () => {
    const res = await get("/", {}, { DB: t.env.DB, ASSETS: { fetch: async () => new Response("gone", { status: 404 }) } as unknown as Fetcher });
    expect(res.status).toBe(404);
  });
});

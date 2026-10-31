// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "./landing.js";

const SLUG = "abcdefghijklmnop";
const EVENT = { slug: SLUG, name: "Trial Day", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T15:00:00Z" };
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const SETTINGS = { clubName: "Barkside Agility", website: null, privacyContact: null, logo: null, loaded: true };

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

async function start(handler: Handler, settings?: unknown) {
  document.body.innerHTML = '<main id="app"></main>';
  const fetch = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  await init({ document, fetch: fetch as unknown as typeof globalThis.fetch, settings: (settings === undefined ? null : Promise.resolve(settings)) as never });
  return fetch;
}

const text = () => document.body.textContent ?? "";
const links = () => [...document.querySelectorAll<HTMLAnchorElement>("main a")];

afterEach(() => { document.title = ""; document.body.innerHTML = ""; });

describe("landing page", () => {
  it("lists upcoming events as links to their booking pages, with London date and time", async () => {
    const fetch = await start(() => reply(200, { events: [EVENT] }), SETTINGS);
    expect(fetch).toHaveBeenCalledWith("/api/events", { cache: "no-store" });
    // The header band carries the club name, so it isn't repeated as the heading.
    expect(document.querySelector("h1")!.textContent).toBe("Upcoming events");
    expect(document.querySelector("header.site-header")!.textContent).toBe("Barkside Agility");
    expect(document.querySelectorAll("h1, h2")).toHaveLength(1);
    expect(links()).toHaveLength(1);
    expect(links()[0].getAttribute("href")).toBe(`/e/${SLUG}`);
    expect(links()[0].textContent).toContain("Trial Day");
    expect(links()[0].textContent).toContain("Saturday 13 June 2026, 09:00–16:00");
  });

  it("titles the page with the club name, and falls back to Slot booker", async () => {
    await start(() => reply(200, { events: [] }), SETTINGS);
    expect(document.title).toBe("Barkside Agility");
    await start(() => reply(200, { events: [] }), { ...SETTINGS, clubName: null });
    expect(document.title).toBe("Slot booker");
    expect(document.querySelector("header.site-header")!.textContent).toBe("Slot booker");
  });

  it("still has the Upcoming events heading when there are no settings at all", async () => {
    await start(() => reply(200, { events: [EVENT] }));
    expect(document.querySelector("h1")!.textContent).toBe("Upcoming events");
    expect(document.querySelector("header")).toBeNull();
  });

  it("shows the empty state", async () => {
    await start(() => reply(200, { events: [] }), SETTINGS);
    expect(document.querySelector("h1")!.textContent).toBe("Upcoming events");
    expect(text()).toContain("No events are open for booking right now.");
    expect(links().filter((a) => a.getAttribute("href")!.startsWith("/e/"))).toHaveLength(0);
  });

  it("only links slugs the booking page accepts, and skips events it can't show", async () => {
    await start(() => reply(200, {
      events: [
        EVENT,
        { ...EVENT, slug: "../admin", name: "Bad slug" },
        { ...EVENT, slug: "a/b", name: "Slash" },
        { ...EVENT, slug: 'x" onclick="y', name: "Quote" },
        { ...EVENT, slug: null, name: "Null slug" },
        { ...EVENT, slug: "okslug", name: "Bad time", startUtc: "nonsense" },
      ],
    }), SETTINGS);
    expect(links().map((a) => a.getAttribute("href"))).toEqual([`/e/${SLUG}`]);
    expect(text()).not.toContain("Bad slug");
  });

  it("shows names as text, never as markup", async () => {
    await start(() => reply(200, { events: [{ ...EVENT, name: "<img src=x onerror=alert(1)>" }] }), SETTINGS);
    expect(document.querySelector("main img")).toBeNull();
    expect(links()[0].textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("shows nothing but the club name, the heading and the events", async () => {
    await start(() => reply(200, { events: [EVENT] }), SETTINGS);
    const hrefs = links().map((a) => a.getAttribute("href"));
    expect(hrefs.every((h) => h!.startsWith("/e/") || h === "/")).toBe(true);
    expect(document.documentElement.innerHTML).not.toContain("/admin");
  });

  it.each([
    ["a network error", () => { throw new TypeError("offline"); }],
    ["an HTTP error", () => reply(500, {})],
    ["a malformed body", () => reply(200, { nope: true })],
  ])("shows an error with Retry after %s, and Retry loads again", async (_name, fail) => {
    let broken = true;
    await start((url) => {
      if (broken) return (fail as () => Response)();
      return reply(200, { events: [EVENT] });
    }, SETTINGS);
    expect(text()).toContain("couldn't load the events");
    expect(document.querySelector("h1")!.textContent).toBe("Upcoming events");
    broken = false;
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(links()).toHaveLength(1));
    expect(text()).not.toContain("couldn't load");
  });
});

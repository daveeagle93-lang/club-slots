// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "./list.js";

const reply = (status: number, body: unknown = null) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const SESSION = { identity: "ann@example.com", provider: "password", csrfToken: "tok" };
const EVENT = {
  slug: "abc123", name: "Trial Day", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T15:00:00Z", costPence: 1500,
  venuePostcode: "SW1A 1AA", slotCount: 12, bookedCount: 3, bookings: { open: true, closesAt: "2026-06-13T08:00:00Z" },
  path: "/e/abc123",
};
const ORIGIN = "https://club.example";

type Call = { url: string; init?: RequestInit };

async function start(events: unknown, { clipboard = { writeText: vi.fn(async () => {}) }, status = 200, navigator, settings, extra = {} }: {
  clipboard?: { writeText: ReturnType<typeof vi.fn> } | null; status?: number; navigator?: unknown; settings?: Promise<unknown>; extra?: Record<string, unknown>;
} = {}) {
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  const navigate = vi.fn();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/admin/session") return reply(200, SESSION);
    if (url === "/api/admin/events") return reply(status, status === 200 ? { events, ...extra } : { error: { code: "internal_error" } });
    if (url === "/api/admin/logout") return reply(200, { ok: true });
    throw new Error(`unexpected ${url}`);
  });
  await init({
    document, fetch: fetch as unknown as typeof globalThis.fetch, navigate, clipboard: clipboard as never, location: { origin: ORIGIN },
    ...(navigator ? { navigator: navigator as never } : {}), ...(settings ? { settings: settings as never } : {}),
  });
  return { calls, navigate, clipboard: clipboard as { writeText: ReturnType<typeof vi.fn> } };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const text = () => document.body.textContent ?? "";
const buttonNamed = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
const flush = () => vi.advanceTimersByTimeAsync(0);

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("list page", () => {
  it("renders a card per event", async () => {
    const { calls } = await start([EVENT, { ...EVENT, slug: "def", path: "/e/def", name: "Second", bookings: { open: false, closesAt: "x" } }]);
    expect(calls.map((c) => c.url)).toEqual(["/api/admin/session", "/api/admin/events"]);
    expect(text()).toContain("Signed in as ann@example.com");
    const cards = document.querySelectorAll(".event-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector("h2")!.textContent).toBe("Trial Day");
    expect(cards[0].textContent).toContain("Saturday 13 June 2026, 09:00–16:00");
    expect(cards[0].textContent).toContain("3 of 12 slots booked");
    expect(cards[0].querySelector(".badge")!.textContent).toBe("Bookings open");
    expect(cards[1].querySelector(".badge")!.textContent).toBe("Bookings closed");
    const create = document.querySelector<HTMLAnchorElement>("a[href='/admin/new']")!;
    expect(create.textContent).toBe("Create event");
    const open = cards[0].querySelector<HTMLAnchorElement>("a")!;
    expect(open.textContent).toBe("Open");
    expect(open.getAttribute("href")).toBe("/e/abc123");
  });

  it("counts places where the event has more places than times, and slots otherwise (as before)", async () => {
    await start([
      { ...EVENT, laneCount: 3, capacity: 2, placeCount: 72 },
      { ...EVENT, slug: "def", path: "/e/def", name: "Plain", laneCount: 1, capacity: 1, placeCount: 12 },
      { ...EVENT, slug: "ghi", path: "/e/ghi", name: "Old data" },
    ]);
    const lines = [...document.querySelectorAll(".event-card .booked")].map((p) => p.textContent);
    expect(lines).toEqual(["3 of 72 places booked", "3 of 12 slots booked", "3 of 12 slots booked"]);
  });

  it("tags an unlisted event Not listed, and only that one", async () => {
    await start([{ ...EVENT, listed: true }, { ...EVENT, slug: "def", path: "/e/def", name: "Hidden", listed: false }, { ...EVENT, slug: "ghi", path: "/e/ghi", name: "Old data" }]);
    const badges = [...document.querySelectorAll(".event-card")].map((c) => [...c.querySelectorAll(".badge")].map((b) => b.textContent));
    expect(badges).toEqual([["Bookings open"], ["Bookings open", "Not listed"], ["Bookings open"]]);
  });

  it("has no Settings button in the admin bar any more (the navigation has it), only the signed-in line and Sign out", async () => {
    await start([]);
    const bar = [...$(".admin-bar").children];
    expect(bar.map((n) => n.textContent)).toEqual(["Signed in as ann@example.com", "Sign out"]);
    expect(bar.some((n) => n.getAttribute("href") === "/admin/settings")).toBe(false);
  });

  it("gives each card a Schedule link to the schedule page, right after Edit, with the slug escaped", async () => {
    await start([EVENT, { ...EVENT, slug: "a b&c", path: "/e/abc" }]);
    const links = [...document.querySelectorAll<HTMLAnchorElement>(".event-card a")].filter((a) => a.textContent === "Schedule");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/admin/schedule?slug=abc123", "/admin/schedule?slug=a%20b%26c"]);
    expect([...document.querySelectorAll(".event-card")[0].querySelectorAll(".actions > *")].map((n) => n.textContent)).toEqual(["Copy booking link", "Open", "Edit", "Schedule"]);
  });

  it("gives each card an Edit link to the edit page, after Copy and Open", async () => {
    await start([EVENT, { ...EVENT, slug: "def456", path: "/e/def456", name: "Second" }]);
    const edits = [...document.querySelectorAll<HTMLAnchorElement>(".event-card a")].filter((a) => a.textContent === "Edit");
    expect(edits.map((a) => a.getAttribute("href"))).toEqual(["/admin/edit?slug=abc123", "/admin/edit?slug=def456"]);
    expect([...document.querySelectorAll(".event-card")[0].querySelectorAll(".actions > *")].slice(0, 3).map((n) => n.textContent)).toEqual(["Copy booking link", "Open", "Edit"]);
  });

  it("escapes the slug in the Edit link", async () => {
    await start([{ ...EVENT, slug: "a b&c" }]);
    const edit = [...document.querySelectorAll<HTMLAnchorElement>(".event-card a")].find((a) => a.textContent === "Edit")!;
    expect(edit.getAttribute("href")).toBe("/admin/edit?slug=a%20b%26c");
  });

  it("shows the empty state", async () => {
    await start([]);
    expect(text()).toContain("No upcoming events yet.");
    expect(document.querySelector(".event-card")).toBeNull();
    expect(document.querySelector("a[href='/admin/new']")).not.toBeNull();
  });

  it("shows a retryable error when loading fails", async () => {
    await start(null, { status: 500 });
    const alert = $("[role=alert]");
    expect(alert.textContent).toContain("We couldn't load your events.");
    expect(buttonNamed("Retry")).toBeDefined();
    expect(document.querySelector(".event-card")).toBeNull();
  });

  it("shows an error when the network fails", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetch = vi.fn(async () => { throw new TypeError("offline"); });
    await init({
      document, fetch: fetch as unknown as typeof globalThis.fetch, navigate: vi.fn(), clipboard: undefined,
      location: { origin: ORIGIN },
    });
    expect($("[role=alert]").textContent).toContain("Check your connection");
  });

  it("only links valid booking paths", async () => {
    const hostile = ["javascript:alert(1)", "//evil.example/e/x", "/e/a/b", "/admin", "https://evil.example/e/abc", "/e/"];
    await start(hostile.map((path, i) => ({ ...EVENT, slug: `s${i}`, path })));
    expect(document.querySelectorAll(".event-card")).toHaveLength(hostile.length);
    expect(document.querySelectorAll(".event-card a")).toHaveLength(0);
    expect(document.querySelectorAll(".event-card button")).toHaveLength(0);
    expect(document.querySelectorAll("[href^='javascript'], [href*='evil']")).toHaveLength(0);
  });

  it("keeps hostile names inert", async () => {
    await start([{ ...EVENT, name: "<img src=x onerror=alert(1)>" }]);
    expect(document.querySelector(".event-card img")).toBeNull();
    expect($(".event-card h2").textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("keeps a hostile identity inert", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetch = vi.fn(async (url: string) =>
      url === "/api/admin/session" ? reply(200, { ...SESSION, identity: "<img src=x onerror=alert(1)>" }) : reply(200, { events: [] }));
    await init({ document, fetch: fetch as unknown as typeof globalThis.fetch, navigate: vi.fn(), clipboard: undefined, location: { origin: ORIGIN } });
    expect(document.querySelector("img")).toBeNull();
    expect(text()).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("copy booking link", () => {
  it("copies the absolute URL and shows Copied briefly", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { clipboard } = await start([EVENT]);
    buttonNamed("Copy booking link").click();
    await flush();
    expect(clipboard.writeText).toHaveBeenCalledWith("https://club.example/e/abc123");
    expect($(".copy-status").textContent).toBe("Copied");
    expect($(".copy-status").getAttribute("aria-live")).toBe("polite");
    vi.advanceTimersByTime(2100);
    expect($(".copy-status").textContent).toBe("");
  });

  it("falls back to a selected readonly field when the clipboard rejects", async () => {
    const clipboard = { writeText: vi.fn(async () => { throw new Error("denied"); }) };
    await start([EVENT], { clipboard });
    buttonNamed("Copy booking link").click();
    await vi.waitFor(() => expect(document.querySelector("input[readonly]")).not.toBeNull());
    const input = $("input[readonly]") as HTMLInputElement;
    expect(input.value).toBe("https://club.example/e/abc123");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect($(".copy-status").textContent).toContain("manually");
  });

  it("falls back when there is no clipboard API", async () => {
    await start([EVENT], { clipboard: null as never });
    buttonNamed("Copy booking link").click();
    await vi.waitFor(() => expect(document.querySelector("input[readonly]")).not.toBeNull());
  });
});

describe("sign out", () => {
  it("posts the logout and follows the navigation", async () => {
    const { calls, navigate } = await start([]);
    buttonNamed("Sign out").click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/admin/login"));
    const logout = calls.find((c) => c.url === "/api/admin/logout")!;
    expect(logout.init?.method).toBe("POST");
    expect((logout.init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
  });
});

// ---- Past, Archived, archive, delete and bulk clear-out ----

const OLD = (over: Record<string, unknown> = {}) => ({
  slug: "old-event-slug-0001", name: "Old Show", startUtc: "2026-05-02T08:00:00Z", endUtc: "2026-05-02T15:00:00Z",
  venuePostcode: "SW1A 1AA", bookedCount: 4, archived: false, ...over,
});
const FILED = (over: Record<string, unknown> = {}) => OLD({ slug: "filed-event-slug-001", name: "Filed Show", bookedCount: 1, archived: true, ...over });
const UP = (over: Record<string, unknown> = {}) => ({ ...EVENT, slug: "upcoming-event-slug1", path: "/e/upcoming-event-slug1", archived: false, full: false, ...over });

interface Harness { calls: Call[]; setList(body: unknown): void; writes(): Call[] }

/** Starts the page with `body` as the list; `route(url, init)` answers the writes. Writes are recorded in `calls`. */
async function begin(body: Record<string, unknown>, route: (url: string, init?: RequestInit) => Response | Promise<Response> = () => reply(200, {})): Promise<Harness> {
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  let list = body;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/admin/session") return reply(200, SESSION);
    if (url === "/api/admin/events" && (init?.method ?? "GET") === "GET") return reply(200, list);
    return route(url, init);
  });
  await init({ document, fetch: fetch as unknown as typeof globalThis.fetch, navigate: vi.fn(), clipboard: undefined, location: { origin: ORIGIN } });
  return { calls, setList: (b) => { list = b as Record<string, unknown>; }, writes: () => calls.filter((c) => c.init?.method && c.init.method !== "GET") };
}

const all = (sel: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(sel)];
const section = (title: string) => all("details").find((d) => d.querySelector("summary")!.textContent!.startsWith(title))! as HTMLDetailsElement;
const rowOf = (name: string) => all(".event-card").find((li) => li.querySelector("h2, h3")!.textContent === name)!;
const inRow = (name: string, label: string) => all("button, a", rowOf(name)).find((b) => b.textContent === label) as HTMLButtonElement;
const live = () => $(".list-status").textContent;
const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
const full = (over: Record<string, unknown> = {}) => ({ events: [UP()], past: [OLD()], archived: [FILED()], pastHasMore: false, archivedHasMore: false, ...over });

describe("sections", () => {
  it("shows Upcoming, then Past and Archived as collapsed details with counts", async () => {
    await begin(full({ past: [OLD(), OLD({ slug: "old-event-slug-0002", name: "Older Show" })] }));
    expect($("h1").textContent).toBe("Upcoming events");
    expect(all(".event-list > .event-card")[0].querySelector("h2")!.textContent).toBe("Trial Day");
    expect(section("Past").querySelector("summary")!.textContent).toBe("Past (2)");
    expect(section("Archived").querySelector("summary")!.textContent).toBe("Archived (1)");
    expect(section("Past").open).toBe(false);
    expect(section("Archived").open).toBe(false);
    expect(all("h3", section("Past")).map((n) => n.textContent)).toEqual(["Old Show", "Older Show"]);
    expect(all("h3", section("Archived")).map((n) => n.textContent)).toEqual(["Filed Show"]);
    expect(rowOf("Old Show").textContent).toContain("4 bookings");
    expect(rowOf("Old Show").textContent).toContain("Saturday 2 May 2026, 09:00–16:00");
    expect(rowOf("Filed Show").textContent).toContain("1 booking");
    expect(rowOf("Filed Show").textContent).not.toContain("1 bookings");
  });

  it("has plain empty states for each section", async () => {
    await begin({ events: [], past: [], archived: [], pastHasMore: false, archivedHasMore: false });
    expect(text()).toContain("No upcoming events yet.");
    expect(section("Past").textContent).toContain("No past events.");
    expect(section("Past").querySelector("summary")!.textContent).toBe("Past (0)");
    expect(section("Archived").textContent).toContain("No archived events.");
    expect(section("Archived").querySelector("summary")!.textContent).toBe("Archived (0)");
  });

  it("copes with a response that has no past or archived lists", async () => {
    await begin({ events: [UP()] });
    expect(section("Past").textContent).toContain("No past events.");
  });

  it("notes that there are more than the 100 shown, and says so in the summary", async () => {
    await begin(full({ pastHasMore: true, archivedHasMore: true }));
    expect(section("Past").querySelector("summary")!.textContent).toBe("Past (1+)");
    expect(section("Past").textContent).toContain("…and more");
    expect(section("Archived").textContent).toContain("…and more");
    await begin(full());
    expect(section("Past").textContent).not.toContain("and more");
  });

  it("marks a full upcoming event with the text Full, and only that one", async () => {
    await begin(full({ events: [UP({ full: true }), UP({ slug: "second-event-slug-02", path: "/e/second-event-slug-02", name: "Second", full: false })] }));
    expect(all(".badge", rowOf("Trial Day")).map((b) => b.textContent)).toEqual(["Bookings open", "Full"]);
    expect(all(".badge", rowOf("Second")).map((b) => b.textContent)).toEqual(["Bookings open"]);
  });

  it("gives an upcoming card Edit, Schedule, Archive and Delete…; a past row Schedule, Archive and Delete…; an archived row Unarchive and Delete…", async () => {
    await begin(full());
    expect(all(".manage > *", rowOf("Trial Day")).map((n) => n.textContent)).toEqual(["Archive", "Delete…"]);
    expect(inRow("Trial Day", "Edit")).toBeDefined();
    expect(inRow("Trial Day", "Schedule")).toBeDefined();
    expect(all(".manage > *", rowOf("Old Show")).map((n) => n.textContent)).toEqual(["Schedule", "Archive", "Delete…"]);
    expect(inRow("Old Show", "Schedule").getAttribute("href")).toBe("/admin/schedule?slug=old-event-slug-0001");
    expect(all(".manage > *", rowOf("Filed Show")).map((n) => n.textContent)).toEqual(["Unarchive", "Delete…"]);
  });

  it("keeps hostile names inert in every section", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    await begin(full({ events: [UP({ name: evil })], past: [OLD({ name: evil })], archived: [FILED({ name: evil })] }));
    expect(document.querySelector("img")).toBeNull();
    expect(all("h2, h3").filter((n) => n.textContent === evil)).toHaveLength(3);
    for (const row of all(".event-card")) {
      all("button", row).find((b) => b.textContent === "Delete…")!.click();
      expect($(".confirm strong").textContent).toBe(evil);
      expect(document.querySelector("img")).toBeNull();
    }
  });

  it("keeps the sections open across a refresh", async () => {
    const h = await begin(full(), (url) => reply(200, url.endsWith("/archive") ? { archived: true } : {}));
    section("Past").open = true;
    section("Past").dispatchEvent(new Event("toggle"));
    inRow("Trial Day", "Archive").click();
    await vi.waitFor(() => expect(live()).toBe("Archived Trial Day."));
    expect(h.writes()).toHaveLength(1);
    expect(section("Past").open).toBe(true);
    expect(section("Archived").open).toBe(false);
  });
});

describe("archive and unarchive", () => {
  it("archives from an upcoming card: one POST, disabled while it runs, then refreshes and announces", async () => {
    let release!: (r: Response) => void;
    const h = await begin(full(), () => new Promise<Response>((r) => { release = r; }));
    const button = inRow("Trial Day", "Archive");
    button.click();
    await vi.waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].url).toBe("/api/admin/events/upcoming-event-slug1/archive");
    expect(h.writes()[0].init?.method).toBe("POST");
    expect(JSON.parse(h.writes()[0].init!.body as string)).toEqual({ archived: true });
    expect(button.disabled).toBe(true);
    expect(inRow("Trial Day", "Delete…").disabled).toBe(true);
    button.click(); // a second click while it runs does nothing
    h.setList(full({ events: [], archived: [FILED(), FILED({ slug: "upcoming-event-slug1", name: "Trial Day" })] }));
    release(reply(200, { archived: true }));
    await vi.waitFor(() => expect(live()).toBe("Archived Trial Day."));
    expect(h.writes()).toHaveLength(1);
    expect(h.calls.filter((c) => c.url === "/api/admin/events")).toHaveLength(2);
    expect($(".list-status").getAttribute("aria-live")).toBe("polite");
    expect(text()).toContain("No upcoming events yet.");
    expect(section("Archived").querySelector("summary")!.textContent).toBe("Archived (2)");
    expect(document.querySelector("[disabled]:not([data-bulk])")).toBeNull();
  });

  it("archives a past row and unarchives an archived one", async () => {
    const h = await begin(full(), (url) => reply(200, { archived: url.includes("filed") ? false : true }));
    inRow("Old Show", "Archive").click();
    await vi.waitFor(() => expect(live()).toBe("Archived Old Show."));
    inRow("Filed Show", "Unarchive").click();
    await vi.waitFor(() => expect(live()).toBe("Unarchived Filed Show."));
    expect(h.writes().map((w) => [w.url, JSON.parse(w.init!.body as string)])).toEqual([
      ["/api/admin/events/old-event-slug-0001/archive", { archived: true }],
      ["/api/admin/events/filed-event-slug-001/archive", { archived: false }],
    ]);
  });

  it("shows a retryable message when archiving fails, and the button works again", async () => {
    let fail = true;
    const h = await begin(full(), () => (fail ? reply(500, { error: { code: "internal_error", message: "Something went wrong. Please try again." } }) : reply(200, { archived: true })));
    inRow("Trial Day", "Archive").click();
    await vi.waitFor(() => expect(live()).toContain("We couldn't archive Trial Day."));
    expect(live()).toContain("Something went wrong. Please try again.");
    expect(inRow("Trial Day", "Archive").disabled).toBe(false);
    fail = false;
    inRow("Trial Day", "Archive").click();
    await vi.waitFor(() => expect(live()).toBe("Archived Trial Day."));
    expect(h.writes()).toHaveLength(2);
  });

  it("says so when the network fails", async () => {
    await begin(full(), () => { throw new TypeError("offline"); });
    inRow("Trial Day", "Archive").click();
    await vi.waitFor(() => expect(live()).toContain("Check your connection"));
    expect(inRow("Trial Day", "Archive").disabled).toBe(false);
  });

  it("refreshes and says the event is gone on a 404", async () => {
    await begin(full(), () => reply(404, { error: { code: "not_found", message: "Event not found" } }));
    inRow("Trial Day", "Archive").click();
    await vi.waitFor(() => expect(live()).toContain("That event no longer exists."));
  });
});

describe("Delete… one event", () => {
  const open = (name = "Trial Day") => { inRow(name, "Delete…").click(); return $(".confirm"); };
  const confirmButton = () => all(".confirm button").find((b) => b.textContent === "Delete event") as HTMLButtonElement;
  const typed = () => $(".confirm input") as HTMLInputElement;

  it("opens a panel with the name, the booking count and an input with focus, and the button disabled", async () => {
    await begin(full());
    const panel = open();
    expect(panel.querySelector("p")!.textContent).toBe("This permanently deletes Trial Day and its 3 bookings. This can't be undone.");
    expect(panel.querySelector("label")!.textContent).toBe("Type the event name to confirm");
    expect(document.activeElement).toBe(typed());
    expect(typed().getAttribute("id")).toBe(panel.querySelector("label")!.getAttribute("for"));
    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().classList.contains("danger")).toBe(true);
    expect(panel.parentElement).toBe(rowOf("Trial Day"));
  });

  it("enables Delete event only when the trimmed text equals the name exactly, and calls the server only on click", async () => {
    const h = await begin(full(), () => reply(200, { deleted: { slug: "upcoming-event-slug1", name: "Trial Day", bookings: 3 } }));
    open();
    for (const wrong of ["", "trial day", "TRIAL DAY", "Trial  Day", "Trial Day!", "Trial", "Trial Day Trial Day", "Trial Day"]) {
      type(typed(), wrong);
      expect(confirmButton().disabled, JSON.stringify(wrong)).toBe(true);
    }
    type(typed(), "  Trial Day \n");
    expect(confirmButton().disabled).toBe(false);
    expect(h.writes()).toHaveLength(0);
    type(typed(), "Trial Day x");
    expect(confirmButton().disabled).toBe(true);
    type(typed(), "Trial Day");
    expect(confirmButton().disabled).toBe(false);
    expect(h.writes()).toHaveLength(0);
    confirmButton().click();
    await vi.waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].url).toBe("/api/admin/events/upcoming-event-slug1");
    expect(h.writes()[0].init?.method).toBe("DELETE");
    expect(JSON.parse(h.writes()[0].init!.body as string)).toEqual({ confirmName: "Trial Day" });
  });

  it("shows a name with repeated spaces in an element that keeps them, hints how to type it, and needs it typed exactly", async () => {
    const h = await begin(full({ events: [UP({ name: "Trial  Day" })] }), () => reply(200, { deleted: { slug: "x", name: "Trial  Day", bookings: 3 } }));
    const panel = open("Trial  Day");
    const shown = panel.querySelector("strong")!;
    expect(shown.textContent).toBe("Trial  Day");
    expect(shown.classList.contains("name-exact")).toBe(true);
    expect(panel.textContent).toContain("Type it exactly as shown, including capital letters and spaces.");
    expect(typed().getAttribute("aria-describedby")).toBe(panel.querySelector(".note")!.getAttribute("id"));
    type(typed(), "Trial Day");
    expect(confirmButton().disabled).toBe(true);
    type(typed(), "Trial  Day");
    expect(confirmButton().disabled).toBe(false);
    confirmButton().click();
    await vi.waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(JSON.parse(h.writes()[0].init!.body as string)).toEqual({ confirmName: "Trial  Day" });
  });

  it("disables everything while the request runs, then refreshes and announces", async () => {
    let release!: (r: Response) => void;
    const h = await begin(full(), () => new Promise<Response>((r) => { release = r; }));
    open();
    type(typed(), "Trial Day");
    confirmButton().click();
    await vi.waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(confirmButton().disabled).toBe(true);
    expect(typed().disabled).toBe(true);
    expect(all("button", document).filter((b) => !b.hasAttribute("disabled")).map((b) => b.textContent)).toEqual([]);
    h.setList(full({ events: [] }));
    release(reply(200, { deleted: { slug: "upcoming-event-slug1", name: "Trial Day", bookings: 3 } }));
    await vi.waitFor(() => expect(live()).toBe("Deleted Trial Day and 3 bookings."));
    expect(document.querySelector(".confirm")).toBeNull();
    expect(text()).toContain("No upcoming events yet.");
    expect(h.writes()).toHaveLength(1);
    expect(document.activeElement).toBe($(".list-status"));
    expect(document.querySelector("[disabled]:not([data-bulk])")).toBeNull();
  });

  it("announces the server's booking count, singular for one", async () => {
    await begin(full(), () => reply(200, { deleted: { slug: "x", name: "Old Show", bookings: 1 } }));
    open("Old Show");
    type(typed(), "Old Show");
    confirmButton().click();
    await vi.waitFor(() => expect(live()).toBe("Deleted Old Show and 1 booking."));
  });

  it("shows the server's confirmation_mismatch inline, keeping the panel and focus in the input", async () => {
    const h = await begin(full(), () => reply(400, { error: { code: "confirmation_mismatch", message: "Type the event's name exactly to delete it." } }));
    open();
    type(typed(), "Trial Day");
    confirmButton().click();
    await vi.waitFor(() => expect($(".confirm .form-error").textContent).toBe("Type the event's name exactly to delete it."));
    expect($(".confirm .form-error").getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(typed());
    expect(confirmButton().disabled).toBe(false);
    type(typed(), "Trial Day ");
    expect($(".confirm .form-error").textContent).toBe("");
    expect(h.writes()).toHaveLength(1);
  });

  it("shows other failures inline and lets the admin retry", async () => {
    let fail = true;
    const h = await begin(full(), () => (fail ? reply(500, { error: { code: "internal_error", message: "Something went wrong. Please try again." } })
      : reply(200, { deleted: { slug: "x", name: "Trial Day", bookings: 3 } })));
    open();
    type(typed(), "Trial Day");
    confirmButton().click();
    await vi.waitFor(() => expect($(".confirm .form-error").textContent).toBe("Something went wrong. Please try again."));
    expect(confirmButton().disabled).toBe(false);
    fail = false;
    confirmButton().click();
    await vi.waitFor(() => expect(live()).toBe("Deleted Trial Day and 3 bookings."));
    expect(h.writes()).toHaveLength(2);
  });

  it("Cancel closes the panel without any request and puts focus back on Delete…", async () => {
    const h = await begin(full());
    open();
    all(".confirm button").find((b) => b.textContent === "Cancel")!.click();
    expect(document.querySelector(".confirm")).toBeNull();
    expect(document.activeElement).toBe(inRow("Trial Day", "Delete…"));
    expect(h.writes()).toHaveLength(0);
  });

  it("has one panel at a time", async () => {
    await begin(full());
    open("Trial Day");
    open("Old Show");
    expect(all(".confirm")).toHaveLength(1);
    expect($(".confirm").parentElement).toBe(rowOf("Old Show"));
  });

  it("works from the Past and Archived sections too", async () => {
    const h = await begin(full(), () => reply(200, { deleted: { slug: "x", name: "Filed Show", bookings: 1 } }));
    open("Old Show");
    expect($(".confirm p").textContent).toBe("This permanently deletes Old Show and its 4 bookings. This can't be undone.");
    open("Filed Show");
    type(typed(), "Filed Show");
    confirmButton().click();
    await vi.waitFor(() => expect(live()).toBe("Deleted Filed Show and 1 booking."));
    expect(h.writes()[0].url).toBe("/api/admin/events/filed-event-slug-001");
  });
});

describe("clearing out Past", () => {
  const PAST3 = [
    OLD({ slug: "past-event-slug-0001", name: "Alpha Show", bookedCount: 2 }),
    OLD({ slug: "past-event-slug-0002", name: "Bravo Show", bookedCount: 0 }),
    OLD({ slug: "past-event-slug-0003", name: "Charlie Show", bookedCount: 5 }),
  ];
  const box = (name: string) => document.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`)!;
  const selectAll = () => all("label", section("Past")).find((l) => l.textContent!.includes("Select all"))!.querySelector("input")!;
  const bulk = () => document.querySelector<HTMLButtonElement>("[data-bulk]")!;
  const tick = (name: string) => box(name).click();
  const sure = () => all(".confirm button").find((b) => b.textContent === "Delete events") as HTMLButtonElement;
  const word = () => $(".confirm input") as HTMLInputElement;

  it("gives each past row a labelled checkbox and starts with Delete selected (0) disabled", async () => {
    await begin(full({ past: PAST3 }));
    expect(all("input[type=checkbox][aria-label^='Select ']", section("Past")).map((c) => c.getAttribute("aria-label"))).toEqual(["Select Alpha Show", "Select Bravo Show", "Select Charlie Show"]);
    expect(bulk().textContent).toBe("Delete selected (0)");
    expect(bulk().disabled).toBe(true);
    expect(document.querySelector("input[aria-label='Select Filed Show']")).toBeNull();
    expect(document.querySelector("input[aria-label='Select Trial Day']")).toBeNull();
  });

  it("counts the ticked rows and enables the button from one", async () => {
    await begin(full({ past: PAST3 }));
    tick("Alpha Show");
    expect(bulk().textContent).toBe("Delete selected (1)");
    expect(bulk().disabled).toBe(false);
    tick("Charlie Show");
    expect(bulk().textContent).toBe("Delete selected (2)");
    expect(selectAll().checked).toBe(false);
    tick("Alpha Show");
    tick("Charlie Show");
    expect(bulk().textContent).toBe("Delete selected (0)");
    expect(bulk().disabled).toBe(true);
  });

  it("Select all ticks every past row, and ticking it again clears them", async () => {
    await begin(full({ past: PAST3 }));
    selectAll().click();
    expect(all("[data-pick]").every((c) => (c as HTMLInputElement).checked)).toBe(true);
    expect(bulk().textContent).toBe("Delete selected (3)");
    tick("Bravo Show");
    expect(selectAll().checked).toBe(false);
    tick("Bravo Show");
    expect(selectAll().checked).toBe(true);
    selectAll().click();
    expect(all("[data-pick]").some((c) => (c as HTMLInputElement).checked)).toBe(false);
    expect(bulk().textContent).toBe("Delete selected (0)");
  });

  it("lists the chosen names and the total bookings, and asks for DELETE", async () => {
    await begin(full({ past: PAST3 }));
    tick("Alpha Show");
    tick("Charlie Show");
    bulk().click();
    const panel = $(".confirm");
    expect(panel.querySelector("p")!.textContent).toBe("This permanently deletes 2 events and 7 bookings in total. This can't be undone.");
    expect(all("li", panel).map((n) => n.textContent)).toEqual(["Alpha Show", "Charlie Show"]);
    expect(panel.querySelector("label")!.textContent).toBe("Type DELETE to confirm");
    expect(document.activeElement).toBe(word());
    expect(sure().disabled).toBe(true);
    expect(box("Alpha Show").disabled).toBe(true); // the selection is locked while the panel is open
    expect(bulk().disabled).toBe(true);
  });

  it("lists the chosen names in an element that keeps repeated spaces", async () => {
    await begin(full({ past: [OLD({ slug: "past-event-slug-0001", name: "Alpha  Show", bookedCount: 2 })] }));
    tick("Alpha  Show");
    bulk().click();
    const name = $(".confirm li .name-exact");
    expect(name.textContent).toBe("Alpha  Show");
  });

  it("enables Delete events only for DELETE (trimmed), and sends exactly { slugs, confirm } on click", async () => {
    const h = await begin(full({ past: PAST3 }), () => reply(200, { deletedEvents: 2, deletedBookings: 7, skipped: [] }));
    tick("Alpha Show");
    tick("Charlie Show");
    bulk().click();
    for (const wrong of ["", "delete", "Delete", "DELET", "DELETE it", "DELETE DELETE", "D E L E T E"]) {
      type(word(), wrong);
      expect(sure().disabled, wrong).toBe(true);
    }
    type(word(), " DELETE ");
    expect(sure().disabled).toBe(false);
    expect(h.writes()).toHaveLength(0);
    h.setList(full({ past: [PAST3[1]] }));
    sure().click();
    await vi.waitFor(() => expect(live()).toBe("Deleted 2 events and 7 bookings."));
    expect(h.writes()).toHaveLength(1);
    expect(h.writes()[0].url).toBe("/api/admin/events/clear-past");
    expect(h.writes()[0].init?.method).toBe("POST");
    expect(JSON.parse(h.writes()[0].init!.body as string)).toEqual({ slugs: ["past-event-slug-0001", "past-event-slug-0003"], confirm: "DELETE" });
    expect(section("Past").querySelector("summary")!.textContent).toBe("Past (1)");
    expect(document.querySelector(".confirm")).toBeNull();
    expect(bulk().textContent).toBe("Delete selected (0)");
  });

  it("disables everything while it runs", async () => {
    let release!: (r: Response) => void;
    const h = await begin(full({ past: PAST3 }), () => new Promise<Response>((r) => { release = r; }));
    selectAll().click();
    bulk().click();
    type(word(), "DELETE");
    sure().click();
    await vi.waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(sure().disabled).toBe(true);
    expect(word().disabled).toBe(true);
    expect(bulk().disabled).toBe(true);
    expect(selectAll().disabled).toBe(true);
    sure().click();
    h.setList(full({ past: [] }));
    release(reply(200, { deletedEvents: 3, deletedBookings: 7, skipped: [] }));
    await vi.waitFor(() => expect(live()).toBe("Deleted 3 events and 7 bookings."));
    expect(h.writes()).toHaveLength(1);
  });

  it("reports anything the server skipped, by name", async () => {
    await begin(full({ past: PAST3 }), () => reply(200, {
      deletedEvents: 1, deletedBookings: 2,
      skipped: [{ slug: "past-event-slug-0002", reason: "not_past" }, { slug: "past-event-slug-0003", reason: "not_found" }, { slug: "mystery-slug-000000001", reason: "not_found" }],
    }));
    selectAll().click();
    bulk().click();
    type(word(), "DELETE");
    sure().click();
    await vi.waitFor(() => expect(live()).toContain("Deleted 1 event and 2 bookings."));
    expect(live()).toContain("Not deleted: Bravo Show (it hasn't ended), Charlie Show (it no longer exists), mystery-slug-000000001 (it no longer exists).");
  });

  it("shows a failure inline, keeps the panel and lets the admin retry", async () => {
    let fail = true;
    const h = await begin(full({ past: PAST3 }), () => (fail ? reply(500, { error: { code: "internal_error", message: "Something went wrong. Please try again." } })
      : reply(200, { deletedEvents: 1, deletedBookings: 2, skipped: [] })));
    tick("Alpha Show");
    bulk().click();
    type(word(), "DELETE");
    sure().click();
    await vi.waitFor(() => expect($(".confirm .form-error").textContent).toBe("Something went wrong. Please try again."));
    expect(sure().disabled).toBe(false);
    expect(bulk().disabled).toBe(true);
    fail = false;
    sure().click();
    await vi.waitFor(() => expect(live()).toContain("Deleted 1 event"));
    expect(h.writes()).toHaveLength(2);
  });

  it("Cancel closes the panel, unlocks the selection and sends nothing", async () => {
    const h = await begin(full({ past: PAST3 }));
    tick("Alpha Show");
    bulk().click();
    all(".confirm button").find((b) => b.textContent === "Cancel")!.click();
    expect(document.querySelector(".confirm")).toBeNull();
    expect(box("Alpha Show").disabled).toBe(false);
    expect(box("Alpha Show").checked).toBe(true);
    expect(bulk().disabled).toBe(false);
    expect(document.activeElement).toBe(bulk());
    expect(h.writes()).toHaveLength(0);
  });

  it("keeps hostile names inert in the list of chosen events", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    await begin(full({ past: [OLD({ name: evil })] }));
    selectAll().click();
    bulk().click();
    expect(document.querySelector("img")).toBeNull();
    expect(all(".confirm li").map((n) => n.textContent)).toEqual([evil]);
  });

  it("forgets a ticked event that is no longer in Past after a refresh", async () => {
    const h = await begin(full({ past: PAST3 }), () => reply(200, { archived: true }));
    tick("Alpha Show");
    tick("Bravo Show");
    h.setList(full({ past: [PAST3[1], PAST3[2]] }));
    inRow("Alpha Show", "Archive").click();
    await vi.waitFor(() => expect(live()).toBe("Archived Alpha Show."));
    expect(bulk().textContent).toBe("Delete selected (1)");
    expect(box("Bravo Show").checked).toBe(true);
  });
});

describe("Share", () => {
  const HOSTILE = "<img src=x onerror=alert(1)>";
  const SHARE_EVENT = { ...EVENT, details: "Bring water", shareMessage: "" };
  const shareOf = (name: string) => rowOf(name).querySelector(".share") as HTMLElement | null;
  const shareButtonOf = (name: string) => [...rowOf(name).querySelectorAll("button")].find((b) => b.textContent === "Share")!;
  const withShare = () => ({ share: vi.fn(async () => {}) });
  const sent = (share: ReturnType<typeof vi.fn>, n = 0) => (share.mock.calls[n][0] as { text: string }).text;
  const BUILT_IN = "Trial Day\nSaturday 13 June 2026, 09:00–16:00\nVenue: SW1A 1AA\nCost: £15.00\nBook your slot:\nhttps://club.example/e/abc123";

  it("is on every Upcoming card, sits before the manage row, and is not on Past or Archived events", async () => {
    await start([SHARE_EVENT, { ...SHARE_EVENT, slug: "def", path: "/e/def", name: "Second" }], {
      navigator: withShare(), extra: { past: [OLD()], archived: [FILED()] },
    });
    expect(all(".event-card .share")).toHaveLength(2);
    expect(shareButtonOf("Trial Day").getAttribute("aria-label")).toBe('Share "Trial Day"');
    expect(shareButtonOf("Second").getAttribute("aria-label")).toBe('Share "Second"');
    const card = rowOf("Trial Day");
    expect(shareOf("Trial Day")!.nextElementSibling).toBe(card.querySelector(".manage"));
    expect(rowOf("Old Show").querySelector(".share")).toBeNull();
    expect(rowOf("Filed Show").querySelector(".share")).toBeNull();
    expect(all("button", rowOf("Old Show")).map((b) => b.textContent)).not.toContain("Share");
  });

  it("has no Share on an event without a sound booking path", async () => {
    await start([{ ...SHARE_EVENT, path: "javascript:alert(1)" }], { navigator: withShare() });
    expect(document.querySelector(".share")).toBeNull();
  });

  it("shares the built-in message for an event with no message of its own and no default", async () => {
    const navigator = withShare();
    await start([SHARE_EVENT], { navigator });
    shareButtonOf("Trial Day").click();
    expect(navigator.share).toHaveBeenCalledTimes(1);
    expect(navigator.share.mock.calls[0]).toEqual([{ text: BUILT_IN }]);
  });

  it("prefers the event's own message, then the default template's, then the built-in one", async () => {
    const navigator = withShare();
    await start([
      { ...SHARE_EVENT, shareMessage: "Own: {event}, {details}" },
      { ...SHARE_EVENT, slug: "def", path: "/e/def", name: "Second" },
    ], { navigator, extra: { defaultShareMessage: "Default: {event}" } });
    shareButtonOf("Trial Day").click();
    shareButtonOf("Second").click();
    expect(sent(navigator.share, 0)).toBe("Own: Trial Day, Bring water\nhttps://club.example/e/abc123");
    expect(sent(navigator.share, 1)).toBe("Default: Second\nhttps://club.example/e/def");
  });

  it("fills {lanes} from the lanes the list gives for each event, and drops the line for one unnamed lane", async () => {
    const navigator = withShare();
    await start([
      { ...SHARE_EVENT, lanes: [{ name: "Ring 1" }, { name: "Ring 2" }] },
      { ...SHARE_EVENT, slug: "def", path: "/e/def", name: "Second", lanes: [{ name: "" }] },
    ], { navigator, extra: { defaultShareMessage: "{event}\n{lanes}" } });
    shareButtonOf("Trial Day").click();
    shareButtonOf("Second").click();
    expect(sent(navigator.share, 0)).toBe("Trial Day\nRing 1, Ring 2\nhttps://club.example/e/abc123");
    expect(sent(navigator.share, 1)).toBe("Second\nhttps://club.example/e/def");
  });

  it("ignores a defaultShareMessage that isn't a string", async () => {
    const navigator = withShare();
    await start([SHARE_EVENT], { navigator, extra: { defaultShareMessage: 5 } });
    shareButtonOf("Trial Day").click();
    expect(sent(navigator.share)).toBe(BUILT_IN);
  });

  it("puts the club name first once the settings have loaded, and nothing without it", async () => {
    const navigator = withShare();
    await start([SHARE_EVENT], { navigator, settings: Promise.resolve({ clubName: "Hillside Dog Club", loaded: true }) });
    shareButtonOf("Trial Day").click();
    expect(sent(navigator.share)).toBe(`Hillside Dog Club\n${BUILT_IN}`);
    for (const settings of [Promise.resolve({ clubName: "X", loaded: false }), Promise.reject(new Error("offline")), Promise.resolve({ clubName: null, loaded: true })]) {
      const other = withShare();
      await start([SHARE_EVENT], { navigator: other, settings });
      shareButtonOf("Trial Day").click();
      expect(sent(other.share)).toBe(BUILT_IN);
    }
  });

  it("offers Copy message beside Share where navigator.share exists, and no second Copy booking link", async () => {
    await start([SHARE_EVENT], { navigator: withShare() });
    expect([...rowOf("Trial Day").querySelectorAll<HTMLButtonElement>(".share button")].map((b) => [b.textContent, b.hidden])).toEqual([["Share", false], ["Copy message", false]]);
  });

  it("offers only Copy message (the card has its own Copy booking link) when navigator.share is missing", async () => {
    const { clipboard } = await start([SHARE_EVENT], { navigator: {} });
    expect(shareButtonOf("Trial Day")).toBeUndefined();
    expect([...rowOf("Trial Day").querySelectorAll(".share button")].map((b) => b.textContent)).toEqual(["Copy message"]);
    expect([...rowOf("Trial Day").querySelectorAll("button")].filter((b) => b.textContent?.startsWith("Copy")).map((b) => b.textContent)).toEqual(["Copy booking link", "Copy message"]);
    const copy = [...rowOf("Trial Day").querySelectorAll<HTMLButtonElement>(".share button")].find((b) => b.textContent === "Copy message")!;
    expect(copy.getAttribute("aria-label")).toBe('Copy message for "Trial Day"');
    copy.click();
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(BUILT_IN));
  });

  it("rebuilds the controls from fresh data after a refresh", async () => {
    const navigator = withShare();
    let list: Record<string, unknown> = { events: [{ ...SHARE_EVENT, shareMessage: "Before: {event}" }], defaultShareMessage: "" };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/session") return reply(200, SESSION);
      if (url === "/api/admin/events" && (init?.method ?? "GET") === "GET") return reply(200, list);
      return reply(200, { archived: true });
    });
    document.body.innerHTML = '<main id="app"></main>';
    await init({ document, fetch: fetch as never, navigate: vi.fn(), clipboard: undefined as never, location: { origin: ORIGIN }, navigator: navigator as never });
    shareButtonOf("Trial Day").click();
    expect(sent(navigator.share, 0)).toBe("Before: Trial Day\nhttps://club.example/e/abc123");
    list = { events: [{ ...SHARE_EVENT, name: "Renamed", shareMessage: "After: {event}" }], defaultShareMessage: "" };
    const old = shareButtonOf("Trial Day");
    document.querySelector<HTMLButtonElement>("button[aria-label='Archive Trial Day']")!.click();
    await vi.waitFor(() => expect(shareButtonOf("Renamed")).toBeDefined());
    expect(document.contains(old)).toBe(false);
    shareButtonOf("Renamed").click();
    expect(sent(navigator.share, 1)).toBe("After: Renamed\nhttps://club.example/e/abc123");
  });

  it("keeps a hostile name and details inert, as text in the message only", async () => {
    const navigator = withShare();
    await start([{ ...SHARE_EVENT, name: HOSTILE, details: HOSTILE, shareMessage: "{event} {details}" }], { navigator, clipboard: null });
    expect(document.querySelector("img, [onerror]")).toBeNull();
    expect(shareOf(HOSTILE)!.querySelector("button")!.getAttribute("aria-label")).toBe(`Share "${HOSTILE}"`);
    shareButtonOf(HOSTILE).click();
    expect(sent(navigator.share)).toBe(`${HOSTILE} ${HOSTILE}\nhttps://club.example/e/abc123`);
    // the copy fallback path writes it with .value only
    const copy = [...document.querySelectorAll<HTMLButtonElement>(".share button")].find((b) => b.textContent === "Copy message")!;
    copy.hidden = false;
    copy.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>(".share textarea")).not.toBeNull());
    expect(document.querySelector<HTMLTextAreaElement>(".share textarea")!.value).toBe(`${HOSTILE} ${HOSTILE}\nhttps://club.example/e/abc123`);
    expect(document.querySelector("img, [onerror]")).toBeNull();
  });
});

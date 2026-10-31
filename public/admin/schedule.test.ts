// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./schedule.js";

const HOSTILE = "<img src=x onerror=alert(1)>";
const ORIGIN = "https://club.example";
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const BASE = `/api/admin/events/${SLUG}`;
const reply = (status: number, body: unknown = null) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const SESSION = { identity: "ann@example.com", provider: "password", csrfToken: "tok" };

// 2026-06-13 is BST: 09:00 London is 08:00Z. Slots 09:00 09:15 09:30 | lunch 09:45-10:15 | 10:15 10:30.
const S = ["2026-06-13T08:00:00Z", "2026-06-13T08:15:00Z", "2026-06-13T08:30:00Z", "2026-06-13T09:15:00Z", "2026-06-13T09:30:00Z"];
/** The values of a booking of the Dog and Handler form, as the admin API lists them (a blank value is left out). */
const dh = (dog: string, handler: string) => [{ label: "Dog", value: dog }, { label: "Handler", value: handler }];
const FORM = [{ label: "Dog", required: true, maxLength: 80, identity: true }, { label: "Handler", required: true, maxLength: 80, identity: true }];
const EVENT = {
  slug: SLUG, name: "Trial Day", archived: false, date: "2026-06-13", start: "09:00", end: "10:45",
  startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T09:45:00Z", sessionMinutes: 15, gapMinutes: 0, costPence: 0, venuePostcode: "AB1 2CD", details: "",
  breaks: [{ start: "09:45", end: "10:15", label: "Lunch", startUtc: "2026-06-13T08:45:00Z", endUtc: "2026-06-13T09:15:00Z" }],
  fields: FORM, identityLimit: 1,
};
const REX = { id: 11, fields: dh("Rex", "Sam Smith") };
const FLO = { id: 12, fields: dh("Flo", "Pat Jones") };
const LOST = { id: 13, slotStart: "2026-06-13T07:00:00Z", fields: dh("Lost", "Lou") }; // 08:00 London, not a slot
const LINEUP = "Trial Day\nSaturday 13 June 2026 · AB1 2CD\n\n09:00 — free\n09:15 — Rex — Sam Smith";

type Booking = { id: number; fields: { label: string; value: string }[] } | null;
/** The plain page's detail: one unnamed lane with one place per time, so each slot has one lane entry holding its booking, if any. */
const detail = (booked: Booking[] = [null, REX, null, FLO, null], orphans: unknown[] = [], lineup = LINEUP, event: unknown = EVENT) => ({
  event, orphans, lineup,
  slots: S.map((start, i) => ({ start, end: start, places: [{ laneId: 1, laneName: "", free: booked[i] ? 0 : 1, bookings: booked[i] ? [booked[i]] : [] }] })),
});

type Call = { url: string; method: string; body?: any };
type Handler = (call: Call) => Response | Promise<Response> | undefined;

interface Options { respond?: Handler; initial?: unknown; clipboard?: unknown; search?: string; getStatus?: number; navigator?: unknown; settings?: Promise<unknown> }

async function start(o: Options = {}) {
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  const navigate = vi.fn();
  const clipboard = "clipboard" in o ? o.clipboard : { writeText: vi.fn(async () => {}) };
  let current: unknown = o.initial ?? detail();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url === "/api/admin/session") return reply(200, SESSION);
    const custom = o.respond?.(call);
    if (custom) return custom;
    if (url === BASE && call.method === "GET") return o.getStatus ? reply(o.getStatus, { error: { code: "x" } }) : reply(200, current);
    throw new Error(`unexpected ${call.method} ${url}`);
  });
  await init({
    document, fetch: fetch as unknown as typeof globalThis.fetch, navigate,
    location: { origin: ORIGIN, search: o.search ?? `?slug=${SLUG}` }, clipboard: clipboard as never,
    ...(o.navigator ? { navigator: o.navigator as never } : {}), ...(o.settings ? { settings: o.settings as never } : {}),
  });
  return {
    calls, navigate, clipboard: clipboard as { writeText: ReturnType<typeof vi.fn> },
    setDetail: (d: unknown) => { current = d; },
  };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const text = () => document.body.textContent ?? "";
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const rows = () => $$(".sched > li");
const row = (time: string) => $$(".sched-row").find((r) => r.querySelector(".sched-time")!.textContent === time)!;
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent === name)!;
const submit = (form: Element) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const statusText = () => $(".sched-status").textContent;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.url !== "/api/admin/session");
const options = (select: HTMLElement) => [...select.querySelectorAll("option")].filter((o) => o.value !== "").map((o) => o.textContent);

afterEach(() => { document.body.innerHTML = ""; });

describe("loading and rendering", () => {
  it("tags an unlisted event Not listed, and a listed one (or one with no flag) not at all", async () => {
    await start({ initial: detail(undefined, undefined, undefined, { ...EVENT, listed: false }) });
    expect($$(".badge").map((b) => b.textContent)).toEqual(["Not listed"]);
    await start({ initial: detail(undefined, undefined, undefined, { ...EVENT, listed: true }) });
    expect($$(".badge")).toHaveLength(0);
    await start();
    expect($$(".badge")).toHaveLength(0);
  });

  it("shows the event, the London date, the links, and every slot and break in time order", async () => {
    const { calls } = await start();
    expect(calls.map((c) => c.url)).toEqual(["/api/admin/session", BASE]);
    expect($("h1").textContent).toBe("Schedule");
    expect($(".event-name").textContent).toBe("Trial Day");
    expect($(".sched-date").textContent).toBe("Saturday 13 June 2026");
    const edit = $$("a").find((a) => a.textContent === "Edit event")!;
    expect(edit.getAttribute("href")).toBe(`/admin/edit?slug=${SLUG}`);
    expect($$("a").find((a) => a.textContent === "Open public page")!.getAttribute("href")).toBe(`/e/${SLUG}`);
    expect(rows().map((r) => r.querySelector(".sched-time")!.textContent)).toEqual(["09:00", "09:15", "09:30", "09:45–10:15", "10:15", "10:30"]);
    expect(rows()[3].className).toBe("sched-break");
    expect(rows()[3].textContent).toContain("Lunch");
  });

  it("has a Download CSV link: a plain same-origin download of this event's export, styled as a button", async () => {
    await start();
    const link = $$("a").find((a) => a.textContent === "Download CSV")!;
    expect(link.getAttribute("href")).toBe(`${BASE}/export.csv`);
    expect(link.hasAttribute("download")).toBe(true);
    expect(link.className).toBe("button");
    expect(link.parentElement!.className).toBe("actions");
  });

  it("shows booked slots with dog, handler and Move, Swap and Clear; free slots with Add booking", async () => {
    await start();
    const booked = row("09:15");
    expect(booked.querySelector(".sched-who")!.textContent).toBe("Rex (Sam Smith)");
    expect([...booked.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Move", "Swap", "Clear"]);
    const free = row("09:00");
    expect(free.querySelector(".sched-who")!.textContent).toBe("Free");
    expect([...free.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Add booking"]);
  });

  it("calls an unlabelled break Break", async () => {
    await start({ initial: detail(undefined, [], LINEUP, { ...EVENT, breaks: [{ ...EVENT.breaks[0], label: "" }] }) });
    expect(rows()[3].textContent).toBe("09:45–10:15Break");
  });

  it("puts orphans in a 'Not in the schedule' section with Clear and Move only", async () => {
    await start({ initial: detail(undefined, [LOST]) });
    const section = $(".sched-orphans");
    expect(section.querySelector("h2")!.textContent).toBe("Not in the schedule");
    const orphan = section.querySelector("li")!;
    expect(orphan.textContent).toContain("Lost (Lou)");
    expect(orphan.textContent).toContain("Saturday 13 June 2026, 08:00");
    expect([...orphan.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Move", "Clear"]);
  });

  it("has no orphans section when there are none", async () => {
    await start();
    expect($(".sched-orphans")).toBeNull();
  });

  it("keeps hostile names inert everywhere they appear", async () => {
    const hostile = { id: 21, fields: dh(HOSTILE, `<b>${HOSTILE}</b>`) };
    await start({ initial: detail([null, hostile, null, FLO, null], [{ ...LOST, fields: dh(HOSTILE, "Lou") }], LINEUP, { ...EVENT, name: HOSTILE, breaks: [{ ...EVENT.breaks[0], label: HOSTILE }] }) });
    expect(document.querySelector("img")).toBeNull();
    expect($(".event-name").textContent).toBe(HOSTILE);
    expect(row("09:15").querySelector(".sched-who")!.textContent).toBe(`${HOSTILE} (<b>${HOSTILE}</b>)`);
    button(row("10:15"), "Swap").click();
    expect(options($("select"))[0]).toContain(HOSTILE);
    button(row("10:15"), "Clear").click();
    button(row("09:15"), "Clear").click();
    expect($(".sched-panel").textContent).toContain(HOSTILE);
    expect(document.querySelector("img, b")).toBeNull();
  });

  it("answers an unknown event with a not-found message and a way back", async () => {
    await start({ getStatus: 404 });
    expect($("[role=alert]").textContent).toContain("We couldn't find that event");
    expect($$("a").some((a) => a.getAttribute("href") === "/admin/")).toBe(true);
  });

  it("does not call the server for a missing or malformed slug", async () => {
    for (const search of ["", "?slug=", "?slug=nope", `?slug=${"x".repeat(100)}`]) {
      const { calls } = await start({ search });
      expect(calls.map((c) => c.url), search).toEqual(["/api/admin/session"]);
      expect($("[role=alert]").textContent).toContain("We couldn't find that event");
    }
  });

  it("offers a retry when loading fails", async () => {
    await start({ getStatus: 500 });
    expect($("[role=alert]").textContent).toContain("We couldn't load the schedule");
    expect(button(document.body, "Retry")).toBeDefined();
  });
});

describe("Copy lineup", () => {
  it("writes the lineup from the loaded data synchronously, without fetching, and says Copied", async () => {
    const { calls, clipboard } = await start();
    const before = calls.length;
    button(document.body, "Copy lineup").click();
    expect(clipboard.writeText).toHaveBeenCalledTimes(1); // inside the click, before any await
    expect(clipboard.writeText).toHaveBeenCalledWith(LINEUP);
    await settle();
    expect(statusText()).toBe("Copied");
    expect($(".sched-status").getAttribute("aria-live")).toBe("polite");
    expect(calls).toHaveLength(before);
  });

  it("falls back to a selected read-only textarea when the clipboard rejects", async () => {
    await start({ clipboard: { writeText: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }) } });
    button(document.body, "Copy lineup").click();
    await settle();
    const box = $("textarea") as HTMLTextAreaElement;
    expect(box.value).toBe(LINEUP);
    expect(box.hasAttribute("readonly")).toBe(true);
    expect(box.closest("[hidden]")).toBeNull();
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(LINEUP.length);
    expect(statusText()).toContain("Copy it from here");
  });

  it("falls back when there is no clipboard API", async () => {
    await start({ clipboard: undefined });
    button(document.body, "Copy lineup").click();
    await settle();
    expect(($("textarea") as HTMLTextAreaElement).value).toBe(LINEUP);
    expect(statusText()).toContain("Copy it from here");
  });
});

describe("Clear", () => {
  it("opens an inline confirmation naming the time, dog and handler, and sends nothing until the danger button is clicked", async () => {
    const { calls } = await start({
      respond: (c) => (c.method === "DELETE" ? reply(200, { removed: { ...REX, slotStart: S[1] } }) : undefined),
    });
    button(row("09:15"), "Clear").click();
    const panel = $(".sched-panel");
    expect(panel.textContent).toContain("09:15: Rex (Sam Smith)");
    expect(button(panel, "Clear booking").className).toContain("danger");
    expect(document.activeElement).toBe(button(panel, "Cancel")); // not the destructive button
    expect(writes(calls)).toEqual([]);
    button(panel, "Clear booking").click();
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings/11`, method: "DELETE", body: { confirm: true } }]);
  });

  it("Cancel closes the panel, sends nothing and returns focus to Clear", async () => {
    const { calls } = await start();
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Cancel").click();
    expect($(".sched-panel")).toBeNull();
    expect(writes(calls)).toEqual([]);
    expect(calls).toHaveLength(2); // session and the first load only
    expect(document.activeElement).toBe(button(row("09:15"), "Clear"));
  });

  it("refreshes after success, shows the slot free, announces it and focuses the refreshed row", async () => {
    const { calls, setDetail } = await start({ respond: (c) => (c.method === "DELETE" ? reply(200, { removed: { ...REX, slotStart: S[1] } }) : undefined) });
    setDetail(detail([null, null, null, FLO, null]));
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect(calls.map((c) => `${c.method} ${c.url}`).slice(-2)).toEqual([`DELETE ${BASE}/bookings/11`, `GET ${BASE}`]);
    expect(row("09:15").querySelector(".sched-who")!.textContent).toBe("Free");
    expect($(".sched-panel")).toBeNull();
    expect(statusText()).toBe("Cleared Rex (Sam Smith) from 09:15.");
    expect(document.activeElement).toBe(row("09:15"));
  });

  it("clears an orphan, then focuses the live region because its row has gone", async () => {
    const { setDetail } = await start({ initial: detail(undefined, [LOST]), respond: (c) => (c.method === "DELETE" ? reply(200, { removed: LOST }) : undefined) });
    setDetail(detail());
    button($(".sched-orphans li"), "Clear").click();
    expect($(".sched-panel").textContent).toContain("Lost (Lou)");
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect($(".sched-orphans")).toBeNull();
    expect(document.activeElement).toBe($(".sched-status"));
  });

  it("says the booking has already gone, and refreshes, when it is a 404 (cleared twice)", async () => {
    const { calls } = await start({ respond: (c) => (c.method === "DELETE" ? reply(404, { error: { code: "not_found" } }) : undefined) });
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect(statusText()).toBe("That changed while you were working. The schedule has been refreshed.");
    expect(calls.at(-1)!.method).toBe("GET");
  });
});

describe("Move", () => {
  const moved = { booking: { ...REX, slotStart: S[4] } };

  it("lists only free slots, and needs a choice before it sends anything", async () => {
    const { calls } = await start();
    button(row("09:15"), "Move").click();
    expect(options($("select"))).toEqual(["09:00", "09:30", "10:30"]);
    submit($(".sched-panel"));
    expect($(".sched-panel .field-error").textContent).toBe("Choose a slot.");
    expect(writes(calls)).toEqual([]);
  });

  it("sends fromSlot and toSlot, refreshes and announces", async () => {
    const { calls, setDetail } = await start({ respond: (c) => (c.method === "POST" ? reply(200, moved) : undefined) });
    setDetail(detail([null, null, null, FLO, REX]));
    button(row("09:15"), "Move").click();
    const select = $("select") as HTMLSelectElement;
    select.value = S[4];
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings/11/move`, method: "POST", body: { fromSlot: S[1], toSlot: S[4] } }]);
    expect(calls.at(-1)!.method).toBe("GET");
    expect(statusText()).toBe("Moved Rex (Sam Smith) from 09:15 to 10:30.");
    expect(row("10:30").querySelector(".sched-who")!.textContent).toBe("Rex (Sam Smith)");
    expect(document.activeElement).toBe(row("10:30"));
  });

  it("moves an orphan into a free slot, sending the orphan's own slot as fromSlot", async () => {
    const { calls } = await start({ initial: detail(undefined, [LOST]), respond: (c) => (c.method === "POST" ? reply(200, moved) : undefined) });
    button($(".sched-orphans li"), "Move").click();
    ($("select") as HTMLSelectElement).value = S[0];
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)[0].body).toEqual({ fromSlot: LOST.slotStart, toSlot: S[0] });
  });

  it("says who holds a slot that was just taken, and refreshes", async () => {
    const { calls } = await start({
      respond: (c) => (c.method === "POST" ? reply(409, { error: { code: "slot_taken" }, bookings: [{ id: 99, fields: dh("Zed", "Zoe Zee") }] }) : undefined),
    });
    button(row("09:15"), "Move").click();
    ($("select") as HTMLSelectElement).value = S[0];
    submit($(".sched-panel"));
    await settle();
    expect(statusText()).toBe("That slot is already taken by Zed (Zoe Zee).");
    expect(calls.at(-1)!.method).toBe("GET");
    expect($(".sched-panel")).toBeNull();
    expect(document.activeElement).toBe($(".sched-status"));
  });

  it("says so when there is no free slot", async () => {
    await start({ initial: detail([REX, REX, REX, FLO, FLO]) });
    button(row("09:15"), "Move").click();
    expect($(".sched-panel").textContent).toContain("There are no free slots");
    expect($("select")).toBeNull();
  });
});

describe("Swap", () => {
  it("lists only the other booked slots", async () => {
    await start({ initial: detail([REX, FLO, null, { id: 14, fields: dh("Cy", "Dee") }, null]) });
    button(row("09:15"), "Swap").click();
    expect(options($("select"))).toEqual(["09:00: Rex (Sam Smith)", "10:15: Cy (Dee)"]);
  });

  it("sends both ids with the slots the admin saw, refreshes and announces", async () => {
    const { calls, setDetail } = await start({
      respond: (c) => (c.method === "POST" ? reply(200, { a: { id: 11, slotStart: S[3] }, b: { id: 12, slotStart: S[1] } }) : undefined),
    });
    setDetail(detail([null, FLO, null, REX, null]));
    button(row("09:15"), "Swap").click();
    expect(options($("select"))).toEqual(["10:15: Flo (Pat Jones)"]);
    ($("select") as HTMLSelectElement).value = S[3];
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings/swap`, method: "POST", body: { a: { id: 11, slot: S[1] }, b: { id: 12, slot: S[3] } } }]);
    expect(statusText()).toBe("Swapped Rex (09:15) with Flo (10:15).");
    expect(row("09:15").querySelector(".sched-who")!.textContent).toBe("Flo (Pat Jones)");
  });

  it("says so when there is nothing to swap with", async () => {
    await start({ initial: detail([null, REX, null, null, null]) });
    button(row("09:15"), "Swap").click();
    expect($(".sched-panel").textContent).toContain("There's no other booking to swap with");
  });
});

describe("Add booking", () => {
  it("opens a form for the slot, with focus in the dog field, and sends the names as typed", async () => {
    const { calls, setDetail } = await start({
      respond: (c) => (c.method === "POST" ? reply(201, { booking: { id: 30, slotStart: S[0], fields: dh("Newt", "Nan Ng") } }) : undefined),
    });
    setDetail(detail([{ id: 30, fields: dh("Newt", "Nan Ng") }, REX, null, FLO, null]));
    button(row("09:00"), "Add booking").click();
    expect(document.activeElement).toBe($("#add-field-1"));
    expect($(".sched-panel h3").textContent).toBe("Add booking at 09:00");
    ($("#add-field-1") as HTMLInputElement).value = "  Newt ";
    ($("#add-field-2") as HTMLInputElement).value = "Nan Ng";
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings`, method: "POST", body: { slot: S[0], field1: "  Newt ", field2: "Nan Ng" } }]);
    expect(statusText()).toBe("Added Newt (Nan Ng) at 09:00.");
    expect(row("09:00").querySelector(".sched-who")!.textContent).toBe("Newt (Nan Ng)");
    expect(document.activeElement).toBe(row("09:00"));
  });

  it("shows the server's messages against the right field and keeps what was typed", async () => {
    const { calls } = await start({
      respond: (c) => (c.method === "POST"
        ? reply(400, { error: { code: "invalid_input" }, fields: { field1: "Dog is required.", field2: "Handler must be at most 80 characters." } })
        : undefined),
    });
    button(row("09:00"), "Add booking").click();
    ($("#add-field-2") as HTMLInputElement).value = "x";
    submit($(".sched-panel"));
    await settle();
    expect($("#add-field-1-error").textContent).toBe("Dog is required.");
    expect($("#add-field-2-error").textContent).toBe("Handler must be at most 80 characters.");
    expect($("#add-field-1").getAttribute("aria-invalid")).toBe("true");
    expect($("#add-field-1").getAttribute("aria-describedby")).toBe("add-field-1-error");
    expect(($("#add-field-2") as HTMLInputElement).value).toBe("x");
    expect(document.activeElement).toBe($("#add-field-1"));
    expect(calls.filter((c) => c.method === "GET" && c.url === BASE)).toHaveLength(1); // no refresh
    expect($$<HTMLButtonElement>("button").every((b) => !b.disabled)).toBe(true);
  });

  it("lets an empty submit reach the server, so its '{Label} is required.' shows: a real submit is not stopped by the browser's own checks", async () => {
    const { calls } = await start({
      respond: (c) => (c.method === "POST"
        ? reply(400, { error: { code: "invalid_input" }, fields: { field1: "Dog is required.", field2: "Handler is required." } })
        : undefined),
    });
    button(row("09:00"), "Add booking").click();
    const form = $(".sched-panel") as HTMLFormElement;
    expect(form.noValidate).toBe(true);
    // The inputs still say what is required and how long, for assistive technology and for typing.
    expect(($("#add-field-1") as HTMLInputElement).required).toBe(true);
    expect(($("#add-field-1") as HTMLInputElement).maxLength).toBe(80);
    // Pressing the button in a browser is requestSubmit(): the browser runs its own checks first, unless the form has novalidate.
    form.requestSubmit();
    await settle();
    expect(writes(calls)).toHaveLength(1);
    expect($("#add-field-1-error").textContent).toBe("Dog is required.");
    expect($("#add-field-2-error").textContent).toBe("Handler is required.");
    // A submit event dispatched by hand (what the golden replay does) reaches the server too.
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toHaveLength(2);
  });

  it("says in plain English when the dog and handler already have a booking, with the time", async () => {
    await start({
      respond: (c) => (c.method === "POST"
        ? reply(409, { error: { code: "duplicate_booking" }, booking: { id: 11, slotStart: S[1], fields: dh("Rex", "Sam Smith") } })
        : undefined),
    });
    button(row("09:00"), "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect($(".sched-panel .form-error").textContent).toBe("Rex and Sam Smith already have a booking at 09:15.");
    expect($(".sched-panel")).not.toBeNull();
  });

  it("says in plain English who holds a slot that was just taken, and refreshes", async () => {
    const { calls } = await start({
      respond: (c) => (c.method === "POST" ? reply(409, { error: { code: "slot_taken" }, bookings: [{ id: 11, fields: dh("Rex", "Sam Smith") }] }) : undefined),
    });
    button(row("09:00"), "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect(statusText()).toBe("That slot is already taken by Rex (Sam Smith).");
    expect(calls.at(-1)!.method).toBe("GET");
    expect($(".sched-panel")).toBeNull();
  });

  it("returns focus to Add booking when cancelled", async () => {
    await start();
    button(row("09:00"), "Add booking").click();
    button($(".sched-panel"), "Cancel").click();
    expect(document.activeElement).toBe(button(row("09:00"), "Add booking"));
  });
});

describe("changes made while working, and requests in flight", () => {
  it("refreshes with the plain message on 409 changed and on 409 event_changed", async () => {
    for (const code of ["changed", "event_changed"]) {
      const { calls } = await start({ respond: (c) => (c.method === "POST" ? reply(409, { error: { code } }) : undefined) });
      button(row("09:15"), "Move").click();
      ($("select") as HTMLSelectElement).value = S[0];
      submit($(".sched-panel"));
      await settle();
      expect(statusText(), code).toBe("That changed while you were working. The schedule has been refreshed.");
      expect(calls.at(-1)!.method, code).toBe("GET");
      expect($(".sched-panel"), code).toBeNull();
      expect(document.activeElement, code).toBe($(".sched-status"));
    }
  });

  it("refreshes with the plain message on 400 invalid_slot from add, move and swap (an edit removed the slot)", async () => {
    const open: Record<string, () => void> = {
      add: () => { button(row("09:00"), "Add booking").click(); },
      move: () => { button(row("09:15"), "Move").click(); ($("select") as HTMLSelectElement).value = S[0]; },
      swap: () => { button(row("09:15"), "Swap").click(); ($("select") as HTMLSelectElement).value = S[3]; },
    };
    for (const kind of Object.keys(open)) {
      const { calls } = await start({
        respond: (c) => (c.method === "POST" ? reply(400, { error: { code: "invalid_slot", message: "That time isn't one of this event's slots." } }) : undefined),
      });
      open[kind]();
      submit($(".sched-panel"));
      await settle();
      expect(statusText(), kind).toBe("That changed while you were working. The schedule has been refreshed.");
      expect(calls.at(-1)!.method, kind).toBe("GET");
      expect($(".sched-panel"), kind).toBeNull();
      expect(document.activeElement, kind).toBe($(".sched-status"));
    }
  });

  it("disables every button while a request is in flight and ignores a second submit", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((r) => { release = r; });
    const { calls } = await start({ respond: (c) => (c.method === "DELETE" ? pending : undefined) });
    button(row("09:15"), "Clear").click();
    const confirm = button($(".sched-panel"), "Clear booking");
    confirm.click();
    await settle();
    expect($$<HTMLButtonElement>("button, select, input").every((el) => el.disabled)).toBe(true);
    confirm.click();
    button(row("09:00"), "Add booking").click();
    await settle();
    expect(writes(calls)).toHaveLength(1);
    release(reply(200, { removed: { ...REX, slotStart: S[1] } }));
    await settle();
    expect($$<HTMLButtonElement>("button").every((b) => !b.disabled)).toBe(true);
  });

  it("re-enables everything and says so when the network fails", async () => {
    await start({ respond: (c) => { if (c.method === "DELETE") throw new TypeError("offline"); return undefined; } });
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect(statusText()).toContain("couldn't reach the server");
    expect($$<HTMLButtonElement>("button").every((b) => !b.disabled)).toBe(true);
    expect($(".sched-panel")).not.toBeNull();
  });

  it("reports a refused action with the server's message when it is nothing it knows how to recover from", async () => {
    await start({ respond: (c) => (c.method === "DELETE" ? reply(500, { error: { code: "internal_error", message: "Something went wrong. Please try again." } }) : undefined) });
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect(statusText()).toBe("Something went wrong. Please try again.");
    expect($$<HTMLButtonElement>("button").every((b) => !b.disabled)).toBe(true);
  });

  it("uses the shared session handling: a stale CSRF token gets one fresh session and one retry", async () => {
    let attempts = 0;
    const { calls } = await start({
      respond: (c) => {
        if (c.method !== "DELETE") return undefined;
        attempts += 1;
        return attempts === 1 ? reply(403, { error: { code: "csrf_failed" } }) : reply(200, { removed: { ...REX, slotStart: S[1] } });
      },
    });
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect(calls.filter((c) => c.url === "/api/admin/session")).toHaveLength(2); // the first load, then the fresh one after csrf_failed
    expect(writes(calls)).toHaveLength(2);
    expect(statusText()).toContain("Cleared Rex");
  });
});

describe("Share", () => {
  // EVENT ends 2026-06-13T09:45:00Z: the clock is set to a moment before it, as only an event that has not ended is shared.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-06-13T07:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });
  const SHARE_EVENT = { ...EVENT, details: "Bring water", shareMessage: "", costPence: 1500 };
  const BUILT_IN = `Trial Day\nSaturday 13 June 2026, 09:00–10:45\nVenue: AB1 2CD\nCost: £15.00\nBook your slot:\nhttps://club.example/e/${SLUG}`;
  const withShare = () => ({ share: vi.fn(async () => {}) });
  const shareButton = () => $$("button").find((b) => b.textContent === "Share") as HTMLButtonElement | undefined;
  const withDetail = (event: unknown, defaultShareMessage?: string) => ({ ...detail(undefined, undefined, undefined, event), ...(defaultShareMessage === undefined ? {} : { defaultShareMessage }) });
  const sent = (share: ReturnType<typeof vi.fn>, n = 0) => (share.mock.calls[n][0] as { text: string }).text;

  it("sits under the date line, before the other actions", async () => {
    await start({ navigator: withShare(), initial: withDetail(SHARE_EVENT) });
    expect(shareButton()!.getAttribute("aria-label")).toBe('Share "Trial Day"');
    expect($(".sched-date").nextElementSibling).toBe($(".share"));
    expect($(".share").nextElementSibling!.className).toBe("actions");
  });

  it("is absent for an archived event", async () => {
    await start({ navigator: withShare(), initial: withDetail({ ...SHARE_EVENT, archived: true }) });
    expect($$(".share")).toHaveLength(0);
    expect(shareButton()).toBeUndefined();
    expect($$("button").map((b) => b.textContent)).not.toContain("Copy message");
  });

  it("is absent once the event has ended, including at the very moment it ends, and present a millisecond before", async () => {
    vi.setSystemTime(new Date("2026-06-13T09:45:00Z"));
    await start({ navigator: withShare(), initial: withDetail(SHARE_EVENT) });
    expect($$(".share")).toHaveLength(0);
    vi.setSystemTime(new Date("2026-06-14T00:00:00Z"));
    await start({ navigator: withShare(), initial: withDetail(SHARE_EVENT) });
    expect($$(".share")).toHaveLength(0);
    vi.setSystemTime(new Date("2026-06-13T09:44:59.999Z"));
    await start({ navigator: withShare(), initial: withDetail(SHARE_EVENT) });
    expect($$(".share")).toHaveLength(1);
  });

  it("is absent when the event has no readable end", async () => {
    await start({ navigator: withShare(), initial: withDetail({ ...SHARE_EVENT, endUtc: undefined }) });
    expect($$(".share")).toHaveLength(0);
  });

  it("shares the built-in message, as text only, in the tap itself", async () => {
    const navigator = withShare();
    await start({ navigator, initial: withDetail(SHARE_EVENT) });
    shareButton()!.click();
    expect(navigator.share).toHaveBeenCalledTimes(1);
    expect(navigator.share.mock.calls[0]).toEqual([{ text: BUILT_IN }]);
  });

  it("prefers the event's own message, then the default template's, then the built-in one", async () => {
    const own = withShare();
    await start({ navigator: own, initial: withDetail({ ...SHARE_EVENT, shareMessage: "Own: {event} {details}" }, "Default: {event}") });
    shareButton()!.click();
    expect(sent(own.share)).toBe(`Own: Trial Day Bring water\nhttps://club.example/e/${SLUG}`);
    const def = withShare();
    await start({ navigator: def, initial: withDetail(SHARE_EVENT, "Default: {event} at {postcode}") });
    shareButton()!.click();
    expect(sent(def.share)).toBe(`Default: Trial Day at AB1 2CD\nhttps://club.example/e/${SLUG}`);
    const none = withShare();
    await start({ navigator: none, initial: withDetail(SHARE_EVENT, "") });
    shareButton()!.click();
    expect(sent(none.share)).toBe(BUILT_IN);
  });

  it("fills {lanes} from the event's lanes, and drops the line when there is one unnamed lane", async () => {
    const message = "Rings: {lanes}\n{link}";
    const named = withShare();
    await start({ navigator: named, initial: withDetail({ ...SHARE_EVENT, shareMessage: message, lanes: [{ id: 1, name: "Ring 1" }, { id: 2, name: "Ring 2" }] }) });
    shareButton()!.click();
    expect(sent(named.share)).toBe(`Rings: Ring 1, Ring 2\nhttps://club.example/e/${SLUG}`);
    const unnamed = withShare();
    await start({ navigator: unnamed, initial: withDetail({ ...SHARE_EVENT, shareMessage: "{lanes}\n{event}", lanes: [{ id: 1, name: "" }] }) });
    shareButton()!.click();
    expect(sent(unnamed.share)).toBe(`Trial Day\nhttps://club.example/e/${SLUG}`);
  });

  it("puts the club name first when the settings loaded with one", async () => {
    const navigator = withShare();
    await start({ navigator, initial: withDetail(SHARE_EVENT), settings: Promise.resolve({ clubName: "Hillside Dog Club", loaded: true }) });
    shareButton()!.click();
    expect(sent(navigator.share)).toBe(`Hillside Dog Club\n${BUILT_IN}`);
  });

  it("offers Copy message beside Share where navigator.share exists, and Copy link only as a fallback", async () => {
    const navigator = withShare();
    const { clipboard } = await start({ navigator, initial: withDetail(SHARE_EVENT) });
    expect($$(".share button").map((b) => [b.textContent, b.hidden])).toEqual([["Share", false], ["Copy message", false], ["Copy link", true]]);
    $$("button").find((b) => b.textContent === "Copy message")!.click();
    await settle();
    expect(clipboard.writeText).toHaveBeenCalledWith(BUILT_IN);
    expect(navigator.share).not.toHaveBeenCalled();
  });

  it("offers Copy message and Copy link where navigator.share is missing", async () => {
    const { clipboard } = await start({ navigator: {}, initial: withDetail(SHARE_EVENT) });
    expect(shareButton()).toBeUndefined();
    const copy = $$("button").find((b) => b.textContent === "Copy message")!;
    copy.click();
    await settle();
    expect(clipboard.writeText).toHaveBeenCalledWith(BUILT_IN);
    expect($(".share-status").textContent).toBe("Copied");
    expect($(".sched-status").textContent).toBe(""); // the page's own live region is left alone
  });

  it("builds the message from the event as it is after a refresh", async () => {
    const navigator = withShare();
    const ctx = await start({
      navigator, initial: withDetail({ ...SHARE_EVENT, shareMessage: "Before {event}" }),
      respond: (c) => (c.url.endsWith("/bookings") && c.method === "POST" ? reply(201, { booking: { id: 99, fields: dh("Zed", "Zoe") } }) : undefined),
    });
    shareButton()!.click();
    expect(sent(navigator.share, 0)).toBe(`Before Trial Day\nhttps://club.example/e/${SLUG}`);
    ctx.setDetail(withDetail({ ...SHARE_EVENT, name: "Renamed", shareMessage: "After {event}" }));
    button(row("09:00"), "Add booking").click();
    const form = $("form");
    (document.getElementById("add-field-1") as HTMLInputElement).value = "Zed";
    (document.getElementById("add-field-2") as HTMLInputElement).value = "Zoe";
    submit(form);
    await vi.waitFor(() => expect($(".event-name").textContent).toBe("Renamed"));
    shareButton()!.click();
    expect(sent(navigator.share, 1)).toBe(`After Renamed\nhttps://club.example/e/${SLUG}`);
    expect(shareButton()!.getAttribute("aria-label")).toBe('Share "Renamed"');
  });

  it("keeps a hostile name and details inert", async () => {
    const navigator = withShare();
    await start({
      navigator, clipboard: null,
      initial: withDetail({ ...SHARE_EVENT, name: HOSTILE, details: HOSTILE, shareMessage: "{event} {details}" }),
    });
    expect($$("img")).toHaveLength(0);
    expect(document.querySelector("[onerror]")).toBeNull();
    shareButton()!.click();
    expect(sent(navigator.share)).toBe(`${HOSTILE} ${HOSTILE}\nhttps://club.example/e/${SLUG}`);
  });
});

// ---- lanes and places ----
type Held = { id: number; fields: { label: string; value: string }[] };
const RING = [{ id: 1, name: "Ring 1" }, { id: 2, name: "Ring 2" }, { id: 3, name: "Ring 3" }];
const CY = { id: 14, fields: dh("Cy", "Dee") };
/** A detail for `lanes` with `capacity` places each: `held` says who is where, as "slotIndex:laneIndex" -> bookings. */
function laneDetail(lanes: { id: number; name: string }[], capacity: number, held: Record<string, Held[]> = {}, orphans: unknown[] = [], extra: object = {}) {
  return {
    event: { ...EVENT, lanes, capacity, ...extra }, orphans, lineup: LINEUP,
    slots: S.map((start, i) => ({
      start, end: start,
      places: lanes.map((l, j) => {
        const bookings = held[`${i}:${j}`] ?? [];
        return { laneId: l.id, laneName: l.name, bookings, free: capacity - bookings.length };
      }),
    })),
  };
}
const HELD = { "1:0": [REX, FLO], "3:1": [CY] }; // 09:15 Ring 1 is full; 10:15 Ring 2 has Cy
const threeByTwo = (o: Record<string, Held[]> = HELD, orphans: unknown[] = []) => laneDetail(RING, 2, o, orphans);
const group = (time: string) => $$(".sched-group").find((g) => g.querySelector(".sched-time")!.textContent === time)!;
const subs = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>(".sched-place")];
const subText = (li: Element) => [...li.querySelectorAll(".sched-line > span")].map((s) => s.textContent);
const subRow = (g: HTMLElement, lane: string, who: string) => subs(g).find((li) => subText(li).join("|") === `${lane}|${who}`)!;

describe("lanes and places: one lane with one place", () => {
  it("is the v1.0 DOM byte for byte when the one lane is unnamed (whether or not the event lists it)", async () => {
    await start();
    const v1 = $(".sched").innerHTML;
    await start({ initial: { ...detail(), event: { ...EVENT, lanes: [{ id: 1, name: "" }], capacity: 1 } } });
    expect($(".sched").innerHTML).toBe(v1);
    expect($$(".sched-group")).toHaveLength(0);
  });

  it("names a single named lane in each row, and still sends no lane", async () => {
    const { calls } = await start({
      initial: { ...detail(), event: { ...EVENT, lanes: [{ id: 1, name: "Main ring" }], capacity: 1 } },
      respond: (c) => (c.method === "POST" ? reply(200, { booking: { ...REX, slotStart: S[2] } }) : undefined),
    });
    expect(rows()[0].querySelector(".sched-lane")!.textContent).toBe("Main ring");
    expect(rows()[1].textContent).toBe("09:15Main ringRex (Sam Smith)MoveSwapClear");
    expect(button(row("09:15"), "Clear").getAttribute("aria-label")).toBe("Clear booking at 09:15 · Main ring");
    button(row("09:15"), "Clear").click();
    expect($(".sched-panel").textContent).toContain("09:15 · Main ring: Rex (Sam Smith)");
    button($(".sched-panel"), "Cancel").click();
    button(row("09:15"), "Move").click();
    expect(options($("select"))).toEqual(["09:00 · Main ring", "09:30 · Main ring", "10:30 · Main ring"]);
    ($("select") as HTMLSelectElement).value = S[2];
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings/11/move`, method: "POST", body: { fromSlot: S[1], toSlot: S[2] } }]);
  });
});

describe("lanes and places: the schedule with several lanes or places", () => {
  it("draws each time as a header with a free count, a row per booking and an Add row for each lane with room", async () => {
    await start({ initial: threeByTwo() });
    expect($$(".sched-row")).toHaveLength(0);
    expect(rows().map((r) => r.querySelector(".sched-time")!.textContent)).toEqual(["09:00", "09:15", "09:30", "09:45–10:15", "10:15", "10:30"]);
    expect(group("09:00").querySelector(".sched-line")!.textContent).toBe("09:006 free");
    expect(group("09:15").querySelector(".sched-line")!.textContent).toBe("09:154 free");
    expect(subs(group("09:00")).map((li) => subText(li).join("|"))).toEqual(["Ring 1|2 free", "Ring 2|2 free", "Ring 3|2 free"]);
    expect(subs(group("09:15")).map((li) => subText(li).join("|"))).toEqual([
      "Ring 1|Rex (Sam Smith)", "Ring 1|Flo (Pat Jones)", "Ring 2|2 free", "Ring 3|2 free",
    ]);
    expect(subs(group("10:15")).map((li) => subText(li).join("|"))).toEqual(["Ring 1|2 free", "Ring 2|Cy (Dee)", "Ring 2|1 free", "Ring 3|2 free"]);
    expect([...subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)").querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Move", "Swap", "Clear"]);
    expect([...subs(group("09:15"))[2].querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Add booking"]);
    expect(button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Move").getAttribute("aria-label")).toBe("Move Rex at 09:15 · Ring 1");
    expect(button(subs(group("09:15"))[2], "Add booking").getAttribute("aria-label")).toBe("Add booking at 09:15 · Ring 2");
  });

  it("says Full for a time with no place left, and has no Add row there", async () => {
    const all = Object.fromEntries(RING.flatMap((_, j) => [[`0:${j}`, [REX, FLO]]]));
    await start({ initial: laneDetail(RING, 2, all) });
    expect(group("09:00").querySelector(".sched-line")!.textContent).toBe("09:00Full");
    expect(subs(group("09:00")).flatMap((li) => [...li.querySelectorAll("button")].map((b) => b.textContent))).toEqual(
      ["Move", "Swap", "Clear", "Move", "Swap", "Clear", "Move", "Swap", "Clear", "Move", "Swap", "Clear", "Move", "Swap", "Clear", "Move", "Swap", "Clear"]);
  });

  it("uses the same layout, with no lane name, for one unnamed lane with more than one place", async () => {
    await start({ initial: laneDetail([{ id: 1, name: "" }], 3, { "1:0": [REX] }) });
    expect(subs(group("09:15")).map((li) => subText(li).join("|"))).toEqual(["Rex (Sam Smith)", "2 free"]);
    expect(group("09:15").querySelector(".sched-line")!.textContent).toBe("09:152 free");
    expect(button(subs(group("09:15"))[0], "Move").getAttribute("aria-label")).toBe("Move Rex at 09:15");
  });

  it("keeps names inert in the lane rows", async () => {
    const hostile = { id: 21, fields: dh(HOSTILE, HOSTILE) };
    await start({ initial: laneDetail([{ id: 1, name: HOSTILE }, { id: 2, name: "B" }], 1, { "1:0": [hostile] }) });
    expect(document.querySelector("img")).toBeNull();
    expect(subText(subs(group("09:15"))[0]).join("|")).toBe(`${HOSTILE}|${HOSTILE} (${HOSTILE})`);
  });

  it("opens one panel at a time, marking its button aria-expanded", async () => {
    await start({ initial: threeByTwo() });
    const rex = subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)");
    button(rex, "Clear").click();
    expect($$(".sched-panel")).toHaveLength(1);
    expect(button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Clear").getAttribute("aria-expanded")).toBe("true");
    expect(button(subRow(group("09:15"), "Ring 1", "Flo (Pat Jones)"), "Clear").getAttribute("aria-expanded")).toBe("false");
    button(subRow(group("09:15"), "Ring 1", "Flo (Pat Jones)"), "Swap").click();
    expect($$(".sched-panel")).toHaveLength(1);
  });
});

describe("lanes and places: Clear", () => {
  it("names the time and lane, sends the delete for that booking, and focuses the time's header afterwards", async () => {
    const { calls, setDetail } = await start({
      initial: threeByTwo(), respond: (c) => (c.method === "DELETE" ? reply(200, { removed: { ...FLO, slotStart: S[1] } }) : undefined),
    });
    button(subRow(group("09:15"), "Ring 1", "Flo (Pat Jones)"), "Clear").click();
    expect($(".sched-panel").textContent).toContain("09:15 · Ring 1: Flo (Pat Jones)");
    expect(document.activeElement).toBe(button($(".sched-panel"), "Cancel"));
    setDetail(threeByTwo({ ...HELD, "1:0": [REX] }));
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings/12`, method: "DELETE", body: { confirm: true } }]);
    expect(statusText()).toBe("Cleared Flo (Pat Jones) from 09:15 · Ring 1.");
    expect(document.activeElement).toBe(group("09:15"));
  });

  it("returns focus to the same row's Clear when cancelled", async () => {
    await start({ initial: threeByTwo() });
    button(subRow(group("09:15"), "Ring 1", "Flo (Pat Jones)"), "Clear").click();
    button($(".sched-panel"), "Cancel").click();
    expect(document.activeElement).toBe(button(subRow(group("09:15"), "Ring 1", "Flo (Pat Jones)"), "Clear"));
  });
});

describe("lanes and places: Move", () => {
  const moved = { booking: { ...REX, slotStart: S[0], lane: RING[1] } };

  it("lists every place with room as 'time · lane (n left)', leaving out the booking's own place, but keeping the same time in another lane", async () => {
    await start({ initial: threeByTwo() });
    button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Move").click();
    const list = options($("select"));
    expect(list).toHaveLength(5 * 3 - 1); // every (time, lane) with room, minus the full Ring 1 at 09:15 itself
    expect(list).toContain("09:15 · Ring 2 (2 left)");
    expect(list).toContain("09:15 · Ring 3 (2 left)");
    expect(list).not.toContain("09:15 · Ring 1 (0 left)");
    expect(list.filter((t) => t!.startsWith("09:15 · Ring 1"))).toEqual([]);
    expect(list).toContain("10:15 · Ring 2 (1 left)");
    expect(list[0]).toBe("09:00 · Ring 1 (2 left)");
  });

  it("keeps the booking's own place out of the list even when it has a place to spare", async () => {
    await start({ initial: threeByTwo() });
    button(subRow(group("10:15"), "Ring 2", "Cy (Dee)"), "Move").click();
    expect(options($("select")).filter((t) => t!.startsWith("10:15"))).toEqual(["10:15 · Ring 1 (2 left)", "10:15 · Ring 3 (2 left)"]);
  });

  it("sends fromSlot, fromLane, toSlot and toLane, then refreshes and says where it went", async () => {
    const { calls, setDetail } = await start({ initial: threeByTwo(), respond: (c) => (c.method === "POST" ? reply(200, moved) : undefined) });
    setDetail(threeByTwo({ "1:0": [FLO], "0:1": [REX], "3:1": [CY] }));
    button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Move").click();
    const choice = $$("option").find((o) => o.textContent === "09:00 · Ring 2 (2 left)") as HTMLOptionElement;
    ($("select") as HTMLSelectElement).value = choice.value;
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings/11/move`, method: "POST", body: { fromSlot: S[1], fromLane: 1, toSlot: S[0], toLane: 2 } }]);
    expect(statusText()).toBe("Moved Rex (Sam Smith) from 09:15 · Ring 1 to 09:00 · Ring 2.");
    expect(calls.at(-1)!.method).toBe("GET");
    expect(document.activeElement).toBe(group("09:00"));
  });

  it("can move within the same time to another lane", async () => {
    const { calls } = await start({ initial: threeByTwo(), respond: (c) => (c.method === "POST" ? reply(200, moved) : undefined) });
    button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Move").click();
    ($("select") as HTMLSelectElement).value = `${S[1]}|3`;
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)[0].body).toEqual({ fromSlot: S[1], fromLane: 1, toSlot: S[1], toLane: 3 });
  });

  it("needs a choice before it sends anything", async () => {
    const { calls } = await start({ initial: threeByTwo() });
    button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Move").click();
    submit($(".sched-panel"));
    expect($(".sched-panel .field-error").textContent).toBe("Choose a time and lane.");
    expect(writes(calls)).toEqual([]);
  });

  it("says so when no place has room", async () => {
    const all = Object.fromEntries(S.flatMap((_, i) => RING.map((__, j) => [`${i}:${j}`, [REX, FLO]])));
    await start({ initial: laneDetail(RING, 2, all) });
    button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Move").click();
    expect($(".sched-panel").textContent).toContain("There are no free places to move it to.");
  });

  it("says 'Ring 2 at 09:00 is full.' for a lane that filled meanwhile, and refreshes", async () => {
    const { calls } = await start({
      initial: threeByTwo(),
      respond: (c) => (c.method === "POST" ? reply(409, { error: { code: "slot_taken" }, bookings: [{ ...CY, slotStart: S[0], lane: RING[1] }] }) : undefined),
    });
    button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Move").click();
    ($("select") as HTMLSelectElement).value = `${S[0]}|2`;
    submit($(".sched-panel"));
    await settle();
    expect(statusText()).toBe("Ring 2 at 09:00 is full.");
    expect(calls.at(-1)!.method).toBe("GET");
    expect($(".sched-panel")).toBeNull();
    expect(document.activeElement).toBe($(".sched-status"));
  });

  it("moves an orphan out of a lane the event no longer has, naming the lane it was in", async () => {
    const orphan = { ...LOST, lane: { id: 9, name: "Old ring" } };
    const { calls } = await start({ initial: threeByTwo(HELD, [orphan]), respond: (c) => (c.method === "POST" ? reply(200, moved) : undefined) });
    const li = $(".sched-orphans li");
    expect(li.querySelector(".sched-lane")!.textContent).toBe("Old ring");
    button(li, "Move").click();
    expect(button(li, "Move").getAttribute("aria-label")).toBe("Move booking from Saturday 13 June 2026, 08:00 · Old ring");
    ($("select") as HTMLSelectElement).value = `${S[0]}|1`;
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)[0].body).toEqual({ fromSlot: LOST.slotStart, fromLane: 9, toSlot: S[0], toLane: 1 });
  });
});

describe("lanes and places: Swap", () => {
  it("lists the other bookings as 'time · lane: dog (handler)', whatever their lane", async () => {
    await start({ initial: threeByTwo() });
    button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Swap").click();
    expect(options($("select"))).toEqual(["09:15 · Ring 1: Flo (Pat Jones)", "10:15 · Ring 2: Cy (Dee)"]);
  });

  it("sends both ids with the time and lane the admin saw for each, and announces with the lanes", async () => {
    const { calls, setDetail } = await start({
      initial: threeByTwo(),
      respond: (c) => (c.method === "POST" ? reply(200, { a: { id: 11, slotStart: S[3], lane: RING[1] }, b: { id: 14, slotStart: S[1], lane: RING[0] } }) : undefined),
    });
    setDetail(threeByTwo({ "1:0": [CY, FLO], "3:1": [REX] }));
    button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Swap").click();
    ($("select") as HTMLSelectElement).value = "14";
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings/swap`, method: "POST", body: { a: { id: 11, slot: S[1], lane: 1 }, b: { id: 14, slot: S[3], lane: 2 } } }]);
    expect(statusText()).toBe("Swapped Rex (09:15 · Ring 1) with Cy (10:15 · Ring 2).");
    expect(document.activeElement).toBe(group("10:15"));
  });

  it("swaps two bookings in the same lane and time, which are told apart by name", async () => {
    const { calls } = await start({ initial: threeByTwo(), respond: (c) => (c.method === "POST" ? reply(200, { a: {}, b: {} }) : undefined) });
    button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Swap").click();
    ($("select") as HTMLSelectElement).value = "12";
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)[0].body).toEqual({ a: { id: 11, slot: S[1], lane: 1 }, b: { id: 12, slot: S[1], lane: 1 } });
  });

  it("says so when there is nothing to swap with", async () => {
    await start({ initial: threeByTwo({ "1:0": [REX] }) });
    button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Swap").click();
    expect($(".sched-panel").textContent).toContain("There's no other booking to swap with");
  });
});

describe("lanes and places: Add booking", () => {
  it("opens for that time and lane, sends laneId, and focuses the time's header afterwards", async () => {
    const { calls, setDetail } = await start({
      initial: threeByTwo(), respond: (c) => (c.method === "POST" ? reply(201, { booking: { id: 30, slotStart: S[0], fields: dh("Newt", "Nan Ng"), lane: RING[2] } }) : undefined),
    });
    setDetail(threeByTwo({ ...HELD, "0:2": [{ id: 30, fields: dh("Newt", "Nan Ng") }] }));
    button(subs(group("09:00"))[2], "Add booking").click();
    expect($(".sched-panel h3").textContent).toBe("Add booking at 09:00 · Ring 3");
    expect(document.activeElement).toBe($("#add-field-1"));
    ($("#add-field-1") as HTMLInputElement).value = "Newt";
    ($("#add-field-2") as HTMLInputElement).value = "Nan Ng";
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings`, method: "POST", body: { slot: S[0], laneId: 3, field1: "Newt", field2: "Nan Ng" } }]);
    expect(statusText()).toBe("Added Newt (Nan Ng) at 09:00 · Ring 3.");
    expect(subs(group("09:00")).map((li) => subText(li).join("|"))).toContain("Ring 3|Newt (Nan Ng)");
    expect(document.activeElement).toBe(group("09:00"));
  });

  it("returns focus to that lane's Add booking when cancelled", async () => {
    await start({ initial: threeByTwo() });
    button(subs(group("09:00"))[1], "Add booking").click();
    button($(".sched-panel"), "Cancel").click();
    expect(document.activeElement).toBe(button(subs(group("09:00"))[1], "Add booking"));
  });

  it("shows laneId and name errors against the form, keeping what was typed", async () => {
    await start({
      initial: threeByTwo(),
      respond: (c) => (c.method === "POST"
        ? reply(400, { error: { code: "invalid_input" }, fields: { laneId: "That isn't one of this event's lanes.", field1: "Dog is required." } })
        : undefined),
    });
    button(subs(group("09:00"))[0], "Add booking").click();
    ($("#add-field-2") as HTMLInputElement).value = "x";
    submit($(".sched-panel"));
    await settle();
    expect($(".sched-panel .form-error").textContent).toBe("That isn't one of this event's lanes.");
    expect($("#add-field-1-error").textContent).toBe("Dog is required.");
    expect(($("#add-field-2") as HTMLInputElement).value).toBe("x");
  });

  it("names the lane in a duplicate_booking answer", async () => {
    await start({
      initial: threeByTwo(),
      respond: (c) => (c.method === "POST"
        ? reply(409, { error: { code: "duplicate_booking" }, booking: { ...REX, slotStart: S[1], lane: RING[0] } })
        : undefined),
    });
    button(subs(group("09:00"))[0], "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect($(".sched-panel .form-error").textContent).toBe("Rex and Sam Smith already have a booking at 09:15 · Ring 1.");
  });

  it("says 'Ring 3 at 09:00 is full.' when the lane filled meanwhile, and refreshes", async () => {
    const { calls } = await start({
      initial: threeByTwo(), respond: (c) => (c.method === "POST" ? reply(409, { error: { code: "slot_taken" }, bookings: [] }) : undefined),
    });
    button(subs(group("09:00"))[2], "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect(statusText()).toBe("Ring 3 at 09:00 is full.");
    expect(calls.at(-1)!.method).toBe("GET");
  });

  it("says the lane is full, and does not name who holds the places, when the event has more than one place per time", async () => {
    await start({
      initial: laneDetail([{ id: 1, name: "" }], 2),
      respond: (c) => (c.method === "POST" ? reply(409, { error: { code: "slot_taken" }, bookings: [REX, FLO] }) : undefined),
    });
    button(subs(group("09:00"))[0], "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect(statusText()).toBe("09:00 is full.");
  });

  it("names the time alone when the one lane has no name", async () => {
    await start({
      initial: laneDetail([{ id: 1, name: "" }], 2),
      respond: (c) => (c.method === "POST" ? reply(409, { error: { code: "slot_taken" }, bookings: [] }) : undefined),
    });
    button(subs(group("09:00"))[0], "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect(statusText()).toBe("09:00 is full.");
  });

  it("refreshes on event_changed with the plain message", async () => {
    const { calls } = await start({
      initial: threeByTwo(), respond: (c) => (c.method === "POST" ? reply(409, { error: { code: "event_changed" } }) : undefined),
    });
    button(subs(group("09:00"))[0], "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect(statusText()).toBe("That changed while you were working. The schedule has been refreshed.");
    expect(calls.at(-1)!.method).toBe("GET");
  });

  it("disables every control while a request is in flight", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((r) => { release = r; });
    const { calls } = await start({ initial: threeByTwo(), respond: (c) => (c.method === "DELETE" ? pending : undefined) });
    button(subRow(group("09:15"), "Ring 1", "Rex (Sam Smith)"), "Clear").click();
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect($$<HTMLButtonElement>("button, select, input").every((el) => el.disabled)).toBe(true);
    button(subs(group("09:00"))[0], "Add booking").click();
    await settle();
    expect(writes(calls)).toHaveLength(1);
    release(reply(200, { removed: { ...REX, slotStart: S[1] } }));
    await settle();
    expect($$<HTMLButtonElement>("button").every((b) => !b.disabled)).toBe(true);
  });
});

// ---- configurable booking form ----
const field = (label: string, over: object = {}) => ({ label, required: true, maxLength: 80, identity: false, ...over });
const values = (...pairs: [string, string][]) => pairs.map(([label, value]) => ({ label, value }));
const withForm = (fields: object[], held: Booking[] = [null, null, null, null, null], orphans: unknown[] = []) =>
  detail(held, orphans, LINEUP, { ...EVENT, fields });
const labelsOf = () => $$(".sched-panel .field label").map((l) => l.textContent);
const inputsOf = () => $$<HTMLInputElement>(".sched-panel input");

describe("the booking form's fields: the Add booking panel", () => {
  it("has one input for each field, labelled with the bare label, in order, with focus in the first", async () => {
    for (const n of [1, 2, 3, 4]) {
      const form = [field("Name", { identity: true }), field("Owner"), field("Phone"), field("Car reg")].slice(0, n);
      await start({ initial: withForm(form) });
      button(row("09:00"), "Add booking").click();
      expect(labelsOf()).toEqual(form.map((f) => f.label));
      expect(inputsOf().map((i) => i.id)).toEqual(form.map((_, i) => `add-field-${i + 1}`));
      expect(document.activeElement).toBe(inputsOf()[0]);
      expect($$(".sched-panel .field-error")).toHaveLength(n);
    }
  });

  it("puts (optional) after an optional field's label, and sets maxlength and required from the field", async () => {
    await start({ initial: withForm([field("Name", { identity: true, maxLength: 30 }), field("Phone", { required: false, maxLength: 20 })]) });
    button(row("09:00"), "Add booking").click();
    expect(labelsOf()).toEqual(["Name", "Phone (optional)"]);
    expect(inputsOf().map((i) => [i.maxLength, i.required])).toEqual([[30, true], [20, false]]);
  });

  it("sends field1 to field4 and the lane when there is one, as typed", async () => {
    const form = [field("A", { identity: true }), field("B", { required: false }), field("C"), field("D", { required: false })];
    const { calls } = await start({ initial: withForm(form), respond: (c) => (c.method === "POST" ? reply(201, { booking: { id: 30, fields: values(["A", "a"]) } }) : undefined) });
    button(row("09:00"), "Add booking").click();
    inputsOf().forEach((input, i) => { input.value = ["a", "", "c", " d "][i]; });
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings`, method: "POST", body: { slot: S[0], field1: "a", field2: "", field3: "c", field4: " d " } }]);
    expect(statusText()).toBe("Added a at 09:00.");
  });

  it("maps field errors to their inputs by position, and focuses the first one with an error", async () => {
    const form = [field("A", { identity: true }), field("B"), field("C", { required: false })];
    await start({
      initial: withForm(form),
      respond: (c) => (c.method === "POST" ? reply(400, { error: { code: "invalid_input" }, fields: { field2: "B is required.", field3: "C must be at most 80 characters." } }) : undefined),
    });
    button(row("09:00"), "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect($("#add-field-1-error").textContent).toBe("");
    expect($("#add-field-1").hasAttribute("aria-invalid")).toBe(false);
    expect($("#add-field-2-error").textContent).toBe("B is required.");
    expect($("#add-field-3-error").textContent).toBe("C must be at most 80 characters.");
    expect($("#add-field-2").getAttribute("aria-describedby")).toBe("add-field-2-error");
    expect(document.activeElement).toBe($("#add-field-2"));
  });

  it("names only the fields that identify a booking in the duplicate message, and uses 'has' for one", async () => {
    const form = [field("Name", { identity: true }), field("Phone", { required: false })];
    await start({
      initial: withForm(form),
      respond: (c) => (c.method === "POST"
        ? reply(409, { error: { code: "duplicate_booking" }, booking: { id: 11, slotStart: S[1], fields: values(["Name", "Sam"], ["Phone", "0700"]) } })
        : undefined),
    });
    button(row("09:00"), "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect($(".sched-panel .form-error").textContent).toBe("Sam already has a booking at 09:15.");
    expect(document.activeElement).toBe($("#add-field-1"));
  });

  it("lists three identity values as 'A, B and C already have'", async () => {
    const form = [field("A", { identity: true }), field("B", { identity: true }), field("C", { identity: true })];
    await start({
      initial: withForm(form),
      respond: (c) => (c.method === "POST"
        ? reply(409, { error: { code: "duplicate_booking" }, booking: { id: 11, slotStart: S[1], fields: values(["A", "1"], ["B", "2"], ["C", "3"]) } })
        : undefined),
    });
    button(row("09:00"), "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect($(".sched-panel .form-error").textContent).toBe("1, 2 and 3 already have a booking at 09:15.");
  });
});

describe("the booking form's fields: how a booking reads", () => {
  it("shows the first value, then the others in brackets, left out when blank, for one to four fields", async () => {
    const held = (...f: [string, string][]) => [null, { id: 40, fields: values(...f) }, null, null, null] as Booking[];
    const cases: [object[], Booking[], string][] = [
      [[field("Name", { identity: true })], held(["Name", "Sam"]), "Sam"],
      [[field("Name", { identity: true }), field("Phone", { required: false })], held(["Name", "Sam"]), "Sam"],
      [[field("Name", { identity: true }), field("Phone", { required: false })], held(["Name", "Sam"], ["Phone", "0700"]), "Sam (0700)"],
      [[field("A"), field("B"), field("C")], held(["A", "a"], ["B", "b"], ["C", "c"]), "a (b, c)"],
      [[field("A"), field("B", { required: false }), field("C", { required: false }), field("D", { required: false })], held(["A", "a"], ["C", "c"], ["D", "d"]), "a (c, d)"],
    ];
    for (const [form, booked, who] of cases) {
      await start({ initial: withForm(form, booked) });
      expect(row("09:15").querySelector(".sched-who")!.textContent).toBe(who);
    }
  });

  it("uses the same text in the Clear panel, the Move and Swap messages and the orphans", async () => {
    const form = [field("Name", { identity: true }), field("Phone", { required: false })];
    const ann = { id: 41, fields: values(["Name", "Ann"], ["Phone", "0701"]) };
    const bob = { id: 42, fields: values(["Name", "Bob"]) };
    const lost = { id: 43, slotStart: "2026-06-13T07:00:00Z", fields: values(["Name", "Lou"], ["Phone", "0702"]) };
    const { setDetail } = await start({
      initial: withForm(form, [ann, bob, null, null, null], [lost]),
      respond: (c) => (c.method === "POST" && c.url.endsWith("/swap") ? reply(200, { a: {}, b: {} }) : undefined),
    });
    expect($(".sched-orphans li .sched-who").textContent).toBe("Lou (0702)");
    button(row("09:00"), "Clear").click();
    expect($(".sched-panel").textContent).toContain("09:00: Ann (0701)");
    button($(".sched-panel"), "Cancel").click();
    button(row("09:00"), "Swap").click();
    expect(options($("select"))).toEqual(["09:15: Bob"]);
    ($("select") as HTMLSelectElement).value = S[1];
    setDetail(withForm(form, [bob, ann, null, null, null], [lost]));
    submit($(".sched-panel"));
    await settle();
    expect(statusText()).toBe("Swapped Ann (09:00) with Bob (09:15).");
  });

  it("labels the Move, Swap and Clear buttons of a place by the first value", async () => {
    const lanes = [{ id: 1, name: "Ring 1" }, { id: 2, name: "Ring 2" }];
    const d = laneDetail(lanes, 1, { "1:0": [{ id: 50, fields: values(["Name", "Ann"], ["Phone", "0701"]) }] }, [], { fields: [field("Name", { identity: true }), field("Phone", { required: false })] });
    await start({ initial: d });
    expect($$("button").map((b) => b.getAttribute("aria-label")).filter((l) => l?.includes("Ann"))).toEqual([
      "Move Ann at 09:15 · Ring 1", "Swap Ann at 09:15 · Ring 1", "Clear Ann at 09:15 · Ring 1",
    ]);
  });
});

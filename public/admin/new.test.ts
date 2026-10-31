// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SHARE_MESSAGE_LENGTH } from "../share-message.js";
import { init } from "./new.js";

const HOSTILE = "<img src=x onerror=alert(1)>";
const ORIGIN = "https://club.example";
const reply = (status: number, body: unknown = null) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const SESSION = { identity: "ann@example.com", provider: "password", csrfToken: "tok" };
const slots = (...starts: string[]) => starts.map((s) => ({ start: s, end: s }));
const SLOTS = slots("2026-06-13T08:00:00Z", "2026-06-13T08:20:00Z", "2026-06-13T08:40:00Z");
const preview = (extra: Record<string, unknown> = {}) => reply(200, { slots: SLOTS, suggestions: [], ...extra });
const suggestion = (breakIndex: number, suggestedStart = "11:50", breakLabel = "") => ({
  breakIndex, droppedSlot: { start: "2026-06-13T10:45:00Z", end: "2026-06-13T11:00:00Z" },
  overrunMinutes: 5, suggestedBreak: { start: "x", end: "y" }, suggestedLocal: { start: suggestedStart, end: "12:10" }, breakLabel,
});
const CREATED = {
  event: {
    slug: "abc123", name: "Trial Day", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T15:00:00Z",
    sessionMinutes: 15, gapMinutes: 5, costPence: 1250, venuePostcode: "SW1A 1AA", details: "",
  },
  path: "/e/abc123", slotCount: 21,
};

type Call = { url: string; init?: RequestInit; body?: any };
type Handler = (call: Call) => Response | Promise<Response>;
const PREVIEW = "/api/admin/events/preview";
const CREATE = "/api/admin/events";
const TEMPLATES = "/api/admin/templates";

async function start(opts: { preview?: Handler; create?: Handler; templates?: Handler; clipboard?: unknown; navigator?: unknown; settings?: Promise<unknown> } = {}) {
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  const navigate = vi.fn();
  const clipboard = opts.clipboard === undefined ? { writeText: vi.fn(async () => {}) } : opts.clipboard;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, init, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url === "/api/admin/session") return reply(200, SESSION);
    if (url === PREVIEW) return (opts.preview ?? (() => preview()))(call);
    if (url === CREATE) return (opts.create ?? (() => reply(201, CREATED)))(call);
    if (url === TEMPLATES) return (opts.templates ?? (() => reply(200, { templates: [] })))(call);
    throw new Error(`unexpected ${url}`);
  });
  await init({
    document, fetch: fetch as unknown as typeof globalThis.fetch, navigate, location: { origin: ORIGIN },
    clipboard: clipboard as never, ...(opts.navigator ? { navigator: opts.navigator as never } : {}), ...(opts.settings ? { settings: opts.settings as never } : {}),
  });
  return { calls, navigate, clipboard: clipboard as { writeText: ReturnType<typeof vi.fn> } };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const set = (id: string, value: string) => {
  const el = input(id);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const fillSchedule = () => {
  set("date", "2026-06-13"); set("start", "09:00"); set("end", "16:00"); set("session", "15"); set("gap", "5");
};
const fillAll = () => {
  fillSchedule();
  set("name", "Trial Day"); set("cost", "12.50"); set("postcode", "sw1a 1aa");
};
const buttonNamed = (name: string) => $$("button").find((b) => b.textContent === name)!;
const rowInputs = (n: number) => ({
  start: input(`break-${n}-start`), end: input(`break-${n}-end`),
});
const setLabel = (n: number, value: string) => set(`break-${n}-label`, value);
const setRow = (n: number, start: string, end: string) => {
  const r = rowInputs(n);
  for (const [el, v] of [[r.start, start], [r.end, end]] as const) {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
};
const settle = () => vi.advanceTimersByTimeAsync(300);
const tick = () => vi.advanceTimersByTimeAsync(0);
const submit = () => $("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const text = () => document.body.textContent ?? "";
const chips = () => $$(".chips li").map((li) => li.textContent);
const errorOf = (id: string) => document.getElementById(`${id}-error`)!.textContent;
const previewCalls = (calls: Call[]) => calls.filter((c) => c.url === PREVIEW);
const PLACEHOLDER = "Fill in the highlighted fields to see the schedule.";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("form", () => {
  it("has labelled, large, mobile-friendly controls", async () => {
    await start();
    const labels = $$("label").map((l) => l.textContent);
    expect(labels).toEqual([
      "Template", "Event name", "Date", "Start time", "End time", "Session length (minutes)", "Gap between sessions (minutes)",
      "Label", "Required", "Identifies a booking", "Max length", "How many bookings can one Name make?",
      "Lane name (optional)", "Places per lane per time", "Cost (£)", "Venue postcode", "Details (optional)", "Share message (optional)", "Listed on the home page",
    ]);
    for (const label of $$("label")) expect(document.getElementById(label.getAttribute("for")!)).not.toBeNull();
    expect(input("date").type).toBe("date");
    expect(input("start").type).toBe("time");
    expect(input("end").type).toBe("time");
    expect(input("session").type).toBe("number");
    expect(input("session").getAttribute("inputmode")).toBe("numeric");
    expect(input("session").min).toBe("1");
    expect(input("session").step).toBe("1");
    expect(input("gap").min).toBe("0");
    expect(input("cost").getAttribute("inputmode")).toBe("decimal");
    expect(input("details").tagName).toBe("TEXTAREA");
    expect(text()).toContain("You can edit the event after saving, so you can fix any slip later.");
    expect(buttonNamed("Save event")).toBeDefined();
    expect($("form").hasAttribute("novalidate")).toBe(true);
  });

  it("has a Listed on the home page checkbox, ticked by default, with its hint", async () => {
    await start();
    const box = input("listed");
    expect(box.type).toBe("checkbox");
    expect(box.checked).toBe(true);
    const hint = document.getElementById(box.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe("Untick to keep this event off the home page. Anyone with its link can still book.");
    expect($("label[for='listed']").contains(box)).toBe(true);
  });

  it("does not preview when the checkbox is toggled", async () => {
    const { calls } = await start();
    fillAll();
    await settle();
    const before = previewCalls(calls).length;
    input("listed").click();
    await settle();
    expect(previewCalls(calls)).toHaveLength(before);
  });

  it("sends the browser to login without a session", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const navigate = vi.fn();
    const fetch = vi.fn(async () => reply(401));
    await init({ document, fetch: fetch as never, navigate, location: { origin: ORIGIN }, clipboard: null as never });
    expect(navigate).toHaveBeenCalledWith("/admin/login");
    expect(document.querySelector("form")).toBeNull();
  });
});

describe("live preview", () => {
  it("shows the placeholder and makes no call until the required fields are filled", async () => {
    const { calls } = await start();
    expect($(".preview [aria-live=polite]").textContent).toContain(PLACEHOLDER);
    for (const [id, value] of [["date", "2026-06-13"], ["start", "09:00"], ["end", "16:00"], ["session", "15"]] as const) {
      set(id, value);
      await settle();
      expect(previewCalls(calls)).toHaveLength(0);
    }
    set("gap", "5");
    await settle();
    expect(previewCalls(calls)).toHaveLength(1);
    expect(previewCalls(calls)[0].body).toMatchObject({
      date: "2026-06-13", start: "09:00", end: "16:00", sessionMinutes: 15, gapMinutes: 5, breaks: [],
    });
    expect(previewCalls(calls)[0].init?.method).toBe("POST");
    expect((previewCalls(calls)[0].init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
  });

  it("does not preview for a non-integer session length", async () => {
    const { calls } = await start();
    fillSchedule();
    set("session", "1.5");
    await settle();
    expect(previewCalls(calls)).toHaveLength(0);
  });

  it("shows the slot count and London start times in a polite live region", async () => {
    await start();
    fillSchedule();
    await settle();
    const live = $(".preview [aria-live=polite]");
    expect(live.textContent).toContain("3 slots");
    expect(chips()).toEqual(["09:00", "09:20", "09:40"]);
    expect(live.contains($(".chips"))).toBe(true);
  });

  it("says 1 slot for one slot", async () => {
    await start({ preview: () => reply(200, { slots: slots("2026-01-17T09:00:00Z"), suggestions: [] }) });
    fillSchedule();
    await settle();
    expect($(".preview-summary").textContent).toBe("1 slot");
    expect(chips()).toEqual(["09:00"]);
  });

  it("debounces rapid input into one call", async () => {
    const { calls } = await start();
    fillSchedule();
    for (const v of ["1", "12", "120", "15"]) {
      set("session", v);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(previewCalls(calls)).toHaveLength(0);
    await settle();
    expect(previewCalls(calls)).toHaveLength(1);
    expect(previewCalls(calls)[0].body.sessionMinutes).toBe(15);
  });

  it("aborts the in-flight request and ignores a stale response", async () => {
    const pending: ((r: Response) => void)[] = [];
    const { calls } = await start({ preview: () => new Promise<Response>((resolve) => { pending.push(resolve); }) });
    fillSchedule();
    await settle();
    expect(pending).toHaveLength(1);
    const first = previewCalls(calls)[0].init!.signal!;
    set("gap", "10");
    expect(first.aborted).toBe(true);
    await settle();
    expect(pending).toHaveLength(2);
    // The newer response arrives first, then the stale one
    pending[1](reply(200, { slots: slots("2026-06-13T08:00:00Z", "2026-06-13T08:25:00Z"), suggestions: [] }));
    await tick();
    pending[0](reply(200, { slots: slots("2026-06-13T08:00:00Z"), suggestions: [] }));
    await tick();
    expect(chips()).toEqual(["09:00", "09:25"]);
  });

  it("ignores a response that arrives after the draft became invalid", async () => {
    const pending: ((r: Response) => void)[] = [];
    await start({ preview: () => new Promise<Response>((resolve) => { pending.push(resolve); }) });
    fillSchedule();
    await settle();
    set("date", "");
    pending[0](preview());
    await tick();
    expect(chips()).toEqual([]);
    expect($(".preview-summary").textContent).toBe(PLACEHOLDER);
  });

  it("clears the previous slots when the draft becomes invalid", async () => {
    const { calls } = await start();
    fillSchedule();
    await settle();
    expect(chips()).toHaveLength(3);
    set("end", "");
    expect(chips()).toEqual([]);
    expect($(".preview-summary").textContent).toBe(PLACEHOLDER);
    await settle();
    expect(previewCalls(calls)).toHaveLength(1);
  });

  it("clears slots when the server rejects the draft, and shows its errors on touched fields", async () => {
    await start({
      preview: (c) => c.body.end === "08:00"
        ? reply(400, { error: { code: "invalid_input", message: "x" }, fields: { end: "The end must be after the start." } })
        : preview(),
    });
    fillSchedule();
    await settle();
    expect(chips()).toHaveLength(3);
    set("end", "08:00");
    await settle();
    expect(chips()).toEqual([]);
    expect($(".preview-summary").textContent).toBe(PLACEHOLDER);
    expect(errorOf("end")).toBe("The end must be after the start.");
    expect(input("end").getAttribute("aria-invalid")).toBe("true");
    expect(input("end").getAttribute("aria-describedby")).toBe("end-error");
    // fixing the field clears the error at once
    set("end", "16:00");
    expect(errorOf("end")).toBe("");
    expect(input("end").hasAttribute("aria-invalid")).toBe(false);
  });

  it("shows a message when the preview request fails, with no stale slots", async () => {
    let fail = false;
    await start({ preview: () => (fail ? reply(500, null) : preview()) });
    fillSchedule();
    await settle();
    fail = true;
    set("gap", "10");
    await settle();
    expect(chips()).toEqual([]);
    expect($(".preview-summary").textContent).toContain("couldn't update the preview");
  });

  it("clears the busy state when the preview request fails to connect", async () => {
    let fail = false;
    await start({ preview: () => (fail ? Promise.reject(new TypeError("offline")) : preview()) });
    fillSchedule();
    await settle();
    fail = true;
    set("gap", "10");
    expect($(".preview").getAttribute("aria-busy")).toBe("true");
    await settle();
    expect($(".preview-summary").textContent).toContain("couldn't update the preview");
    expect($(".preview").hasAttribute("aria-busy")).toBe(false);
  });

  it("does not report our own abort as a failure", async () => {
    const pending: ((r: Response) => void)[] = [];
    await start({
      preview: (c) => new Promise<Response>((resolve, reject) => {
        pending.push(resolve);
        c.init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    fillSchedule();
    await settle();
    set("gap", "10"); // aborts the request in flight
    await tick();
    expect($(".preview-summary").textContent).not.toContain("couldn't update the preview");
    await settle();
    pending[1](preview());
    await tick();
    expect(chips()).toHaveLength(3);
    expect($(".preview").hasAttribute("aria-busy")).toBe(false);
  });
});

describe("breaks", () => {
  it("gives each row an optional name field, sent to the preview and on save", async () => {
    const { calls } = await start();
    fillAll();
    buttonNamed("Add break").click();
    const label = input("break-1-label");
    expect(document.querySelector("label[for='break-1-label']")!.textContent).toBe("Name (optional)");
    expect(label.type).toBe("text");
    expect(label.placeholder).toBe("Lunch");
    expect(label.maxLength).toBe(40);
    expect(label.required).toBe(false);
    setRow(1, "12:00", "12:20");
    setLabel(1, "  Lunch ");
    await settle();
    expect(previewCalls(calls).at(-1)!.body.breaks).toEqual([{ start: "12:00", end: "12:20", label: "  Lunch " }]);
    submit();
    await tick();
    expect(calls.find((c) => c.url === CREATE)!.body.breaks).toEqual([{ start: "12:00", end: "12:20", label: "  Lunch " }]);
  });

  it("re-previews when the name changes, so the suggestion wording follows it", async () => {
    const { calls } = await start();
    fillSchedule();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    await settle();
    const n = previewCalls(calls).length;
    setLabel(1, "Tea");
    await settle();
    expect(previewCalls(calls)).toHaveLength(n + 1);
  });

  it("removes a row's name field along with the row, and shows a server error under it", async () => {
    await start({ create: () => reply(400, { error: { code: "invalid_input", message: "x" }, fields: { "breaks.0.label": "Too long." } }) });
    fillAll();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    submit();
    await tick();
    expect(errorOf("break-1-label")).toBe("Too long.");
    expect(document.activeElement).toBe(input("break-1-label"));
    $$(".break-row button")[0].click();
    expect(document.getElementById("break-1-label")).toBeNull();
  });

  it("words a suggestion with the break's name when it has one", async () => {
    await start({ preview: () => preview({ suggestions: [suggestion(0, "13:05", "Lunch")] }) });
    fillSchedule();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    setLabel(1, "Lunch");
    await settle();
    expect($(".suggestion p").textContent).toBe("Move Lunch to 13:05–12:10 to keep the 11:45 session?");
  });

  it("uses the time wording for an unnamed break", async () => {
    await start({ preview: () => preview({ suggestions: [suggestion(0, "13:05")] }) });
    fillSchedule();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    await settle();
    expect($(".suggestion p").textContent).toBe("Move the 12:00–12:20 break to 13:05–12:10 to keep the 11:45 session?");
  });

  it("accepting a suggestion changes the times and leaves the name alone", async () => {
    await start({ preview: (c) => preview({ suggestions: c.body.breaks[0]?.start === "12:00" ? [suggestion(0, "11:50", "Lunch")] : [] }) });
    fillSchedule();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    setLabel(1, "Lunch");
    await settle();
    buttonNamed("Move break").click();
    expect(rowInputs(1).start.value).toBe("11:50");
    expect(input("break-1-label").value).toBe("Lunch");
  });

  it("keeps a declined suggestion hidden whatever the name says", async () => {
    let label = "Lunch";
    await start({ preview: () => preview({ suggestions: [suggestion(0, "11:50", label)] }) });
    fillSchedule();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    await settle();
    buttonNamed("Keep as it is").click();
    label = "Tea";
    setLabel(1, "Tea");
    await settle();
    expect($$(".suggestion")).toHaveLength(0);
  });

  it("shows a hostile name as text in the suggestion", async () => {
    await start({ preview: () => preview({ suggestions: [suggestion(0, "11:50", HOSTILE)] }) });
    fillSchedule();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    setLabel(1, HOSTILE);
    await settle();
    expect($(".suggestion p").textContent).toBe(`Move ${HOSTILE} to 11:50–12:10 to keep the 11:45 session?`);
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.innerHTML).not.toContain("<img");
  });

  it("adds and removes rows, numbering them, and re-previews on removal", async () => {
    const { calls } = await start();
    fillSchedule();
    await settle();
    buttonNamed("Add break").click();
    buttonNamed("Add break").click();
    expect($$(".break-row legend").map((l) => l.textContent)).toEqual(["Break 1", "Break 2"]);
    expect(document.activeElement).toBe(rowInputs(2).start);
    setRow(2, "12:00", "12:20");
    await settle();
    expect(previewCalls(calls).at(-1)!.body.breaks).toEqual([{ start: "12:00", end: "12:20", label: "" }]);
    const removes = $$(".break-row button");
    expect(removes[0].getAttribute("aria-label")).toBe("Remove break 1");
    removes[0].click();
    expect($$(".break-row legend").map((l) => l.textContent)).toEqual(["Break 1"]);
    expect(document.activeElement).toBe(buttonNamed("Add break"));
    const before = previewCalls(calls).length;
    await settle();
    expect(previewCalls(calls)).toHaveLength(before + 1);
    expect(previewCalls(calls).at(-1)!.body.breaks).toEqual([{ start: "12:00", end: "12:20", label: "" }]);
  });

  it("ignores blank rows but waits for half-filled rows", async () => {
    const { calls } = await start();
    fillSchedule();
    buttonNamed("Add break").click();
    await settle();
    expect(previewCalls(calls)).toHaveLength(1);
    expect(previewCalls(calls)[0].body.breaks).toEqual([]);
    setRow(1, "12:00", "");
    expect(chips()).toEqual([]);
    await settle();
    expect(previewCalls(calls)).toHaveLength(1);
    setRow(1, "12:00", "12:20");
    await settle();
    expect(previewCalls(calls)).toHaveLength(2);
  });

  it("maps a suggestion's payload index to the right row when a blank row precedes it", async () => {
    const { calls } = await start({
      preview: (c) => preview({ suggestions: c.body.breaks.length === 2 ? [suggestion(1)] : [] }),
    });
    fillSchedule();
    for (let i = 0; i < 3; i++) buttonNamed("Add break").click();
    setRow(2, "10:00", "10:20");
    setRow(3, "12:00", "12:20"); // payload index 1; row 1 is blank
    await settle();
    expect(previewCalls(calls).at(-1)!.body.breaks).toEqual([{ start: "10:00", end: "10:20", label: "" }, { start: "12:00", end: "12:20", label: "" }]);
    const card = $(".suggestion");
    expect(card.textContent).toContain("Move the 12:00–12:20 break to 11:50–12:10 to keep the 11:45 session?");
    buttonNamed("Move break").click();
    expect(rowInputs(3).start.value).toBe("11:50");
    expect(rowInputs(3).end.value).toBe("12:10");
    expect(rowInputs(2).start.value).toBe("10:00");
    expect(rowInputs(1).start.value).toBe("");
    expect($$(".suggestion")).toHaveLength(0);
    await settle();
    expect(previewCalls(calls).at(-1)!.body.breaks).toEqual([{ start: "10:00", end: "10:20", label: "" }, { start: "11:50", end: "12:10", label: "" }]);
  });

  it("offers Move break and Keep as it is as large buttons, and re-previews on accept", async () => {
    const { calls } = await start({ preview: (c) => preview({ suggestions: c.body.breaks[0]?.start === "12:00" ? [suggestion(0)] : [] }) });
    fillSchedule();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    await settle();
    expect($$(".suggestion button").map((b) => b.textContent)).toEqual(["Move break", "Keep as it is"]);
    expect($(".suggestion").compareDocumentPosition($(".chips")) & 4).toBeTruthy(); // suggestions come before the slots
    const n = previewCalls(calls).length;
    buttonNamed("Move break").click();
    await settle();
    expect(previewCalls(calls)).toHaveLength(n + 1);
    expect($$(".suggestion")).toHaveLength(0);
  });

  it("keeps a declined suggestion hidden for the same inputs, and raises a changed one", async () => {
    let suggestedStart = "11:50";
    await start({ preview: () => preview({ suggestions: [suggestion(0, suggestedStart)] }) });
    fillSchedule();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    await settle();
    expect($$(".suggestion")).toHaveLength(1);
    buttonNamed("Keep as it is").click();
    expect($$(".suggestion")).toHaveLength(0);
    set("gap", "5"); // same value, another preview
    set("session", "15");
    await settle();
    expect($$(".suggestion")).toHaveLength(0);
    suggestedStart = "11:45";
    set("session", "16");
    await settle();
    expect($$(".suggestion")).toHaveLength(1);
    expect($(".suggestion").textContent).toContain("to 11:45–12:10");
  });

  it("keeps a declined suggestion hidden when an earlier row is removed and its payload index shifts", async () => {
    await start({
      preview: (c) => preview({ suggestions: [suggestion(c.body.breaks.length - 1)] }),
    });
    fillSchedule();
    for (let i = 0; i < 2; i++) buttonNamed("Add break").click();
    setRow(1, "10:00", "10:20");
    setRow(2, "12:00", "12:20");
    await settle();
    expect($$(".suggestion")).toHaveLength(1); // for row 2, payload index 1
    buttonNamed("Keep as it is").click();
    $$(".break-row button")[0].click(); // remove row 1: row 2 is now payload index 0
    await settle();
    expect($$(".suggestion")).toHaveLength(0);
  });

  it("does not hide another row's suggestion that has the same times and payload index", async () => {
    await start({
      preview: (c) => preview({ suggestions: [suggestion(0)].slice(0, c.body.breaks.length) }),
    });
    fillSchedule();
    for (let i = 0; i < 2; i++) buttonNamed("Add break").click();
    setRow(1, "10:00", "10:20");
    setRow(2, "12:00", "12:20");
    await settle();
    expect($(".suggestion").textContent).toContain("Move the 10:00–10:20 break"); // row 1, payload index 0
    buttonNamed("Keep as it is").click();
    $$(".break-row button")[0].click(); // remove row 1: row 2 is now payload index 0
    await settle();
    expect($$(".suggestion")).toHaveLength(1);
    expect($(".suggestion").textContent).toContain("Move the 12:00–12:20 break");
  });

  it("shows break errors on the right inputs, mapping payload indexes to rows", async () => {
    await start({
      preview: () => reply(400, {
        error: { code: "invalid_input", message: "x" },
        fields: { "breaks.1.end": "The break must end after it starts.", "breaks.0.start": "The break must start within the event." },
      }),
    });
    fillSchedule();
    for (let i = 0; i < 3; i++) buttonNamed("Add break").click();
    setRow(2, "07:00", "07:20"); // payload index 0
    setRow(3, "12:20", "12:00"); // payload index 1
    await settle();
    expect(errorOf("break-2-start")).toBe("The break must start within the event.");
    expect(errorOf("break-3-end")).toBe("The break must end after it starts.");
    expect(rowInputs(3).end.getAttribute("aria-invalid")).toBe("true");
    expect(rowInputs(3).end.getAttribute("aria-describedby")).toBe("break-3-end-error");
    expect(errorOf("break-1-start")).toBe("");
    expect(errorOf("break-2-end")).toBe("");
    expect(errorOf("break-3-start")).toBe("");
  });
});

describe("saving", () => {
  it("sends the exact JSON: pence, HH:MM, trimmed", async () => {
    const { calls } = await start();
    fillAll();
    set("name", "  Trial Day  ");
    set("postcode", "  SW1A 1AA ");
    set("details", "  Bring water.  ");
    buttonNamed("Add break").click();
    buttonNamed("Add break").click();
    setRow(2, "12:00", "12:20");
    submit();
    await tick();
    const create = calls.find((c) => c.url === CREATE)!;
    expect(create.init?.method).toBe("POST");
    expect(create.init?.headers).toEqual({ "Content-Type": "application/json", "X-CSRF-Token": "tok" });
    expect(create.body).toEqual({
      name: "Trial Day", date: "2026-06-13", start: "09:00", end: "16:00", sessionMinutes: 15, gapMinutes: 5,
      costPence: 1250, venuePostcode: "SW1A 1AA", details: "Bring water.", breaks: [{ start: "12:00", end: "12:20", label: "" }],
      shareMessage: "", listed: true, idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      fields: [{ label: "Name", required: true, maxLength: 80, identity: true }], identityLimit: 1,
    });
  });

  it("sends listed: false when the box is unticked", async () => {
    const { calls } = await start();
    fillAll();
    input("listed").click();
    submit();
    await tick();
    expect(calls.find((c) => c.url === CREATE)!.body.listed).toBe(false);
  });

  it("shows a server error for listed as the form error, as it has no field of its own on the page", async () => {
    await start({ create: () => reply(400, { error: { code: "invalid_input", message: "Check the highlighted fields." }, fields: { listed: "Listed must be true or false." } }) });
    fillAll();
    submit();
    await tick();
    expect($(".form-error").textContent).toContain("Listed must be true or false.");
  });

  it("sends 0 pence for a free event", async () => {
    const { calls } = await start();
    fillAll();
    set("cost", "0");
    submit();
    await tick();
    expect(calls.find((c) => c.url === CREATE)!.body.costPence).toBe(0);
  });

  it("disables Save while pending and creates only once", async () => {
    let finish!: (r: Response) => void;
    const { calls } = await start({ create: () => new Promise<Response>((resolve) => { finish = resolve; }) });
    fillAll();
    const save = buttonNamed("Save event") as HTMLButtonElement;
    submit();
    await tick();
    expect(save.disabled).toBe(true);
    expect($(".progress").textContent).toBe("Saving the event…");
    submit();
    save.click();
    await tick();
    expect(calls.filter((c) => c.url === CREATE)).toHaveLength(1);
    finish(reply(201, CREATED));
    await tick();
    expect($("h1").textContent).toBe("Event created");
  });

  it("blocks an invalid cost locally and focuses it", async () => {
    const { calls } = await start();
    fillAll();
    set("cost", "12.505");
    submit();
    await tick();
    expect(calls.find((c) => c.url === CREATE)).toBeUndefined();
    expect(errorOf("cost")).toBe("Use two decimal places at most, for example 12.50.");
    expect(document.activeElement).toBe(input("cost"));
    set("cost", "");
    expect(errorOf("cost")).toBe("Enter the cost in pounds, or 0 if it's free.");
  });

  it("shows server field errors for all fields after a save attempt and focuses the first", async () => {
    await start({
      create: () => reply(400, {
        error: { code: "invalid_input", message: "Check the highlighted fields." },
        fields: {
          venuePostcode: "Enter a venue postcode of 2 to 10 letters and numbers.", name: "Enter the event name.",
          "breaks.1.end": "The break must end within the event.",
        },
      }),
    });
    fillAll();
    for (let i = 0; i < 3; i++) buttonNamed("Add break").click();
    setRow(2, "10:00", "10:20");
    setRow(3, "12:00", "17:00");
    set("name", "");
    submit();
    await tick();
    expect(errorOf("name")).toBe("Enter the event name.");
    expect(errorOf("postcode")).toBe("Enter a venue postcode of 2 to 10 letters and numbers.");
    expect(errorOf("break-3-end")).toBe("The break must end within the event.");
    expect(errorOf("break-2-end")).toBe("");
    expect(document.activeElement).toBe(input("name"));
    expect(($("#name-error") as HTMLElement).getAttribute("role")).toBe("alert");
    expect((buttonNamed("Save event") as HTMLButtonElement).disabled).toBe(false);
    expect($("form")).not.toBeNull();
  });

  it("focuses a break error when it is the first", async () => {
    await start({ create: () => reply(400, { error: { code: "invalid_input", message: "x" }, fields: { "breaks.0.end": "Bad." } }) });
    fillAll();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    submit();
    await tick();
    expect(document.activeElement).toBe(rowInputs(1).end);
  });

  it("keeps the form and offers a retry after a server error", async () => {
    let fail = true;
    const { calls } = await start({ create: () => (fail ? reply(500, { error: { code: "internal_error", message: "x" } }) : reply(201, CREATED)) });
    fillAll();
    set("details", "Keep me");
    submit();
    await tick();
    expect($(".form-error").textContent).toContain("couldn't save the event");
    expect($(".form-error").getAttribute("role")).toBe("alert");
    expect(input("name").value).toBe("Trial Day");
    expect(input("details").value).toBe("Keep me");
    const save = buttonNamed("Save event") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fail = false;
    submit();
    await tick();
    expect($("h1").textContent).toBe("Event created");
    expect(calls.filter((c) => c.url === CREATE)).toHaveLength(2);
  });

  it("keeps the form after a network failure", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetch = vi.fn(async (url: string) => {
      if (url === "/api/admin/session") return reply(200, SESSION);
      throw new TypeError("offline");
    });
    await init({ document, fetch: fetch as never, navigate: vi.fn(), location: { origin: ORIGIN }, clipboard: null as never });
    fillAll();
    submit();
    await tick();
    expect($(".form-error").textContent).toContain("couldn't save the event");
    expect(document.querySelector("form")).not.toBeNull();
  });
});

describe("save and preview together", () => {
  const FUTURE = "The event must start in the future.";
  const rejected = () => reply(400, { error: { code: "invalid_input", message: "x" }, fields: { date: FUTURE } });
  const deferredPreviews = () => {
    const pending: ((r: Response) => void)[] = [];
    return { pending, handler: () => new Promise<Response>((resolve) => { pending.push(resolve); }) };
  };

  it("keeps a Save error when Save is pressed before the debounce fires and a preview then returns", async () => {
    const { pending, handler } = deferredPreviews();
    await start({ preview: handler, create: rejected });
    fillAll();
    submit();
    await tick();
    expect(errorOf("date")).toBe(FUTURE);
    await settle();
    for (const resolve of pending) resolve(preview());
    await tick();
    expect(errorOf("date")).toBe(FUTURE);
    expect(input("date").getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps a Save error when a preview already in flight returns after Save", async () => {
    const { pending, handler } = deferredPreviews();
    const { calls } = await start({ preview: handler, create: rejected });
    fillAll();
    await settle();
    expect(pending).toHaveLength(1);
    submit();
    await tick();
    expect(previewCalls(calls)[0].init!.signal!.aborted).toBe(true);
    pending[0](preview());
    await tick();
    expect(errorOf("date")).toBe(FUTURE);
  });

  it("does not repaint the success view when a preview returns after Save succeeds", async () => {
    const { pending, handler } = deferredPreviews();
    await start({ preview: handler });
    fillAll();
    await settle();
    submit();
    await tick();
    expect($("h1").textContent).toBe("Event created");
    pending[0](preview());
    await tick();
    expect(document.querySelector(".preview")).toBeNull();
    expect(chips()).toEqual([]);
    expect($("h1").textContent).toBe("Event created");
  });

  it("still previews after a Save blocked locally by the cost", async () => {
    const { calls } = await start();
    fillAll();
    set("cost", "12.505");
    submit();
    await settle();
    expect(previewCalls(calls)).toHaveLength(1);
  });
});

describe("idempotency key", () => {
  const creates = (calls: Call[]) => calls.filter((c) => c.url === CREATE);
  const keyOf = (c: Call): string => c.body.idempotencyKey;

  it("sends a 128-bit key (22 base64url characters) with the create request, and none with the preview", async () => {
    const { calls } = await start();
    fillAll();
    await settle();
    submit();
    await tick();
    expect(keyOf(creates(calls)[0])).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(previewCalls(calls)[0].body).not.toHaveProperty("idempotencyKey");
  });

  it("reuses one key when Save is retried after a server error", async () => {
    let status = 500;
    const { calls } = await start({ create: () => (status === 500 ? reply(500, { error: { code: "internal_error", message: "x" } }) : reply(201, CREATED)) });
    fillAll();
    submit();
    await tick();
    expect($(".form-error").textContent).toContain("couldn't save the event");
    status = 201;
    submit();
    await tick();
    expect($("h1").textContent).toBe("Event created");
    expect(creates(calls)).toHaveLength(2);
    expect(keyOf(creates(calls)[1])).toBe(keyOf(creates(calls)[0]));
  });

  it("reuses it after a network failure", async () => {
    let fail = true;
    const calls: Call[] = [];
    document.body.innerHTML = '<main id="app"></main>';
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/session") return reply(200, SESSION);
      if (url === PREVIEW) return preview();
      calls.push({ url, init, body: JSON.parse(init!.body as string) });
      if (fail) throw new TypeError("offline");
      return reply(201, CREATED);
    });
    await init({ document, fetch: fetch as never, navigate: vi.fn(), location: { origin: ORIGIN }, clipboard: null as never });
    fillAll();
    submit();
    await tick();
    fail = false;
    submit();
    await tick();
    expect($("h1").textContent).toBe("Event created");
    expect(calls).toHaveLength(2);
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
  });

  it("keeps the key when the form is edited between attempts (a lost response, then a change)", async () => {
    let first = true;
    const { calls } = await start({ create: () => { const lost = first; first = false; return lost ? reply(500) : reply(201, CREATED); } });
    fillAll();
    submit();
    await tick();
    set("name", "Trial Day, renamed");
    set("cost", "15");
    submit();
    await tick();
    expect(creates(calls)).toHaveLength(2);
    expect(creates(calls)[1].body.name).toBe("Trial Day, renamed");
    expect(keyOf(creates(calls)[1])).toBe(keyOf(creates(calls)[0]));
  });

  it("keeps the key after a validation error too", async () => {
    let invalid = true;
    const { calls } = await start({
      create: () => (invalid ? reply(400, { error: { code: "invalid_input", message: "x" }, fields: { name: "No." } }) : reply(201, CREATED)),
    });
    fillAll();
    submit();
    await tick();
    invalid = false;
    submit();
    await tick();
    expect(keyOf(creates(calls)[1])).toBe(keyOf(creates(calls)[0]));
  });

  it("uses a different key in a new page session after a successful create", async () => {
    const first = await start();
    fillAll();
    submit();
    await tick();
    expect($("h1").textContent).toBe("Event created");
    const second = await start();
    fillAll();
    submit();
    await tick();
    expect(keyOf(creates(second.calls)[0])).not.toBe(keyOf(creates(first.calls)[0]));
  });

  it("shows the server's message as the form error when the key was refused", async () => {
    await start({
      create: () => reply(400, { error: { code: "invalid_input", message: "Check the highlighted fields." }, fields: { idempotencyKey: "Reload the page and try again." } }),
    });
    fillAll();
    submit();
    await tick();
    expect($(".form-error").textContent).toBe("Reload the page and try again.");
  });

  describe("a key reused with a changed form (422 idempotency_key_reuse)", () => {
    const ORIGINAL = { ...CREATED, event: { ...CREATED.event, name: "Original Name", slug: "orig999" }, path: "/e/orig999" };
    const reuse = { error: { code: "idempotency_key_reuse", message: "An earlier attempt with this key already saved an event, so this change wasn't applied." }, ...ORIGINAL };

    it("shows the original event's created view with a notice that the change wasn't applied", async () => {
      await start({ create: () => reply(422, reuse) });
      fillAll();
      set("name", "Edited Name");
      submit();
      await tick();
      expect($("h1").textContent).toBe("Event created");
      expect($(".notice").textContent).toContain("already saved");
      expect($(".notice").textContent).toContain("weren't applied");
      expect($(".event-name").textContent).toBe("Original Name");
      expect(input("booking-link").value).toBe("https://club.example/e/orig999");
      expect(input("whatsapp-text").value).toContain("Original Name");
      expect(input("whatsapp-text").value).not.toContain("Edited Name");
      expect(document.querySelector("form")).toBeNull();
    });

    it("shows the server's message as the form error when no event came with it", async () => {
      await start({ create: () => reply(422, { error: reuse.error }) });
      fillAll();
      submit();
      await tick();
      expect($(".form-error").textContent).toBe(reuse.error.message);
      expect(document.querySelector("form")).not.toBeNull();
    });

    it("shows no notice for a plain success", async () => {
      await start();
      fillAll();
      submit();
      await tick();
      expect(document.querySelector(".notice")).toBeNull();
    });
  });
});

describe("created view", () => {
  async function create(opts: Parameters<typeof start>[0] = {}) {
    const ctx = await start(opts);
    fillAll();
    submit();
    await tick();
    return ctx;
  }

  it("replaces the form with the link, WhatsApp message and next steps, focusing the heading", async () => {
    await create();
    expect(document.querySelector("form")).toBeNull();
    expect($("h1").textContent).toBe("Event created");
    expect(document.activeElement).toBe($("h1"));
    expect(input("booking-link").value).toBe("https://club.example/e/abc123");
    expect(input("booking-link").readOnly).toBe(true);
    const message = input("whatsapp-text").value;
    expect(message).toBe(
      "Trial Day\nSaturday 13 June 2026, 09:00–16:00\nVenue: SW1A 1AA\nCost: £12.50\nBook your slot:\nhttps://club.example/e/abc123",
    );
    expect(input("whatsapp-text").readOnly).toBe(true);
    const wa = $$("a").find((a) => a.textContent === "Open in WhatsApp")!;
    expect(wa.getAttribute("href")).toBe(`https://wa.me/?text=${encodeURIComponent(message)}`);
    expect(wa.getAttribute("target")).toBe("_blank");
    expect(wa.getAttribute("rel")).toBe("noopener noreferrer");
    expect($$("a").find((a) => a.textContent === "Create another")!.getAttribute("href")).toBe("/admin/new");
    expect($$("a").find((a) => a.textContent === "Back to events")!.getAttribute("href")).toBe("/admin/");
  });

  describe("club name in the WhatsApp message", () => {
    const PLAIN = "Trial Day\nSaturday 13 June 2026, 09:00–16:00\nVenue: SW1A 1AA\nCost: £12.50\nBook your slot:\nhttps://club.example/e/abc123";
    const message = () => input("whatsapp-text").value;
    const wa = () => $$("a").find((a) => a.textContent === "Open in WhatsApp")!;

    it("heads the message when the settings loaded with a club name", async () => {
      await create({ settings: Promise.resolve({ clubName: "Hillside Dog Club", loaded: true }) });
      expect(message()).toBe(`Hillside Dog Club\n${PLAIN}`);
      expect(wa().getAttribute("href")).toBe(`https://wa.me/?text=${encodeURIComponent(message())}`);
    });

    it("adds nothing when the settings loaded with no club name", async () => {
      await create({ settings: Promise.resolve({ clubName: null, loaded: true }) });
      expect(message()).toBe(PLAIN);
    });

    it("adds nothing when the settings did not load", async () => {
      await create({ settings: Promise.resolve({ clubName: "Hillside Dog Club", loaded: false }) });
      expect(message()).toBe(PLAIN);
    });

    it("adds nothing, and still works, when the settings promise rejects", async () => {
      await create({ settings: Promise.reject(new Error("offline")) });
      expect(message()).toBe(PLAIN);
      expect($("h1").textContent).toBe("Event created");
    });

    it("adds nothing without settings", async () => {
      await create();
      expect(message()).toBe(PLAIN);
    });
  });

  it("copies the link and the message", async () => {
    const { clipboard } = await create();
    buttonNamed("Copy link").click();
    await tick();
    expect(clipboard.writeText).toHaveBeenLastCalledWith("https://club.example/e/abc123");
    expect($(".copy-status").textContent).toBe("Copied");
    buttonNamed("Copy message").click();
    await tick();
    expect(clipboard.writeText).toHaveBeenLastCalledWith(input("whatsapp-text").value);
    await vi.advanceTimersByTimeAsync(2100);
    expect($(".copy-status").textContent).toBe("");
  });

  it("selects the field and asks for a manual copy when the clipboard fails", async () => {
    await create({ clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    buttonNamed("Copy message").click();
    await tick();
    const area = input("whatsapp-text");
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe(area.value.length);
    expect($(".copy-status").textContent).toContain("manually");
    buttonNamed("Copy link").click();
    await tick();
    expect(document.activeElement).toBe(input("booking-link"));
  });
});

describe("hostile text", () => {
  it("stays inert in the form, the preview, the errors and the created view", async () => {
    const { calls } = await start({
      create: (c) => reply(201, { ...CREATED, event: { ...CREATED.event, name: c.body.name, details: c.body.details } }),
    });
    fillAll();
    set("name", HOSTILE);
    set("details", HOSTILE);
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    await settle();
    expect(document.querySelector("img")).toBeNull();
    expect(input("name").value).toBe(HOSTILE);
    submit();
    await tick();
    expect(calls.find((c) => c.url === CREATE)!.body.name).toBe(HOSTILE);
    expect(document.querySelector("img")).toBeNull();
    expect($(".event-name").textContent).toBe(HOSTILE);
    expect(document.body.innerHTML).not.toContain("<img");
  });

  it("stays inert in server error messages", async () => {
    await start({ create: () => reply(400, { error: { code: "invalid_input", message: HOSTILE }, fields: { name: HOSTILE, nothing: HOSTILE } }) });
    fillAll();
    submit();
    await tick();
    expect(document.querySelector("img")).toBeNull();
    expect(errorOf("name")).toBe(HOSTILE);
    expect($(".form-error").textContent).toBe(HOSTILE);
  });
});

describe("created view: Share", () => {
  const ADDRESS = "https://club.example/e/abc123";
  const withEvent = (extra: Record<string, unknown>) => () => reply(201, { ...CREATED, event: { ...CREATED.event, ...extra } });
  async function create(opts: Parameters<typeof start>[0] = {}) {
    const ctx = await start(opts);
    fillAll();
    submit();
    await tick();
    return ctx;
  }
  const message = () => input("whatsapp-text").value;
  const shareButton = () => $$("button").find((b) => b.textContent === "Share") as HTMLButtonElement | undefined;

  it("has no Share control where navigator.share is missing, and keeps the one set of Copy buttons", async () => {
    await create({ navigator: {} });
    expect($$(".share")).toHaveLength(0);
    expect($$("button").filter((b) => b.textContent === "Copy message")).toHaveLength(1);
    expect($$("button").filter((b) => b.textContent === "Copy link")).toHaveLength(1);
  });

  it("adds a Share button that shares the message in the textarea, as text only, ending with the link", async () => {
    const share = vi.fn(async () => {});
    await create({ navigator: { share } });
    expect($$(".share")).toHaveLength(1);
    expect(shareButton()!.getAttribute("aria-label")).toBe('Share "Trial Day"');
    // the existing link box, message box, Copy buttons and WhatsApp link are all still there
    expect(input("booking-link").value).toBe(ADDRESS);
    expect(buttonNamed("Copy link")).toBeDefined();
    expect($$("button").filter((b) => b.textContent === "Copy message" && !b.hidden)).toHaveLength(1); // the page's own, not a second one
    expect($$("a").some((a) => a.textContent === "Open in WhatsApp")).toBe(true);
    shareButton()!.click();
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]).toEqual([{ text: message() }]);
    expect(message().endsWith(`\n${ADDRESS}`)).toBe(true);
  });

  it("uses the event's own message, over the default template, over the built-in one", async () => {
    const templates = () => reply(200, { templates: [
      { id: 1, isDefault: false, shareMessage: "Not this one" }, { id: 2, isDefault: true, shareMessage: "Default: {event}" },
    ] });
    await create({ templates, create: withEvent({ shareMessage: "Own: {event} at {postcode}" }) });
    expect(message()).toBe(`Own: Trial Day at SW1A 1AA\n${ADDRESS}`);
    await create({ templates, create: withEvent({ shareMessage: "" }) });
    expect(message()).toBe(`Default: Trial Day\n${ADDRESS}`);
    await create({ create: withEvent({ shareMessage: "" }) });
    expect(message()).toContain("\nVenue: SW1A 1AA\nCost: £12.50\nBook your slot:\n");
  });

  it("asks for the default template once, when the page loads, not when the event is saved", async () => {
    const { calls } = await start();
    expect(calls.filter((c) => c.url === TEMPLATES).map((c) => c.init?.method ?? "GET")).toEqual(["GET"]);
    fillAll();
    submit();
    await tick();
    expect(calls.filter((c) => c.url === TEMPLATES)).toHaveLength(1);
  });

  it("falls back to the built-in message when the templates can't be loaded", async () => {
    for (const templates of [() => reply(500, null), () => Promise.reject(new TypeError("offline")), () => reply(200, { templates: "nope" })]) {
      await create({ templates });
      expect($("h1").textContent).toBe("Event created");
      expect(message()).toContain("Book your slot:\nhttps://club.example/e/abc123");
    }
  });

  it("keeps the message, and so the WhatsApp link made from it, bounded however long the details are", async () => {
    const huge = withEvent({ details: "é".repeat(2000), shareMessage: Array(111).fill("{details}").join("") });
    await create({ create: huge });
    expect(message().length).toBeLessThanOrEqual(MAX_SHARE_MESSAGE_LENGTH);
    expect(message().endsWith("…\nhttps://club.example/e/abc123")).toBe(true);
    const href = $$("a").find((a) => a.textContent === "Open in WhatsApp")!.getAttribute("href")!;
    expect(href).toBe(`https://wa.me/?text=${encodeURIComponent(message())}`);
    expect(href.length).toBeLessThanOrEqual("https://wa.me/?text=".length + MAX_SHARE_MESSAGE_LENGTH * 9);
  });

  it("keeps hostile text inert: nothing in the page is built from it, and the message holds it as plain text", async () => {
    const hostile = withEvent({ name: HOSTILE, details: HOSTILE, shareMessage: "{event}\n{details}" });
    await create({ navigator: { share: vi.fn(async () => {}) }, create: hostile });
    expect(message()).toBe(`${HOSTILE}\n${HOSTILE}\n${ADDRESS}`);
    expect(document.querySelector("img, [onerror]")).toBeNull(); // the markup only ever appears as text and inside attribute values
    expect($(".event-name").textContent).toBe(HOSTILE);
    expect(shareButton()!.getAttribute("aria-label")).toBe(`Share "${HOSTILE}"`);
    expect($$("a").find((a) => a.textContent === "Open in WhatsApp")!.getAttribute("href")).toBe(`https://wa.me/?text=${encodeURIComponent(message())}`);
  });
});

describe("template picker and share message", () => {
  const SATURDAY = {
    id: 1, name: "Saturday trial", isDefault: true, details: "Bring water", venuePostcode: "AB1 2CD", costPence: 1500,
    start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 5, breaks: [{ start: "10:30", end: "10:45", label: "Tea" }],
    shareMessage: "Book {event} on {date}",
  };
  const EVENING = {
    id: 2, name: "Evening", isDefault: false, details: "", venuePostcode: "EF3 4GH", costPence: 1250,
    start: "18:00", end: "20:00", sessionMinutes: 20, gapMinutes: 0,
    breaks: [{ start: "18:50", end: "19:00", label: "" }, { start: "19:20", end: "19:30", label: "Water" }], shareMessage: "",
  };
  const BOTH = () => reply(200, { templates: [SATURDAY, EVENING] });
  const picker = () => document.getElementById("template") as HTMLSelectElement;
  const area = (id: string) => document.getElementById(id) as HTMLTextAreaElement;
  const choose = (value: string) => {
    picker().value = value;
    picker().dispatchEvent(new Event("change", { bubbles: true }));
  };
  const status = () => $(".form-status").textContent;
  const breakValues = () => $$(".break-row").map((r) => [...r.querySelectorAll("input")].map((i) => i.value));
  const created = (calls: Call[]) => calls.find((c) => c.url === CREATE)!.body;
  // happy-dom's window.confirm isn't scriptable per answer: each test sets the one it needs, and afterEach puts the original back.
  const originalConfirm = (document.defaultView as unknown as { confirm?: unknown }).confirm;
  const answer = (value: boolean) => {
    const confirm = vi.fn(() => value);
    (document.defaultView as unknown as { confirm: unknown }).confirm = confirm;
    return confirm;
  };
  afterEach(() => { (document.defaultView as unknown as { confirm?: unknown }).confirm = originalConfirm; });
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { release, promise };
  };

  it("is a labelled select with No template first, the default marked, and a note", async () => {
    await start({ templates: BOTH });
    await tick();
    expect($("label[for='template']").textContent).toBe("Template");
    expect([...picker().options].map((o) => o.textContent)).toEqual(["No template", "Saturday trial (default)", "Evening"]);
    expect([...picker().options].map((o) => o.value)).toEqual(["", "1", "2"]);
    expect(document.getElementById("template-hint")!.textContent).toBe(
      "Choosing a template replaces the details, times, cost, breaks, booking form, lanes, places and share message below. The event name and date stay as they are. The event keeps its own copy: changing a template later never changes events already made.");
    expect(picker().getAttribute("aria-describedby")).toBe("template-hint");
    expect(picker().closest(".field")!.hasAttribute("hidden")).toBe(false);
  });

  it("applies the default template when it arrives and nothing has been touched, and says so", async () => {
    await start({ templates: BOTH });
    await tick();
    expect(picker().value).toBe("1");
    expect(input("details").value).toBe("Bring water");
    expect(input("postcode").value).toBe("AB1 2CD");
    expect(input("cost").value).toBe("15");
    expect(input("start").value).toBe("09:00");
    expect(input("end").value).toBe("12:00");
    expect(input("session").value).toBe("15");
    expect(input("gap").value).toBe("5");
    expect(area("share-message").value).toBe("Book {event} on {date}");
    expect(breakValues()).toEqual([["10:30", "10:45", "Tea"]]);
    expect(input("name").value).toBe("");
    expect(input("date").value).toBe("");
    expect(input("listed").checked).toBe(true);
    expect(status()).toBe("Filled in from the template Saturday trial.");
    expect($(".form-status").getAttribute("aria-live")).toBe("polite");
  });

  it("does not apply it when something was typed before the templates arrived, and leaves the picker on No template", async () => {
    const g = gate();
    await start({ templates: async () => { await g.promise; return BOTH(); } });
    expect(picker()).not.toBeNull();
    expect(picker().closest(".field")!.hasAttribute("hidden")).toBe(true);
    set("name", "My own event");
    set("postcode", "ZZ1 1ZZ");
    g.release();
    await tick();
    expect(picker().closest(".field")!.hasAttribute("hidden")).toBe(false);
    expect(picker().value).toBe("");
    expect(input("name").value).toBe("My own event");
    expect(input("postcode").value).toBe("ZZ1 1ZZ");
    expect(input("details").value).toBe("");
    expect(input("cost").value).toBe("");
    expect(breakValues()).toEqual([]);
    expect(status()).toBe("");
  });

  it("does not apply it after a break row was added by hand either", async () => {
    const g = gate();
    await start({ templates: async () => { await g.promise; return BOTH(); } });
    buttonNamed("Add break").click();
    g.release();
    await tick();
    expect(picker().value).toBe("");
    expect(breakValues()).toEqual([["", "", ""]]);
  });

  it("works before the templates arrive: the form can be filled in and saved", async () => {
    const g = gate();
    const { calls } = await start({ templates: async () => { await g.promise; return BOTH(); } });
    fillAll();
    submit();
    await tick();
    expect(created(calls)).toMatchObject({ name: "Trial Day", shareMessage: "" });
    g.release();
    await tick();
  });

  it("switching replaces the template fields, breaks and message but never the name, date or Listed", async () => {
    await start({ templates: BOTH });
    await tick();
    set("name", "Spring Scent Trial");
    set("date", "2026-06-13");
    input("listed").click();
    choose("2");
    expect(input("details").value).toBe("");
    expect(input("postcode").value).toBe("EF3 4GH");
    expect(input("cost").value).toBe("12.50");
    expect(input("start").value).toBe("18:00");
    expect(input("end").value).toBe("20:00");
    expect(input("session").value).toBe("20");
    expect(input("gap").value).toBe("0");
    expect(area("share-message").value).toBe("");
    expect(breakValues()).toEqual([["18:50", "19:00", ""], ["19:20", "19:30", "Water"]]);
    expect(input("name").value).toBe("Spring Scent Trial");
    expect(input("date").value).toBe("2026-06-13");
    expect(input("listed").checked).toBe(false);
    expect(status()).toBe("Filled in from the template Evening.");
    choose("1");
    expect(breakValues()).toEqual([["10:30", "10:45", "Tea"]]);
    expect(input("name").value).toBe("Spring Scent Trial");
  });

  it("replaces what the user typed in those fields when a template is chosen and the user agrees", async () => {
    await start({ templates: BOTH });
    await tick();
    const confirm = answer(true);
    set("postcode", "typed 1AA");
    set("details", "typed details");
    choose("2");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(input("postcode").value).toBe("EF3 4GH");
    expect(input("details").value).toBe("");
  });

  describe("protecting what was typed", () => {
    const MESSAGE = "Replace what you've typed in the details, times, cost, breaks, booking form, lanes, places and share message with this template?";
    const typed: [string, () => void][] = [
      ["details", () => set("details", "mine")], ["postcode", () => set("postcode", "ZZ1 1ZZ")], ["cost", () => set("cost", "3")],
      ["start", () => set("start", "08:00")], ["end", () => set("end", "13:00")], ["session", () => set("session", "10")],
      ["gap", () => set("gap", "0")], ["share message", () => set("share-message", "mine")],
      ["a break time", () => set("break-1-start", "10:00")], ["a break name", () => set("break-1-label", "Coffee")],
      ["adding a break", () => buttonNamed("Add break").click()], ["removing a break", () => $("button[aria-label='Remove break 1']").click()],
    ];

    it("applies silently when nothing was edited since the default was applied, name, date and Listed aside", async () => {
      await start({ templates: BOTH });
      await tick();
      const confirm = answer(false);
      set("name", "Spring Scent Trial");
      set("date", "2026-06-13");
      input("listed").click();
      choose("2");
      expect(confirm).not.toHaveBeenCalled();
      expect(picker().value).toBe("2");
      expect(input("postcode").value).toBe("EF3 4GH");
    });

    it.each(typed)("asks first when %s was changed, and changes nothing if the user declines", async (_what, edit) => {
      await start({ templates: BOTH });
      await tick();
      const confirm = answer(false);
      edit();
      const before = [input("details").value, input("postcode").value, input("cost").value, input("start").value, input("end").value, area("share-message").value, JSON.stringify(breakValues())];
      choose("2");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith(MESSAGE);
      expect(picker().value).toBe("1");
      expect([input("details").value, input("postcode").value, input("cost").value, input("start").value, input("end").value, area("share-message").value, JSON.stringify(breakValues())]).toEqual(before);
      expect(status()).toBe("Filled in from the template Saturday trial.");
    });

    it("applies the template when the user agrees, and then does not ask again until something else is typed", async () => {
      await start({ templates: BOTH });
      await tick();
      const confirm = answer(true);
      set("postcode", "ZZ1 1ZZ");
      choose("2");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(input("postcode").value).toBe("EF3 4GH");
      expect(breakValues()).toEqual([["18:50", "19:00", ""], ["19:20", "19:30", "Water"]]);
      choose("1");
      expect(confirm).toHaveBeenCalledTimes(1); // nothing edited since the last apply
      expect(input("postcode").value).toBe("AB1 2CD");
      set("cost", "9");
      choose("2");
      expect(confirm).toHaveBeenCalledTimes(2);
    });

    it("keeps asking after a decline, because what was typed is still there", async () => {
      await start({ templates: BOTH });
      await tick();
      const confirm = answer(false);
      set("details", "mine");
      choose("2");
      choose("");
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(picker().value).toBe("1");
      expect(input("details").value).toBe("mine");
      confirm.mockReturnValue(true);
      choose("");
      expect(input("details").value).toBe("");
      expect(picker().value).toBe("");
    });

    it("counts edits made before any template was applied, and a decline puts the picker back on No template", async () => {
      const g = gate();
      await start({ templates: async () => { await g.promise; return BOTH(); } });
      set("postcode", "ZZ1 1ZZ");
      g.release();
      await tick();
      const confirm = answer(false);
      choose("1");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(picker().value).toBe("");
      expect(input("postcode").value).toBe("ZZ1 1ZZ");
      expect(breakValues()).toEqual([]);
    });

    it("applies without asking when the browser has no confirm", async () => {
      await start({ templates: BOTH });
      await tick();
      (document.defaultView as unknown as { confirm?: unknown }).confirm = undefined;
      set("details", "mine");
      choose("2");
      expect(input("postcode").value).toBe("EF3 4GH");
    });
  });

  describe("while the event is being saved", () => {
    it("disables the picker, and enables it again when the save fails", async () => {
      const g = gate();
      const { calls } = await start({ templates: BOTH, create: async () => { await g.promise; return reply(500, null); } });
      await tick();
      fillAll();
      submit();
      await tick();
      expect(picker().disabled).toBe(true);
      expect(calls.filter((c) => c.url === CREATE)).toHaveLength(1);
      g.release();
      await tick();
      expect(picker().disabled).toBe(false);
    });
  });

  it("No template clears exactly the template-held fields and removes the breaks", async () => {
    await start({ templates: BOTH });
    await tick();
    set("name", "Spring Scent Trial");
    set("date", "2026-06-13");
    choose("");
    for (const id of ["details", "postcode", "cost", "start", "end", "session", "gap", "share-message"]) expect(area(id).value, id).toBe("");
    expect(breakValues()).toEqual([]);
    expect($$(".break-row")).toHaveLength(0);
    expect(input("name").value).toBe("Spring Scent Trial");
    expect(input("date").value).toBe("2026-06-13");
    expect(status()).toBe("Cleared the template fields.");
    // cleared fields start fresh: no cost error until the user touches it or tries to save
    expect(errorOf("cost")).toBe("");
  });

  it("shows a free template's cost as 0", async () => {
    await start({ templates: () => reply(200, { templates: [{ ...SATURDAY, costPence: 0 }] }) });
    await tick();
    expect(input("cost").value).toBe("0");
    expect(errorOf("cost")).toBe("");
  });

  it("previews the filled schedule once the date is there, with the template's breaks", async () => {
    const { calls } = await start({ templates: BOTH });
    await tick();
    set("date", "2026-06-13");
    await settle();
    expect(previewCalls(calls).at(-1)!.body).toMatchObject({
      date: "2026-06-13", start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 5,
      breaks: [{ start: "10:30", end: "10:45", label: "Tea" }],
    });
    const before = previewCalls(calls).length;
    choose("2");
    await settle();
    expect(previewCalls(calls)).toHaveLength(before + 1);
    expect(previewCalls(calls).at(-1)!.body).toMatchObject({ start: "18:00", end: "20:00", sessionMinutes: 20, gapMinutes: 0 });
    expect(chips()).toEqual(["09:00", "09:20", "09:40"]);
  });

  it("rebuilds the break rows with their names, and each can be removed afterwards", async () => {
    const { calls } = await start({ templates: BOTH });
    await tick();
    choose("2");
    expect($$(".break-row legend").map((l) => l.textContent)).toEqual(["Break 1", "Break 2"]);
    const ids = $$(".break-row input[id$='-label']").map((i) => i.id);
    expect(ids).toHaveLength(2);
    expect(input(ids[1]).value).toBe("Water");
    // the old row's fields are gone from the form's bookkeeping: none of the earlier ids is left in the page
    expect(document.getElementById("break-1-label")).toBeNull();
    $("button[aria-label='Remove break 1']").click();
    expect(breakValues()).toEqual([["19:20", "19:30", "Water"]]);
    expect($$(".break-row legend").map((l) => l.textContent)).toEqual(["Break 1"]);
    set("name", "Trial Day"); set("date", "2026-06-13");
    submit();
    await tick();
    expect(created(calls).breaks).toEqual([{ start: "19:20", end: "19:30", label: "Water" }]);
  });

  it("can switch templates repeatedly without leaving stale rows or errors behind", async () => {
    const { calls } = await start({ templates: BOTH });
    await tick();
    for (const v of ["2", "1", "2", "", "1"]) choose(v);
    expect(breakValues()).toEqual([["10:30", "10:45", "Tea"]]);
    set("name", "Trial Day"); set("date", "2026-06-13");
    submit();
    await tick();
    expect(created(calls).breaks).toEqual([{ start: "10:30", end: "10:45", label: "Tea" }]);
  });

  it("sends the filled-in values and the share message, still with one idempotency key", async () => {
    const { calls } = await start({ templates: BOTH });
    await tick();
    set("name", "Spring Scent Trial");
    set("date", "2026-06-13");
    submit();
    await tick();
    expect(created(calls)).toEqual({
      name: "Spring Scent Trial", date: "2026-06-13", start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 5,
      costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water", shareMessage: "Book {event} on {date}",
      breaks: [{ start: "10:30", end: "10:45", label: "Tea" }], listed: true, idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      fields: [{ label: "Name", required: true, maxLength: 80, identity: true }], identityLimit: 1,
    });
  });

  it("sends a share message typed by hand, and never previews because of it", async () => {
    const { calls } = await start();
    fillAll();
    await settle();
    const before = previewCalls(calls).length;
    set("share-message", "  Come along to {event}!  ");
    await settle();
    expect(previewCalls(calls)).toHaveLength(before);
    submit();
    await tick();
    expect(created(calls).shareMessage).toBe("Come along to {event}!");
  });

  it("has the share message field with its note and a link to the templates page", async () => {
    await start();
    const field = area("share-message");
    expect(field.maxLength).toBe(1000);
    expect($("label[for='share-message']").textContent).toBe("Share message (optional)");
    const hint = document.getElementById("share-message-hint")!;
    expect(hint.textContent).toContain("Used when you share this event. Leave it blank to use your default template's message.");
    expect(hint.textContent).toContain("Placeholders such as {event} and {date} are filled in when you share.");
    expect(hint.querySelector("a")!.getAttribute("href")).toBe("/admin/templates");
  });

  it("shows the server's shareMessage error on the field", async () => {
    await start({ create: () => reply(400, { error: { code: "invalid_input" }, fields: { shareMessage: "Too long." } }) });
    fillAll();
    submit();
    await tick();
    expect(errorOf("share-message")).toBe("Too long.");
    expect(area("share-message").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(area("share-message"));
    set("share-message", "Shorter");
    expect(errorOf("share-message")).toBe("");
  });

  it("hides the picker with a quiet note when the templates can't be loaded, and the form still works", async () => {
    for (const templates of [() => reply(500, null), () => Promise.reject(new TypeError("offline")), () => reply(200, { templates: "nope" })]) {
      const { calls } = await start({ templates });
      await tick();
      expect(picker().closest(".field")!.hasAttribute("hidden")).toBe(true);
      expect(text()).toContain("Templates couldn't be loaded. You can still fill the form in by hand.");
      fillAll();
      submit();
      await tick();
      expect(created(calls)).toMatchObject({ name: "Trial Day", shareMessage: "" });
    }
  });

  it("hides the picker and offers a link to the templates page when there are none", async () => {
    await start({ templates: () => reply(200, { templates: [] }) });
    await tick();
    expect(picker().closest(".field")!.hasAttribute("hidden")).toBe(true);
    const link = $$("a").find((a) => a.textContent === "Create a template to save time") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/admin/templates");
    expect(text()).not.toContain("couldn't be loaded");
  });

  it("asks for the templates once, and does not show them to a signed-out visitor", async () => {
    const { calls } = await start({ templates: BOTH });
    await tick();
    expect(calls.filter((c) => c.url === TEMPLATES)).toHaveLength(1);
    const { navigate } = await start({ templates: () => reply(401, { error: { code: "unauthenticated" } }) });
    await tick();
    expect(navigate).toHaveBeenCalledWith("/admin/login");
    expect(text()).not.toContain("couldn't be loaded");
  });

  it("treats template text as text: names, details and messages never become elements", async () => {
    const hostile = { ...SATURDAY, name: HOSTILE, details: HOSTILE, shareMessage: HOSTILE, breaks: [{ start: "10:30", end: "10:45", label: HOSTILE.slice(0, 40) }] };
    await start({ templates: () => reply(200, { templates: [hostile] }) });
    await tick();
    expect([...picker().options].map((o) => o.textContent)).toEqual(["No template", `${HOSTILE} (default)`]);
    expect(input("details").value).toBe(HOSTILE);
    expect(area("share-message").value).toBe(HOSTILE);
    expect(status()).toBe(`Filled in from the template ${HOSTILE}.`);
    expect(document.querySelector("img, [onerror]")).toBeNull();
  });
});

describe("lanes and places", () => {
  const laneInputs = () => $$(".lane-row input") as HTMLInputElement[];
  const laneName = (n: number, value: string) => {
    laneInputs()[n].value = value;
    laneInputs()[n].dispatchEvent(new Event("input", { bubbles: true }));
  };
  const created = (calls: Call[]) => calls.find((c) => c.url === CREATE)!.body;
  const addLane = () => buttonNamed("Add lane").click();
  const removeButton = (n: number) => $(`button[aria-label='Remove lane ${n}']`) as HTMLButtonElement;

  it("starts with one lane whose name is optional, a hint, no Remove, and one place per time", async () => {
    await start();
    expect(laneInputs()).toHaveLength(1);
    expect($(".lane-row label").textContent).toBe("Lane name (optional)");
    expect(laneInputs()[0].required).toBe(false);
    const hint = document.getElementById(laneInputs()[0].id + "-hint")!;
    expect(hint.textContent).toBe("Leave blank if you only have one");
    expect(hint.hidden).toBe(false);
    expect(laneInputs()[0].getAttribute("aria-describedby")).toBe(`${laneInputs()[0].id}-hint ${laneInputs()[0].id}-error`);
    expect(removeButton(1).hidden).toBe(true);
    expect($(".lanes-group legend").textContent).toBe("Lanes");
    expect(input("capacity").value).toBe("1");
    expect($("label[for='capacity']").textContent).toBe("Places per lane per time");
    expect(input("capacity").type).toBe("number");
    expect([input("capacity").min, input("capacity").max, input("capacity").step]).toEqual(["1", "50", "1"]);
    expect(input("capacity").getAttribute("inputmode")).toBe("numeric");
    expect(document.getElementById("capacity-hint")!.textContent).toContain("Leave it at 1");
    expect(input("capacity").getAttribute("aria-describedby")).toBe("capacity-hint capacity-error");
    expect($(".places-summary").textContent).toBe("");
  });

  it("adds and removes lanes: each is then named, numbered and removable, and the last one can't be removed", async () => {
    await start();
    laneName(0, "Ring 1");
    addLane();
    expect(laneInputs()).toHaveLength(2);
    expect(document.activeElement).toBe(laneInputs()[1]);
    expect($$(".lane-row label").map((l) => l.textContent)).toEqual(["Name", "Name"]);
    expect($$(".lane-row legend").map((l) => [l.textContent, l.className])).toEqual([["Lane 1", ""], ["Lane 2", ""]]);
    expect(laneInputs().map((i) => i.required)).toEqual([true, true]);
    expect($$(".lane-row .note").every((n) => n.hidden)).toBe(true);
    expect(removeButton(1).hidden).toBe(false);
    expect(removeButton(2).hidden).toBe(false);
    laneName(1, "Ring 2");
    removeButton(1).click();
    expect(laneInputs().map((i) => i.value)).toEqual(["Ring 2"]);
    expect($(".lane-row label").textContent).toBe("Lane name (optional)");
    expect(document.activeElement).toBe(buttonNamed("Add lane"));
    expect($$("button").filter((b) => b.getAttribute("aria-label")?.startsWith("Remove lane") && !b.hidden)).toHaveLength(0);
  });

  it("stops at ten lanes", async () => {
    await start();
    for (let i = 0; i < 9; i++) addLane();
    expect(laneInputs()).toHaveLength(10);
    expect((buttonNamed("Add lane") as HTMLButtonElement).disabled).toBe(true);
    removeButton(10).click();
    expect((buttonNamed("Add lane") as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends the lanes (named, in order, no ids) and the places on create, and nothing for one unnamed lane with one place", async () => {
    const { calls } = await start();
    fillAll();
    addLane();
    addLane();
    laneName(0, " Ring 1 ");
    laneName(1, "Ring 2");
    laneName(2, "Ring 3");
    set("capacity", "2");
    submit();
    await tick();
    expect(created(calls)).toMatchObject({ lanes: [{ name: "Ring 1" }, { name: "Ring 2" }, { name: "Ring 3" }], capacity: 2 });
    expect(created(calls).lanes.every((l: object) => !("id" in l))).toBe(true);
    const plain = await start();
    fillAll();
    submit();
    await tick();
    expect(created(plain.calls)).not.toHaveProperty("lanes");
    expect(created(plain.calls)).not.toHaveProperty("capacity");
  });

  it("sends a single named lane, and places alone", async () => {
    const { calls } = await start();
    fillAll();
    laneName(0, "Main ring");
    submit();
    await tick();
    expect(created(calls)).toMatchObject({ lanes: [{ name: "Main ring" }] });
    expect(created(calls)).not.toHaveProperty("capacity");
    const more = await start();
    fillAll();
    set("capacity", "4");
    submit();
    await tick();
    expect(created(more.calls).capacity).toBe(4);
    expect(created(more.calls)).not.toHaveProperty("lanes");
  });

  it("sends a capacity that isn't a whole number as null so the server says so, against the capacity field", async () => {
    const { calls } = await start({ create: () => reply(400, { error: { code: "invalid_input" }, fields: { capacity: "Enter a whole number of places from 1 to 50." } }) });
    fillAll();
    set("capacity", "");
    submit();
    await tick();
    expect(created(calls).capacity).toBeNull();
    expect(errorOf("capacity")).toBe("Enter a whole number of places from 1 to 50.");
    expect(input("capacity").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input("capacity"));
  });

  it("puts the server's lane errors on the right lane, however many were removed before, and focuses the first", async () => {
    const { calls } = await start({
      create: () => reply(400, { error: { code: "invalid_input" }, fields: { "lanes.1.name": "Two lanes can't have the same name.", "lanes.0.name": "Each lane needs a name." } }),
    });
    fillAll();
    addLane();
    addLane();
    removeButton(1).click(); // the first row is gone: the payload's lane 0 is now the second row
    laneName(0, "");
    laneName(1, "Same");
    submit();
    await tick();
    expect(created(calls).lanes).toEqual([{ name: "" }, { name: "Same" }]);
    const [first, second] = laneInputs();
    expect(document.getElementById(`${first.id}-error`)!.textContent).toBe("Each lane needs a name.");
    expect(document.getElementById(`${second.id}-error`)!.textContent).toBe("Two lanes can't have the same name.");
    expect([first.getAttribute("aria-invalid"), second.getAttribute("aria-invalid")]).toEqual(["true", "true"]);
    expect(document.activeElement).toBe(first);
    laneName(0, "Other");
    expect(document.getElementById(`${first.id}-error`)!.textContent).toBe("");
    expect(first.hasAttribute("aria-invalid")).toBe(false);
    expect(document.getElementById(`${second.id}-error`)!.textContent).toBe("Two lanes can't have the same name.");
  });

  it("shows the lanes list error under the lanes, and clears it when a lane is added or removed", async () => {
    await start({ create: () => reply(400, { error: { code: "invalid_input" }, fields: { lanes: "You can have at most 10 lanes." } }) });
    fillAll();
    submit();
    await tick();
    expect(errorOf("lanes")).toBe("You can have at most 10 lanes.");
    addLane();
    expect(errorOf("lanes")).toBe("");
  });

  it("shows a lane error the preview reports about the places (too many), against the places field", async () => {
    await start({ preview: () => reply(400, { error: { code: "invalid_input" }, fields: { capacity: "That would make 3000 places." } }) });
    fillAll();
    set("capacity", "50");
    await settle();
    expect(errorOf("capacity")).toBe("That would make 3000 places.");
    expect(input("capacity").getAttribute("aria-invalid")).toBe("true");
    set("capacity", "40");
    expect(errorOf("capacity")).toBe("");
  });

  describe("the preview and the summary", () => {
    it("previews with the lane count and the places, never the typed names, and only when they differ from one lane with one place", async () => {
      const { calls } = await start();
      fillSchedule();
      await settle();
      expect(previewCalls(calls).at(-1)!.body).not.toHaveProperty("lanes");
      expect(previewCalls(calls).at(-1)!.body).not.toHaveProperty("capacity");
      addLane();
      addLane();
      set("capacity", "2");
      await settle();
      expect(previewCalls(calls).at(-1)!.body).toMatchObject({ lanes: [{ name: "Lane 1" }, { name: "Lane 2" }, { name: "Lane 3" }], capacity: 2 });
    });

    it("leaves a capacity that isn't 1 to 50 out of the preview, so typing never blanks the schedule", async () => {
      const { calls } = await start();
      fillSchedule();
      await settle();
      for (const bad of ["", "0", "51", "1.5"]) {
        set("capacity", bad);
        await settle();
        expect(previewCalls(calls).at(-1)!.body, bad).not.toHaveProperty("capacity");
      }
      expect(chips()).toEqual(["09:00", "09:20", "09:40"]);
    });

    it("shows 'N times × L lanes × C places = P places' from the preview, and clears it when the draft is unusable", async () => {
      await start({ preview: () => preview({ placeCount: 18 }) });
      fillSchedule();
      addLane();
      addLane();
      set("capacity", "2");
      await settle();
      expect($(".places-summary").textContent).toBe("3 times × 3 lanes × 2 places = 18 places");
      expect($(".places-summary").getAttribute("aria-live")).toBe("polite");
      expect($(".preview-summary").textContent).toBe("3 slots");
      set("end", "");
      expect($(".places-summary").textContent).toBe("");
    });

    it("says nothing for one lane with one place, and uses singular words", async () => {
      await start({ preview: () => preview({ placeCount: 3 }) });
      fillSchedule();
      await settle();
      expect($(".places-summary").textContent).toBe("");
      expect($(".preview-summary").textContent).toBe("3 slots");
      set("capacity", "1");
      addLane();
      await settle();
      expect($(".places-summary").textContent).toBe("3 times × 2 lanes × 1 place = 3 places");
    });

    it("counts the lanes that are left after one is removed, once the preview has run again", async () => {
      await start({ preview: () => preview({ placeCount: 6 }) });
      fillSchedule();
      addLane();
      addLane();
      set("capacity", "2");
      await settle();
      expect($(".places-summary").textContent).toBe("3 times × 3 lanes × 2 places = 6 places");
      removeButton(3).click();
      await settle();
      expect($(".places-summary").textContent).toBe("3 times × 2 lanes × 2 places = 6 places");
    });
  });

  describe("templates", () => {
    const WITH_LANES = {
      id: 1, name: "Rings", isDefault: false, details: "", venuePostcode: "AB1 2CD", costPence: 1500, start: "09:00", end: "12:00",
      sessionMinutes: 15, gapMinutes: 5, breaks: [], shareMessage: "", lanes: [{ name: "Ring 1" }, { name: "Ring 2" }], capacity: 3,
    };
    const OLD_STYLE = { ...WITH_LANES, id: 2, name: "Old", lanes: undefined, capacity: undefined };
    const picker = () => document.getElementById("template") as HTMLSelectElement;
    const choose = (value: string) => {
      picker().value = value;
      picker().dispatchEvent(new Event("change", { bubbles: true }));
    };

    it("copies the template's lane names and places into the form, and sends them", async () => {
      const { calls } = await start({ templates: () => reply(200, { templates: [{ ...WITH_LANES, isDefault: true }] }) });
      await tick();
      expect(laneInputs().map((i) => i.value)).toEqual(["Ring 1", "Ring 2"]);
      expect(input("capacity").value).toBe("3");
      set("name", "Trial Day");
      set("date", "2026-06-13");
      submit();
      await tick();
      expect(created(calls)).toMatchObject({ lanes: [{ name: "Ring 1" }, { name: "Ring 2" }], capacity: 3 });
      expect(created(calls).lanes.every((l: object) => !("id" in l))).toBe(true);
    });

    it("switches between templates and No template, leaving one unnamed lane and one place for a template without lanes", async () => {
      await start({ templates: () => reply(200, { templates: [WITH_LANES, OLD_STYLE] }) });
      await tick();
      choose("1");
      expect(laneInputs().map((i) => i.value)).toEqual(["Ring 1", "Ring 2"]);
      expect($$(".lane-row legend").map((l) => l.textContent)).toEqual(["Lane 1", "Lane 2"]);
      choose("2");
      expect(laneInputs().map((i) => i.value)).toEqual([""]);
      expect(input("capacity").value).toBe("1");
      choose("1");
      expect(input("capacity").value).toBe("3");
      choose("");
      expect(laneInputs().map((i) => i.value)).toEqual([""]);
      expect(input("capacity").value).toBe("1");
      expect($(".lane-row label").textContent).toBe("Lane name (optional)");
    });

    it("counts lane and places edits as edits a template must ask before replacing", async () => {
      const confirm = vi.fn(() => false);
      (document.defaultView as unknown as { confirm: unknown }).confirm = confirm;
      await start({ templates: () => reply(200, { templates: [WITH_LANES, OLD_STYLE] }) });
      await tick();
      choose("1");
      expect(confirm).not.toHaveBeenCalled();
      set("capacity", "5");
      choose("2");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(picker().value).toBe("1");
      expect(input("capacity").value).toBe("5");
      for (const edit of [() => laneName(0, "Changed"), () => addLane(), () => removeButton(1).click()]) {
        await start({ templates: () => reply(200, { templates: [WITH_LANES, OLD_STYLE] }) });
        await tick();
        choose("1");
        confirm.mockClear();
        edit();
        choose("2");
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(picker().value).toBe("1");
      }
    });
  });
});

describe("booking form", () => {
  const NAME = { label: "Name", required: true, maxLength: 80, identity: true };
  const cardRows = () => $$(".field-def");
  const part = (row: number, what: "label" | "required" | "max" | "identity") => cardRows()[row].querySelector(`[id$="-${what}"]`) as HTMLInputElement;
  const typeInto = (el: HTMLInputElement, value: string) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); };
  const addField = () => buttonNamed("Add field").click();
  const limit = () => input("event-identity-limit");
  const limitLabel = () => $(`label[for="event-identity-limit"]`).textContent;
  const hintOf = (row: number) => cardRows()[row].querySelector(".note")!;
  const created = (calls: Call[]) => calls.find((c) => c.url === CREATE)!.body;
  const fill = () => { fillAll(); };
  const errorText = (el: HTMLElement) => document.getElementById(`${el.id}-error`)!.textContent;

  it("is a card called Booking form before Lanes, with one required Name field that identifies the booking and a limit of 1", async () => {
    await start();
    const card = $(".fields-group");
    expect(card.querySelector("legend")!.textContent).toBe("Booking form");
    expect(card.nextElementSibling!.classList.contains("lanes-group")).toBe(true);
    expect(cardRows()).toHaveLength(1);
    expect(cardRows()[0].querySelector("legend")!.textContent).toBe("Field 1");
    expect(part(0, "label").value).toBe("Name");
    expect(part(0, "label").maxLength).toBe(40);
    expect([part(0, "required").checked, part(0, "required").disabled]).toEqual([true, true]);
    expect(part(0, "identity").checked).toBe(true);
    expect(part(0, "max").value).toBe("80");
    expect([part(0, "max").min, part(0, "max").max]).toEqual(["1", "80"]);
    expect(limit().value).toBe("1");
    expect([limit().min, limit().max]).toEqual(["1", "20"]);
    expect(limitLabel()).toBe("How many bookings can one Name make?");
    expect(cardRows()[0].querySelector<HTMLElement>("button.remove")!.hidden).toBe(true);
    expect((buttonNamed("Add field") as HTMLButtonElement).disabled).toBe(false);
  });

  it("adds fields up to four, disables Add at four, shows Remove on each row, and focuses the new label", async () => {
    await start();
    addField();
    expect(cardRows()).toHaveLength(2);
    expect(document.activeElement).toBe(part(1, "label"));
    expect(part(1, "label").value).toBe("");
    expect([part(1, "required").checked, part(1, "required").disabled, part(1, "identity").checked, part(1, "max").value]).toEqual([false, false, false, "80"]);
    expect(cardRows().map((r) => r.querySelector<HTMLElement>("button.remove")!.hidden)).toEqual([false, false]);
    addField();
    addField();
    expect(cardRows()).toHaveLength(4);
    expect((buttonNamed("Add field") as HTMLButtonElement).disabled).toBe(true);
    expect(cardRows().map((r) => r.querySelector("legend")!.textContent)).toEqual(["Field 1", "Field 2", "Field 3", "Field 4"]);
    expect(cardRows()[2].querySelector("button.remove")!.getAttribute("aria-label")).toBe("Remove field 3");
  });

  it("removes a field, renumbers, re-enables Add, hides the last Remove and moves focus to Add field", async () => {
    await start();
    addField();
    addField();
    typeInto(part(1, "label"), "Phone");
    typeInto(part(2, "label"), "Car reg");
    (cardRows()[1].querySelector("button.remove") as HTMLButtonElement).click();
    expect(cardRows().map((r) => r.querySelector("legend")!.textContent)).toEqual(["Field 1", "Field 2"]);
    expect(part(1, "label").value).toBe("Car reg");
    expect(document.activeElement).toBe(buttonNamed("Add field"));
    (cardRows()[1].querySelector("button.remove") as HTMLButtonElement).click();
    expect(cardRows()[0].querySelector<HTMLElement>("button.remove")!.hidden).toBe(true);
  });

  it("makes field 1 and every identity field required and disabled, and lets a ticked-off identity field be required or not again", async () => {
    await start();
    addField();
    const req = part(1, "required");
    expect([req.checked, req.disabled]).toEqual([false, false]);
    part(1, "identity").click();
    expect([req.checked, req.disabled]).toEqual([true, true]);
    expect(hintOf(1).textContent).toBe("Always required: it identifies a booking.");
    expect((hintOf(1) as HTMLElement).hidden).toBe(false);
    part(1, "identity").click();
    expect([req.checked, req.disabled]).toEqual([true, false]);
    expect((hintOf(1) as HTMLElement).hidden).toBe(true);
    req.click();
    expect(req.checked).toBe(false);
    part(0, "identity").click(); // field 1 stays required whether or not it identifies a booking
    expect([part(0, "required").checked, part(0, "required").disabled]).toEqual([true, true]);
    expect(hintOf(0).textContent).toBe("The first field is always required.");
  });

  it("words the identity limit by the labels of the identity fields, joined with +, as they change", async () => {
    await start();
    typeInto(part(0, "label"), "Dog");
    expect(limitLabel()).toBe("How many bookings can one Dog make?");
    addField();
    typeInto(part(1, "label"), "Handler");
    expect(limitLabel()).toBe("How many bookings can one Dog make?");
    part(1, "identity").click();
    expect(limitLabel()).toBe("How many bookings can one Dog + Handler make?");
    typeInto(part(1, "label"), "  Owner ");
    expect(limitLabel()).toBe("How many bookings can one Dog + Owner make?");
    typeInto(part(1, "label"), "");
    expect(limitLabel()).toBe("How many bookings can one Dog + field 2 make?");
    part(0, "identity").click();
    part(1, "identity").click();
    expect(limitLabel()).toBe("How many bookings can one identity make?");
    expect($(`label[for="event-identity-limit"]`).textContent).not.toContain("undefined");
  });

  it("does not announce the identity limit's label as it changes", async () => {
    await start();
    expect($(`label[for="event-identity-limit"]`).closest("[aria-live]")).toBeNull();
  });

  it("sends the fields and the identity limit with a create, with the label trimmed and the numbers as numbers", async () => {
    const { calls } = await start();
    fill();
    typeInto(part(0, "label"), "  Dog ");
    addField();
    typeInto(part(1, "label"), "Handler");
    part(1, "identity").click();
    addField();
    typeInto(part(2, "label"), "Phone");
    typeInto(part(2, "max"), "20");
    typeInto(limit(), "3");
    submit();
    await tick();
    expect(created(calls).fields).toEqual([
      { label: "Dog", required: true, maxLength: 80, identity: true },
      { label: "Handler", required: true, maxLength: 80, identity: true },
      { label: "Phone", required: false, maxLength: 20, identity: false },
    ]);
    expect(created(calls).identityLimit).toBe(3);
  });

  it("sends a max length or limit that isn't a whole number as null, so the server's message comes back", async () => {
    const { calls } = await start();
    fill();
    typeInto(part(0, "max"), "");
    typeInto(limit(), "1.5");
    submit();
    await tick();
    expect(created(calls)).toMatchObject({ fields: [{ maxLength: null }], identityLimit: null });
  });

  it("shows the server's field errors at the right inputs, marks them invalid, and focuses the first", async () => {
    await start({
      create: () => reply(400, {
        error: { code: "invalid_input" },
        fields: { "fields.1.label": "Two fields can't have the same label.", "fields.1.maxLength": "Enter a whole number of characters from 1 to 80.", identityLimit: "Enter a whole number of bookings from 1 to 20." },
      }),
    });
    fill();
    addField();
    typeInto(part(1, "label"), "Name");
    submit();
    await tick();
    expect(errorText(part(1, "label"))).toBe("Two fields can't have the same label.");
    expect(errorText(part(1, "max"))).toBe("Enter a whole number of characters from 1 to 80.");
    expect(errorText(limit())).toBe("Enter a whole number of bookings from 1 to 20.");
    expect(part(1, "label").getAttribute("aria-invalid")).toBe("true");
    expect(part(1, "label").getAttribute("aria-describedby")).toContain(`${part(1, "label").id}-error`);
    expect(part(0, "label").hasAttribute("aria-invalid")).toBe(false);
    expect(document.activeElement).toBe(part(1, "label"));
    expect($(".form-error")!.textContent).toBe("");
    typeInto(part(1, "label"), "Phone");
    expect(errorText(part(1, "label"))).toBe("");
    expect(part(1, "label").hasAttribute("aria-invalid")).toBe(false);
    expect(errorText(part(1, "max"))).toBe("Enter a whole number of characters from 1 to 80.");
  });

  it("shows the list error (such as no identity field) at the card, focusable", async () => {
    await start({ create: () => reply(400, { error: { code: "invalid_input" }, fields: { fields: "At least one field must identify a booking." } }) });
    fill();
    part(0, "identity").click();
    submit();
    await tick();
    const message = document.getElementById("event-fields-error")!;
    expect(message.textContent).toBe("At least one field must identify a booking.");
    expect(document.activeElement).toBe(message);
    part(0, "identity").click();
    expect(message.textContent).toBe("");
  });

  it("shows the required and identity errors of a field next to those boxes", async () => {
    await start({
      create: () => reply(400, { error: { code: "invalid_input" }, fields: { "fields.0.required": "The first field must be required." } }),
    });
    fill();
    submit();
    await tick();
    expect(errorText(part(0, "required"))).toBe("The first field must be required.");
    expect(part(0, "required").getAttribute("aria-invalid")).toBe("true");
  });

  describe("templates", () => {
    const DOG_HANDLER = [
      { label: "Dog", required: true, maxLength: 60, identity: true }, { label: "Handler", required: true, maxLength: 80, identity: true },
      { label: "Phone", required: false, maxLength: 20, identity: false },
    ];
    const WITH_FORM = {
      id: 1, name: "Agility", isDefault: false, details: "", venuePostcode: "AB1 2CD", costPence: 1500, start: "09:00", end: "12:00",
      sessionMinutes: 15, gapMinutes: 5, breaks: [], shareMessage: "", fields: DOG_HANDLER, identityLimit: 2,
    };
    const PLAIN = { ...WITH_FORM, id: 2, name: "Plain", fields: undefined, identityLimit: undefined };
    const picker = () => document.getElementById("template") as HTMLSelectElement;
    const choose = (value: string) => { picker().value = value; picker().dispatchEvent(new Event("change", { bubbles: true })); };
    const originalConfirm = (document.defaultView as unknown as { confirm?: unknown }).confirm;
    afterEach(() => { (document.defaultView as unknown as { confirm?: unknown }).confirm = originalConfirm; });

    it("copies the template's fields and limit when it is the default, and sends them", async () => {
      const { calls } = await start({ templates: () => reply(200, { templates: [{ ...WITH_FORM, isDefault: true }] }) });
      await tick();
      expect(cardRows()).toHaveLength(3);
      expect(cardRows().map((_, i) => part(i, "label").value)).toEqual(["Dog", "Handler", "Phone"]);
      expect(part(0, "max").value).toBe("60");
      expect(part(2, "required").checked).toBe(false);
      expect(limit().value).toBe("2");
      expect(limitLabel()).toBe("How many bookings can one Dog + Handler make?");
      set("name", "Trial Day");
      set("date", "2026-06-13");
      submit();
      await tick();
      expect(created(calls)).toMatchObject({ fields: DOG_HANDLER, identityLimit: 2 });
    });

    it("switches between templates and No template: a template without fields, and No template, give the Name field and a limit of 1", async () => {
      await start({ templates: () => reply(200, { templates: [WITH_FORM, PLAIN] }) });
      await tick();
      choose("1");
      expect(cardRows()).toHaveLength(3);
      choose("2");
      expect(cardRows().map((_, i) => part(i, "label").value)).toEqual(["Name"]);
      expect(limit().value).toBe("1");
      choose("1");
      expect(limit().value).toBe("2");
      choose("");
      expect(cardRows().map((_, i) => part(i, "label").value)).toEqual(["Name"]);
      expect(limit().value).toBe("1");
      expect(limitLabel()).toBe("How many bookings can one Name make?");
    });

    it("counts an edit of the booking form as one a template must ask before replacing", async () => {
      const confirm = vi.fn(() => false);
      (document.defaultView as unknown as { confirm: unknown }).confirm = confirm;
      await start({ templates: () => reply(200, { templates: [WITH_FORM, PLAIN] }) });
      await tick();
      choose("1");
      expect(confirm).not.toHaveBeenCalled();
      typeInto(part(0, "label"), "Hound");
      choose("2");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(picker().value).toBe("1");
      expect(part(0, "label").value).toBe("Hound");
    });

    it("clears errors left by a rejected save when a template replaces the card", async () => {
      (document.defaultView as unknown as { confirm: unknown }).confirm = () => true;
      await start({
        templates: () => reply(200, { templates: [WITH_FORM] }),
        create: () => reply(400, { error: { code: "invalid_input" }, fields: { "fields.0.label": "Bad label." } }),
      });
      await tick();
      fill();
      submit();
      await tick();
      expect(errorText(part(0, "label"))).toBe("Bad label.");
      choose("");
      choose("1");
      expect(errorText(part(0, "label"))).toBe("");
    });
  });
});

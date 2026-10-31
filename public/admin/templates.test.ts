// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLACEHOLDERS } from "../share-message.js";
import { init, unknownPlaceholders } from "./templates.js";

const HOSTILE = "<img src=x onerror=alert(1)>";
const ORIGIN = "https://club.example";
const reply = (status: number, body: unknown = null) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const SESSION = { identity: "ann@example.com", provider: "password", csrfToken: "tok" };
const URL_BASE = "/api/admin/templates";

type Template = {
  id: number; name: string; isDefault: boolean; details: string; venuePostcode: string; costPence: number; start: string; end: string;
  sessionMinutes: number; gapMinutes: number; breaks: { start: string; end: string; label: string }[]; shareMessage: string;
  lanes?: { name: string }[]; capacity?: number;
  fields?: { label: string; required: boolean; maxLength: number; identity: boolean }[]; identityLimit?: number;
};
const SATURDAY: Template = {
  id: 1, name: "Saturday trial", isDefault: true, details: "Bring water", venuePostcode: "AB1 2CD", costPence: 1200,
  start: "09:00", end: "16:00", sessionMinutes: 20, gapMinutes: 5, breaks: [{ start: "12:00", end: "12:30", label: "Lunch" }],
  shareMessage: "Come to {event}\n{link}",
};
const EVENING: Template = {
  id: 2, name: "Evening", isDefault: false, details: "", venuePostcode: "EF3 4GH", costPence: 0,
  start: "18:00", end: "20:00", sessionMinutes: 15, gapMinutes: 0, breaks: [], shareMessage: "",
};
const many = (n: number): Template[] => Array.from({ length: n }, (_, i) => ({ ...EVENING, id: i + 1, name: `Template ${i + 1}`, isDefault: i === 0 }));

type Call = { url: string; method: string; body?: any };
/** Returns a response to override the in-memory server, or undefined to let it answer. */
type Override = (call: Call) => Response | Promise<Response> | undefined;

async function start(opts: { templates?: Template[]; override?: Override; settings?: Promise<unknown>; session?: () => Response } = {}) {
  document.body.innerHTML = '<main id="app"></main>';
  const server = { templates: structuredClone(opts.templates ?? [SATURDAY, EVENING]) as Template[] };
  const calls: Call[] = [];
  const navigate = vi.fn();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    if (url === "/api/admin/session") return opts.session ? opts.session() : reply(200, SESSION);
    calls.push(call);
    const over = opts.override?.(call);
    if (over) return over;
    if (url === URL_BASE && call.method === "GET") return reply(200, { templates: server.templates });
    if (url === URL_BASE && call.method === "POST") {
      const template = { ...call.body, id: 100 + server.templates.length, isDefault: Boolean(call.body.isDefault) };
      server.templates.push(template);
      return reply(201, { template });
    }
    const id = Number(/\/(\d+)$/.exec(url)?.[1]);
    const index = server.templates.findIndex((t) => t.id === id);
    if (call.method === "GET") return index < 0 ? reply(404, { error: { code: "not_found" } }) : reply(200, { template: server.templates[index] });
    if (call.method === "PUT") {
      if (call.body.isDefault) for (const t of server.templates) t.isDefault = false;
      server.templates[index] = { ...server.templates[index], ...call.body };
      return reply(200, { template: server.templates[index] });
    }
    if (call.method === "DELETE") {
      const [gone] = server.templates.splice(index, 1);
      return reply(200, { deleted: { id: gone.id, name: gone.name } });
    }
    throw new Error(`unexpected ${call.method} ${url}`);
  });
  await init({
    document, fetch: fetch as unknown as typeof globalThis.fetch, navigate, location: { origin: ORIGIN } as Location,
    ...(opts.settings ? { settings: opts.settings as never } : {}),
  });
  return { calls, navigate, server };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const field = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLTextAreaElement;
const set = (id: string, value: string) => {
  const el = field(id);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const button = (name: string) => $$("button").find((b) => b.textContent === name) as HTMLButtonElement;
const cardOf = (name: string) => $$(".event-card").find((c) => c.querySelector("h2")!.textContent === name)!;
const cardButton = (name: string, label: string) => [...cardOf(name).querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const submit = () => $("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const text = () => document.body.textContent ?? "";
const errorOf = (id: string) => document.getElementById(`${id}-error`)!.textContent;
const status = () => $(".list-status").textContent;
const preview = () => $("#tpl-preview").textContent;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
const fillMinimum = () => {
  set("tpl-name", "Weekday"); set("tpl-postcode", "ab1 2cd"); set("tpl-cost", "10"); set("tpl-start", "10:00");
  set("tpl-end", "12:00"); set("tpl-session", "30"); set("tpl-gap", "0");
};

afterEach(() => { document.body.innerHTML = ""; });

describe("the list", () => {
  it("shows each template with its summary, the default marked, and the right buttons", async () => {
    await start();
    expect($("h1").textContent).toBe("Templates");
    expect($$(".event-card h2").map((h) => h.textContent)).toEqual(["Saturday trial", "Evening"]);
    expect($$(".event-card .when").map((p) => p.textContent)).toEqual(["09:00–16:00, 20 min sessions, £12.00", "18:00–20:00, 15 min sessions, Free"]);
    expect($$(".badge").map((b) => b.textContent)).toEqual(["Default"]);
    expect(cardOf("Saturday trial").querySelector(".badge")).not.toBeNull();
    expect([...cardOf("Saturday trial").querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Edit", "Delete"]);
    expect([...cardOf("Evening").querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Edit", "Make default", "Delete"]);
    expect(cardButton("Evening", "Make default").getAttribute("aria-label")).toBe("Make Evening the default");
    expect(button("New template").disabled).toBe(false);
    expect($(".list-status").getAttribute("aria-live")).toBe("polite");
  });

  it("says so when there are no templates, and still offers New template", async () => {
    await start({ templates: [] });
    expect(text()).toContain("No templates yet.");
    expect($$(".event-card")).toHaveLength(0);
    expect(button("New template").disabled).toBe(false);
  });

  it("disables New template at 20 templates and says why; 19 is still allowed", async () => {
    await start({ templates: many(19) });
    expect(button("New template").disabled).toBe(false);
    expect(document.getElementById("limit-note")).toBeNull();
    await start({ templates: many(20) });
    expect(button("New template").disabled).toBe(true);
    expect(button("New template").getAttribute("aria-describedby")).toBe("limit-note");
    expect(document.getElementById("limit-note")!.textContent).toBe("You have 20 templates, which is the most there can be. Delete one to make a new one.");
  });

  it("goes to the login page without a session, and says so when the session can't be checked", async () => {
    const { navigate } = await start({ session: () => reply(401, null) });
    expect(navigate).toHaveBeenCalledWith("/admin/login");
    await start({ session: () => reply(500, null) });
    expect(text()).toContain("We couldn't check that you're signed in.");
  });

  it("goes to the login page when the list says 401", async () => {
    const { navigate } = await start({ override: () => reply(401, { error: { code: "unauthenticated" } }) });
    expect(navigate).toHaveBeenCalledWith("/admin/login");
    expect(text()).not.toContain("couldn't load");
  });

  it("shows a failure with Retry when the list can't be loaded (offline or an error), and Retry loads it", async () => {
    let fail = true;
    for (const bad of [() => Promise.reject(new TypeError("offline")), () => reply(500, null), () => reply(200, { templates: "nope" })]) {
      fail = true;
      await start({ override: (c) => (c.method === "GET" && fail ? bad() : undefined) });
      expect($(".message[role='alert']").textContent).toContain("We couldn't load your templates.");
      fail = false;
      button("Retry").click();
      await flush();
      expect($$(".event-card")).toHaveLength(2);
    }
  });
});

describe("creating", () => {
  it("opens an empty form in place of the list, with a way back", async () => {
    const { calls } = await start();
    button("New template").click();
    expect($("h1").textContent).toBe("New template");
    expect($$(".event-card")).toHaveLength(0);
    expect(field("tpl-name").value).toBe("");
    expect(field("tpl-default").checked).toBe(false);
    expect(field("tpl-default").disabled).toBe(false);
    expect($("#tpl-default-hint").textContent).not.toContain("To change the default");
    const labels = $$("label").map((l) => l.textContent);
    expect(labels).toEqual([
      "Template name", "Use as the default for new events", "Details (optional)", "Venue postcode", "Cost (£)", "Start time", "End time",
      "Session length (minutes)", "Gap between sessions (minutes)", "Label", "Required", "Identifies a booking", "Max length", "How many bookings can one Name make?",
      "Lane name (optional)", "Places per lane per time", "Share message (optional)",
    ]);
    for (const label of $$("label")) expect(document.getElementById(label.getAttribute("for")!), label.textContent!).not.toBeNull();
    expect(button("Create template")).toBeDefined();
    const back = $("a.back") as HTMLAnchorElement;
    expect(back.textContent).toBe("Back to templates");
    back.click();
    expect($("h1").textContent).toBe("Templates");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1); // going back doesn't ask again
  });

  it("creates a template with the exact JSON, then shows the refreshed list and announces it", async () => {
    const { calls } = await start({ templates: [SATURDAY] });
    button("New template").click();
    fillMinimum();
    set("tpl-details", "  Bring a towel ");
    set("tpl-cost", "£12.50");
    set("tpl-share", "  Hello {event}  ");
    button("Add break").click();
    set("tpl-break-1-start", "11:00"); set("tpl-break-1-end", "11:15"); set("tpl-break-1-label", "Tea");
    field("tpl-default").click();
    submit();
    await flush();
    expect(writes(calls)).toEqual([{
      url: URL_BASE, method: "POST",
      body: {
        name: "Weekday", details: "Bring a towel", venuePostcode: "ab1 2cd", costPence: 1250, start: "10:00", end: "12:00",
        sessionMinutes: 30, gapMinutes: 0, breaks: [{ start: "11:00", end: "11:15", label: "Tea" }], shareMessage: "Hello {event}", isDefault: true,
        fields: [{ label: "Name", required: true, maxLength: 80, identity: true }], identityLimit: 1,
      },
    }]);
    expect($("h1").textContent).toBe("Templates");
    expect($$(".event-card h2").map((h) => h.textContent)).toContain("Weekday");
    expect(status()).toBe("Created Weekday.");
    expect(document.activeElement).toBe($(".list-status"));
  });

  it("sends isDefault: false when the box is left alone, and skips break rows left completely empty", async () => {
    const { calls } = await start();
    button("New template").click();
    fillMinimum();
    button("Add break").click();
    button("Add break").click();
    set("tpl-break-2-start", "11:00"); set("tpl-break-2-end", "11:15");
    submit();
    await flush();
    expect(writes(calls)[0].body.isDefault).toBe(false);
    expect(writes(calls)[0].body.breaks).toEqual([{ start: "11:00", end: "11:15", label: "" }]);
  });

  it("rejects an unreadable cost on the page without sending anything", async () => {
    const { calls } = await start();
    button("New template").click();
    fillMinimum();
    set("tpl-cost", "twelve");
    submit();
    await flush();
    expect(writes(calls)).toHaveLength(0);
    expect(errorOf("tpl-cost")).toBe("Enter the cost in pounds, for example 12.50.");
    expect(document.activeElement).toBe(field("tpl-cost"));
    set("tpl-cost", "12");
    expect(errorOf("tpl-cost")).toBe("");
  });

  it("adds and removes break rows with numbered legends, like the event form", async () => {
    await start();
    button("New template").click();
    button("Add break").click();
    button("Add break").click();
    expect($$(".break-row legend").map((l) => l.textContent)).toEqual(["Break 1", "Break 2"]);
    expect($$(".break-row label").map((l) => l.textContent)).toEqual(["Start", "End", "Name (optional)", "Start", "End", "Name (optional)"]);
    expect(field("tpl-break-1-label").maxLength).toBe(40);
    set("tpl-break-2-start", "13:00");
    $("button[aria-label='Remove break 1']").click();
    expect($$(".break-row")).toHaveLength(1);
    expect($$(".break-row legend")[0].textContent).toBe("Break 1");
    expect(field("tpl-break-2-start").value).toBe("13:00");
    expect(document.activeElement).toBe(button("Add break"));
  });
});

describe("editing", () => {
  it("fills the form from the template, with its breaks", async () => {
    await start();
    cardButton("Evening", "Edit").click();
    expect($("h1").textContent).toBe("Edit template");
    expect(field("tpl-name").value).toBe("Evening");
    expect(field("tpl-cost").value).toBe("0");
    expect(field("tpl-start").value).toBe("18:00");
    expect(field("tpl-session").value).toBe("15");
    expect(field("tpl-default").checked).toBe(false);
    expect(button("Save changes")).toBeDefined();
    $("a.back").click();
    cardButton("Saturday trial", "Edit").click();
    expect(field("tpl-details").value).toBe("Bring water");
    expect(field("tpl-cost").value).toBe("12");
    expect(field("tpl-share").value).toBe("Come to {event}\n{link}");
    expect(field("tpl-break-1-start").value).toBe("12:00");
    expect(field("tpl-break-1-label").value).toBe("Lunch");
  });

  it("saves with a PUT of the exact JSON and shows the refreshed list", async () => {
    const { calls } = await start();
    cardButton("Evening", "Edit").click();
    set("tpl-name", "Late evening");
    set("tpl-cost", "5.5");
    field("tpl-default").click();
    submit();
    await flush();
    expect(writes(calls)).toEqual([{
      url: `${URL_BASE}/2`, method: "PUT",
      body: {
        name: "Late evening", details: "", venuePostcode: "EF3 4GH", costPence: 550, start: "18:00", end: "20:00", sessionMinutes: 15,
        gapMinutes: 0, breaks: [], shareMessage: "", isDefault: true,
      },
    }]);
    expect(status()).toBe("Saved Late evening.");
    expect($$(".badge")).toHaveLength(1);
    expect(cardOf("Late evening").querySelector(".badge")).not.toBeNull();
  });

  it("shows the current default's box ticked and disabled with the note, and sends no isDefault for it", async () => {
    const { calls } = await start();
    cardButton("Saturday trial", "Edit").click();
    expect(field("tpl-default").checked).toBe(true);
    expect(field("tpl-default").disabled).toBe(true);
    expect($("#tpl-default-hint").textContent).toBe("To change the default, make another template the default");
    set("tpl-gap", "10");
    submit();
    await flush();
    expect(writes(calls)[0].body).not.toHaveProperty("isDefault");
    expect(writes(calls)[0].body.gapMinutes).toBe(10);
  });

  it("sends isDefault: false when a non-default is saved unticked", async () => {
    const { calls } = await start();
    cardButton("Evening", "Edit").click();
    submit();
    await flush();
    expect(writes(calls)[0].body.isDefault).toBe(false);
  });
});

describe("make default", () => {
  it("sends the whole template with isDefault: true, refreshes and announces", async () => {
    const { calls } = await start();
    cardButton("Evening", "Make default").click();
    await flush();
    expect(writes(calls)).toEqual([{
      url: `${URL_BASE}/2`, method: "PUT",
      body: {
        name: "Evening", details: "", venuePostcode: "EF3 4GH", costPence: 0, start: "18:00", end: "20:00", sessionMinutes: 15,
        gapMinutes: 0, breaks: [], shareMessage: "", isDefault: true,
      },
    }]);
    expect(status()).toBe("Evening is now the default.");
    expect(cardOf("Evening").querySelector(".badge")).not.toBeNull();
    expect(cardOf("Saturday trial").querySelector(".badge")).toBeNull();
    expect($$(".badge")).toHaveLength(1);
    expect(cardButton("Saturday trial", "Make default")).toBeDefined();
  });

  it("builds the body from a fresh GET of the template, not from the list loaded earlier", async () => {
    const { calls, server } = await start();
    server.templates[1] = { ...server.templates[1], name: "Evening (edited elsewhere)", details: "New details", costPence: 500, breaks: [{ start: "19:00", end: "19:15", label: "Tea" }], shareMessage: "Hi {event}" };
    cardButton("Evening", "Make default").click();
    await flush();
    const sequence = calls.filter((c) => c.url === `${URL_BASE}/2`);
    expect(sequence.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(sequence[1].body).toEqual({
      name: "Evening (edited elsewhere)", details: "New details", venuePostcode: "EF3 4GH", costPence: 500, start: "18:00", end: "20:00",
      sessionMinutes: 15, gapMinutes: 0, breaks: [{ start: "19:00", end: "19:15", label: "Tea" }], shareMessage: "Hi {event}", isDefault: true,
    });
  });

  it("refreshes the list with the message, and sends no PUT, when the fresh GET finds the template deleted", async () => {
    const { calls, server } = await start();
    server.templates.splice(1, 1);
    cardButton("Evening", "Make default").click();
    await flush();
    expect(writes(calls)).toEqual([]);
    expect(status()).toBe("That template no longer exists. The list has been refreshed.");
    expect(cardOf("Saturday trial")).toBeDefined();
    expect($$(".event-card")).toHaveLength(1);
  });

  it("reports an offline or failed GET on the page, sends no PUT and leaves the buttons usable", async () => {
    let mode: "offline" | "failed" = "offline";
    const { calls } = await start({ override: (c) => (c.method === "GET" && c.url === `${URL_BASE}/2` ? (mode === "offline" ? Promise.reject(new TypeError("offline")) : reply(500, { error: { message: "Boom." } })) : undefined) });
    cardButton("Evening", "Make default").click();
    await flush();
    expect(status()).toBe("We couldn't reach the server. Check your connection and try again.");
    expect(cardButton("Evening", "Make default").disabled).toBe(false);
    mode = "failed";
    cardButton("Evening", "Make default").click();
    await flush();
    expect(status()).toBe("We couldn't make Evening the default. Boom.");
    expect(writes(calls)).toEqual([]);
  });

  it("reports a refusal or an offline failure on the page and leaves the buttons usable", async () => {
    let mode: "offline" | "refused" = "offline";
    await start({ override: (c) => (c.method === "PUT" ? (mode === "offline" ? Promise.reject(new TypeError("offline")) : reply(400, { error: { message: "No." } })) : undefined) });
    cardButton("Evening", "Make default").click();
    await flush();
    expect(status()).toBe("We couldn't reach the server. Check your connection and try again.");
    expect(cardButton("Evening", "Make default").disabled).toBe(false);
    mode = "refused";
    cardButton("Evening", "Make default").click();
    await flush();
    expect(status()).toBe("We couldn't make Evening the default. No.");
  });

  it("refreshes the list when the template has gone", async () => {
    await start({ override: (c) => (c.method === "PUT" ? reply(404, { error: { code: "not_found" } }) : undefined) });
    cardButton("Evening", "Make default").click();
    await flush();
    expect(status()).toBe("That template no longer exists. The list has been refreshed.");
  });
});

describe("deleting", () => {
  it("asks first, naming the template and saying events are not changed; Cancel sends nothing and returns focus", async () => {
    const { calls } = await start();
    cardButton("Evening", "Delete").click();
    const panel = $(".confirm");
    expect(panel.getAttribute("role")).toBe("group");
    expect(panel.textContent).toContain("Delete the template Evening?");
    expect(panel.textContent).toContain("Events already made from it are not changed.");
    expect(cardOf("Evening").contains(panel)).toBe(true);
    expect([...panel.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Delete template", "Cancel"]);
    expect(writes(calls)).toHaveLength(0);
    button("Cancel").click();
    expect(document.querySelector(".confirm")).toBeNull();
    expect(writes(calls)).toHaveLength(0);
    expect(document.activeElement).toBe(cardButton("Evening", "Delete"));
    expect($$(".event-card")).toHaveLength(2);
  });

  it("deletes after confirmation, refreshes the list and announces it", async () => {
    const { calls } = await start();
    cardButton("Evening", "Delete").click();
    button("Delete template").click();
    await flush();
    expect(writes(calls)).toEqual([{ url: `${URL_BASE}/2`, method: "DELETE", body: {} }]);
    expect($$(".event-card h2").map((h) => h.textContent)).toEqual(["Saturday trial"]);
    expect(status()).toBe("Deleted Evening. Events already made from it are not changed.");
  });

  it("shows a failure inside the panel and lets the admin try again; a missing template refreshes the list", async () => {
    let mode: "offline" | "error" | "gone" = "offline";
    await start({
      override: (c) => (c.method !== "DELETE" ? undefined
        : mode === "offline" ? Promise.reject(new TypeError("offline"))
        : mode === "error" ? reply(500, { error: { message: "Boom." } })
        : reply(404, { error: { code: "not_found" } })),
    });
    cardButton("Evening", "Delete").click();
    button("Delete template").click();
    await flush();
    expect($(".confirm .form-error").textContent).toBe("We couldn't reach the server. Check your connection and try again.");
    expect(button("Delete template").disabled).toBe(false);
    mode = "error";
    button("Delete template").click();
    await flush();
    expect($(".confirm .form-error").textContent).toBe("Boom.");
    mode = "gone";
    button("Delete template").click();
    await flush();
    expect(status()).toBe("That template no longer exists. The list has been refreshed.");
  });
});

describe("server field errors", () => {
  const refuse = (fields: Record<string, string>, status = 400) =>
    (c: Call) => (c.method === "POST" ? reply(status, { error: { code: "invalid_input", message: "Check the form." }, fields }) : undefined);
  const open = async (override: Override) => {
    const t = await start({ override });
    button("New template").click();
    fillMinimum();
    return t;
  };

  it("shows each field error on its field, marks it invalid and focuses the first", async () => {
    await open(refuse({
      name: "Name problem.", start: "Start problem.", sessionMinutes: "Session problem.", venuePostcode: "Postcode problem.",
      details: "Details problem.", shareMessage: "Share problem.", isDefault: "Default problem.", costPence: "Cost problem.",
      end: "End problem.", gapMinutes: "Gap problem.",
    }));
    submit();
    await flush();
    const expected: [string, string][] = [
      ["tpl-name", "Name problem."], ["tpl-start", "Start problem."], ["tpl-session", "Session problem."], ["tpl-postcode", "Postcode problem."],
      ["tpl-details", "Details problem."], ["tpl-share", "Share problem."], ["tpl-default", "Default problem."], ["tpl-cost", "Cost problem."],
      ["tpl-end", "End problem."], ["tpl-gap", "Gap problem."],
    ];
    for (const [id, message] of expected) {
      expect(errorOf(id), id).toBe(message);
      expect(field(id).getAttribute("aria-invalid"), id).toBe("true");
      expect(field(id).getAttribute("aria-describedby"), id).toContain(`${id}-error`);
    }
    expect(document.activeElement).toBe(field("tpl-name")); // first in page order
    set("tpl-name", "Weekday 2");
    expect(errorOf("tpl-name")).toBe("");
    expect(field("tpl-name").hasAttribute("aria-invalid")).toBe(false);
    expect(errorOf("tpl-start")).toBe("Start problem.");
  });

  it("maps breaks.N.* to the rows that were sent, skipping empty rows", async () => {
    await open(refuse({ "breaks.0.start": "Row start.", "breaks.0.label": "Row name.", "breaks.1.end": "Other end.", breaks: "Breaks overlap." }));
    button("Add break").click(); // row 1: left empty, so not sent
    button("Add break").click(); // row 2: sent as index 0
    button("Add break").click(); // row 3: sent as index 1
    set("tpl-break-2-start", "11:00"); set("tpl-break-2-end", "11:10");
    set("tpl-break-3-start", "11:20"); set("tpl-break-3-end", "11:30");
    submit();
    await flush();
    expect(errorOf("tpl-break-1-start")).toBe("");
    expect(errorOf("tpl-break-2-start")).toBe("Row start.");
    expect(errorOf("tpl-break-2-label")).toBe("Row name.");
    expect(errorOf("tpl-break-3-end")).toBe("Other end.");
    expect(document.getElementById("tpl-breaks-error")!.textContent).toBe("Breaks overlap.");
    expect(field("tpl-break-2-start").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field("tpl-break-2-start"));
  });

  it("puts a breaks-level error with a focusable message when no field is marked", async () => {
    await open(refuse({ breaks: "Breaks overlap." }));
    submit();
    await flush();
    expect(document.activeElement).toBe(document.getElementById("tpl-breaks-error"));
  });

  it("shows an error it can't place in the summary at the top", async () => {
    await open(refuse({ somethingNew: "Odd." }));
    submit();
    await flush();
    expect($(".form-error").textContent).toBe("Odd.");
    expect(document.activeElement).toBe($(".form-error"));
  });

  it("shows the 20-template limit, an offline failure and a missing template in the summary, with the form kept", async () => {
    let next: () => Response | Promise<Response> = () => reply(422, { error: { code: "template_limit", message: "You can have at most 20 templates. Delete one to add another." } });
    await open((c) => (c.method === "POST" ? next() : undefined));
    submit();
    await flush();
    expect($(".form-error").textContent).toBe("You can have at most 20 templates. Delete one to add another.");
    expect(field("tpl-name").value).toBe("Weekday");
    expect(button("Create template").disabled).toBe(false);
    next = () => Promise.reject(new TypeError("offline"));
    submit();
    await flush();
    expect($(".form-error").textContent).toBe("We couldn't reach the server. Check your connection and try again.");
    next = () => reply(404, { error: { code: "not_found" } });
    submit();
    await flush();
    expect($(".form-error").textContent).toContain("no longer exists");
  });

  it("goes to the login page on 401 and keeps quiet", async () => {
    const { navigate } = await open((c) => (c.method === "POST" ? reply(401, { error: { code: "unauthenticated" } }) : undefined));
    submit();
    await flush();
    expect(navigate).toHaveBeenCalledWith("/admin/login");
    expect($(".form-error").textContent).toBe("");
  });

  it("sends one request at a time", async () => {
    const { calls } = await start();
    button("New template").click();
    fillMinimum();
    submit();
    submit();
    await flush();
    expect(writes(calls)).toHaveLength(1);
  });
});

describe("the share message section", () => {
  const open = async (opts = {}) => {
    const t = await start(opts);
    button("New template").click();
    return t;
  };

  it("explains placeholders with a definition list of every one, and the two rules", async () => {
    await open();
    const dl = $("dl");
    expect([...dl.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(PLACEHOLDERS.map((p) => p.token));
    expect([...dl.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(PLACEHOLDERS.map((p) => p.meaning));
    expect(text()).toContain("A placeholder that isn't in this list is left exactly as you typed it.");
    expect(text()).toContain("If you leave out {link}, the booking link is added as the last line.");
    expect(field("tpl-share").maxLength).toBe(1000);
  });

  it("falls back to the example times for a time the server would refuse, instead of throwing", async () => {
    await open();
    set("tpl-start", "99:99");
    set("tpl-end", "24:00");
    expect(preview().split("\n")[1]).toBe("Saturday 16 January 2027, 09:00–16:00");
    set("tpl-start", "10:30");
    set("tpl-end", "23:59");
    expect(preview().split("\n")[1]).toBe("Saturday 16 January 2027, 10:30–23:59");
  });

  it("shows a plain message when the preview can't be built, and recovers", async () => {
    await open();
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementationOnce(() => { throw new RangeError("boom"); });
    set("tpl-details", "x");
    expect(preview()).toBe("The preview couldn't be built.");
    vi.restoreAllMocks();
    set("tpl-details", "y");
    expect(preview()).toContain("Spring Scent Trial");
  });

  it("sanitises the typed details like the shared message does", async () => {
    await open();
    set("tpl-share", "{details}");
    set("tpl-details", "a\u202Eb");
    expect(preview().split("\n")[0]).toBe("ab");
  });

  it("previews the built-in message while the box is blank, and says so", async () => {
    await open();
    expect(preview()).toBe("Spring Scent Trial\nSaturday 16 January 2027, 09:00–16:00\nVenue: AB1 2CD\nCost: £12.00\nBook your slot:\nhttps://club.example/e/example");
    expect($("#tpl-preview-note").textContent).toContain("blank, so the preview shows the built-in message");
    set("tpl-share", "Hi");
    expect($("#tpl-preview-note").textContent).toBe("");
  });

  it("updates as you type, from the form's own values and the sample event", async () => {
    await open();
    set("tpl-start", "18:00"); set("tpl-end", "20:30"); set("tpl-cost", "7.5"); set("tpl-postcode", "  EF3 4GH "); set("tpl-details", "Bring a towel");
    set("tpl-share", "{event} on {date}, {start}-{end}\n{cost} at {postcode}\n{details}\n{link}");
    expect(preview()).toBe([
      "Spring Scent Trial on Saturday 16 January 2027, 18:00-20:30", "£7.50 at EF3 4GH", "Bring a towel", "https://club.example/e/example",
    ].join("\n"));
    set("tpl-share", "Now: {event}");
    expect(preview()).toBe("Now: Spring Scent Trial\nhttps://club.example/e/example");
  });

  it("shows Free for a cost of 0, and examples for blank or unreadable fields", async () => {
    await open();
    set("tpl-share", "{cost}|{start}|{end}|{postcode}");
    expect(preview().split("\n")[0]).toBe("£12.00|09:00|16:00|AB1 2CD");
    set("tpl-cost", "0");
    expect(preview().split("\n")[0]).toBe("Free|09:00|16:00|AB1 2CD");
    set("tpl-cost", "abc");
    expect(preview().split("\n")[0]).toBe("£12.00|09:00|16:00|AB1 2CD");
  });

  it("uses the club name once the settings arrive, and drops the line while there is none", async () => {
    let resolve!: (v: unknown) => void;
    const settings = new Promise((r) => { resolve = r; });
    await open({ settings });
    set("tpl-share", "{club}\n{event}");
    expect(preview()).toBe("Spring Scent Trial\nhttps://club.example/e/example");
    resolve({ loaded: true, clubName: "Barkside Agility" });
    await flush();
    expect(preview()).toBe("Barkside Agility\nSpring Scent Trial\nhttps://club.example/e/example");
  });

  it("adds the link as the last line when {link} is missing, and not twice when it is there", async () => {
    await open();
    set("tpl-share", "Book {event}");
    expect(preview().split("\n").at(-1)).toBe("https://club.example/e/example");
    set("tpl-share", "{link}\nBook {event}");
    expect(preview()).toBe("https://club.example/e/example\nBook Spring Scent Trial");
  });

  it("lists unknown placeholders as typed, and nothing when there are none", async () => {
    await open();
    expect($("#tpl-unknown").textContent).toBe("");
    expect($("#tpl-unknown").getAttribute("aria-live")).toBe("polite");
    set("tpl-share", "{event} {foo} {Event} {foo} {link}");
    expect($("#tpl-unknown").textContent).toBe("These will appear as typed: {foo}, {Event}");
    expect(preview()).toBe("Spring Scent Trial {foo} {Event} {foo} https://club.example/e/example");
    set("tpl-share", "{event}");
    expect($("#tpl-unknown").textContent).toBe("");
  });

  it("keeps values that look like placeholders or replacement patterns literal", async () => {
    await open();
    set("tpl-details", "{link} and $& and $1 and {event}");
    set("tpl-postcode", "$& {details}");
    set("tpl-share", "{details}|{postcode}");
    expect(preview()).toBe("{link} and $& and $1 and {event}|$& {details}\nhttps://club.example/e/example");
  });

  it("previews an existing template's message when editing", async () => {
    await start();
    cardButton("Saturday trial", "Edit").click();
    expect(preview()).toBe("Come to Spring Scent Trial\nhttps://club.example/e/example");
  });
});

describe("hostile text", () => {
  const HOSTILE_TEMPLATE: Template = {
    ...SATURDAY, name: HOSTILE, details: HOSTILE, venuePostcode: HOSTILE, shareMessage: HOSTILE,
    breaks: [{ start: "12:00", end: "12:30", label: HOSTILE.slice(0, 40) }],
  };
  const noElements = () => expect(document.querySelector("img, [onerror]")).toBeNull();

  it("shows a template's name as text in the list, the panels and the buttons' labels", async () => {
    await start({ templates: [HOSTILE_TEMPLATE, EVENING] });
    noElements();
    expect($(".event-card h2").textContent).toBe(HOSTILE);
    $$(".event-card")[0].querySelector<HTMLButtonElement>("button[aria-label^='Delete']")!.click();
    expect($(".confirm strong").textContent).toBe(HOSTILE);
    noElements();
  });

  it("keeps a template's fields and its message preview as text in the form", async () => {
    await start({ templates: [HOSTILE_TEMPLATE, EVENING] });
    cardButton(HOSTILE, "Edit").click();
    noElements();
    expect(field("tpl-name").value).toBe(HOSTILE);
    expect(field("tpl-details").value).toBe(HOSTILE);
    expect(field("tpl-share").value).toBe(HOSTILE);
    expect(preview()).toBe(`${HOSTILE}\nhttps://club.example/e/example`);
    set("tpl-share", `${HOSTILE}{details}`);
    expect(preview()).toBe(`${HOSTILE}${HOSTILE}\nhttps://club.example/e/example`);
    expect($("#tpl-unknown").textContent).toBe("");
    noElements();
  });

  it("creates a template with hostile text and shows the refreshed list without any element made from it", async () => {
    const { calls } = await start({ templates: [] });
    button("New template").click();
    fillMinimum();
    set("tpl-name", HOSTILE); set("tpl-details", HOSTILE); set("tpl-share", HOSTILE);
    submit();
    await flush();
    expect(writes(calls)[0].body).toMatchObject({ name: HOSTILE, details: HOSTILE, shareMessage: HOSTILE });
    expect($(".event-card h2").textContent).toBe(HOSTILE);
    expect(status()).toBe(`Created ${HOSTILE}.`);
    noElements();
  });

  it("shows a server's error text as text", async () => {
    await start({ templates: [], override: (c) => (c.method === "POST" ? reply(400, { error: { message: HOSTILE }, fields: { name: HOSTILE, nope: HOSTILE } }) : undefined) });
    button("New template").click();
    fillMinimum();
    submit();
    await flush();
    expect(errorOf("tpl-name")).toBe(HOSTILE);
    noElements();
  });

  it("builds nothing from HTML: the module never uses innerHTML or insertAdjacentHTML", () => {
    const source = readFileSync(join(import.meta.dirname, "templates.js"), "utf8");
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe("unknownPlaceholders", () => {
  it("returns each unknown word once, in order, and ignores known ones and braces without a word", () => {
    expect(unknownPlaceholders("{event} {foo} {bar} {foo} {link} {} { x } {{baz}}")).toEqual(["{foo}", "{bar}", "{baz}"]);
    expect(unknownPlaceholders("plain")).toEqual([]);
  });
});

describe("lanes and places", () => {
  const RINGS: Template = { ...EVENING, id: 3, name: "Rings", lanes: [{ name: "Ring 1" }, { name: "Ring 2" }, { name: "Ring 3" }], capacity: 2 };
  const laneInputs = () => $$(".lane-row input") as HTMLInputElement[];
  const laneName = (n: number, value: string) => {
    laneInputs()[n].value = value;
    laneInputs()[n].dispatchEvent(new Event("input", { bubbles: true }));
  };
  const removeButton = (n: number) => $(`button[aria-label='Remove lane ${n}']`) as HTMLButtonElement;
  const edit = (name: string) => { cardButton(name, "Edit").click(); };

  describe("the list", () => {
    it("summarises a template that isn't one lane with one place, and says nothing for the default layout", async () => {
      await start({ templates: [SATURDAY, RINGS, { ...EVENING, id: 4, name: "Wide", lanes: [{ name: "" }], capacity: 3 }, { ...EVENING, id: 5, name: "Long", lanes: [{ name: "A" }, { name: "B" }], capacity: 1 }, { ...EVENING, id: 6, name: "Plain", lanes: [{ name: "" }], capacity: 1 }] });
      const line = (name: string) => cardOf(name).querySelector(".note")?.textContent ?? null;
      expect(line("Saturday trial")).toBeNull();
      expect(line("Plain")).toBeNull();
      expect(line("Rings")).toBe("3 lanes × 2 places");
      expect(line("Wide")).toBe("1 lane × 3 places");
      expect(line("Long")).toBe("2 lanes × 1 place");
    });

    it("passes the lanes and places through when making a template the default", async () => {
      const { calls } = await start({ templates: [SATURDAY, RINGS] });
      cardButton("Rings", "Make default").click();
      await flush();
      expect(writes(calls)[0].body).toMatchObject({ lanes: [{ name: "Ring 1" }, { name: "Ring 2" }, { name: "Ring 3" }], capacity: 2, isDefault: true });
    });
  });

  describe("the form", () => {
    it("starts a new template with one lane, optional name, a hint, no Remove, and one place", async () => {
      await start();
      button("New template").click();
      expect(laneInputs()).toHaveLength(1);
      expect($(".lane-row label").textContent).toBe("Lane name (optional)");
      expect(document.getElementById(`${laneInputs()[0].id}-hint`)!.hidden).toBe(false);
      expect(removeButton(1).hidden).toBe(true);
      expect(field("tpl-capacity").value).toBe("1");
      expect($("label[for='tpl-capacity']").textContent).toBe("Places per lane per time");
      expect(field("tpl-capacity").getAttribute("aria-describedby")).toBe("tpl-capacity-hint tpl-capacity-error");
    });

    it("adds and removes lanes like the event form does, and the last one can't be removed", async () => {
      await start();
      button("New template").click();
      button("Add lane").click();
      expect(document.activeElement).toBe(laneInputs()[1]);
      expect($$(".lane-row label").map((l) => l.textContent)).toEqual(["Name", "Name"]);
      expect($$(".lane-row legend").map((l) => l.textContent)).toEqual(["Lane 1", "Lane 2"]);
      expect(laneInputs().map((i) => i.required)).toEqual([true, true]);
      expect(removeButton(1).hidden).toBe(false);
      removeButton(1).click();
      expect(laneInputs()).toHaveLength(1);
      expect($(".lane-row label").textContent).toBe("Lane name (optional)");
      expect(removeButton(1).hidden).toBe(true);
      expect(document.activeElement).toBe(button("Add lane"));
      for (let i = 0; i < 9; i++) button("Add lane").click();
      expect(button("Add lane").disabled).toBe(true);
    });

    it("loads a template's lanes and places for editing, and an old one as one unnamed lane with one place", async () => {
      await start({ templates: [RINGS, SATURDAY] });
      edit("Rings");
      expect(laneInputs().map((i) => i.value)).toEqual(["Ring 1", "Ring 2", "Ring 3"]);
      expect(field("tpl-capacity").value).toBe("2");
      ($("a.back") as HTMLElement).click();
      edit("Saturday trial");
      expect(laneInputs().map((i) => i.value)).toEqual([""]);
      expect(field("tpl-capacity").value).toBe("1");
    });

    it("creates with lanes (names only, trimmed, in order) and places", async () => {
      const { calls, server } = await start();
      button("New template").click();
      fillMinimum();
      button("Add lane").click();
      button("Add lane").click();
      laneName(0, " Ring 1 ");
      laneName(1, "Ring 2");
      laneName(2, "Ring 3");
      set("tpl-capacity", "2");
      submit();
      await flush();
      expect(writes(calls)[0].body).toMatchObject({ lanes: [{ name: "Ring 1" }, { name: "Ring 2" }, { name: "Ring 3" }], capacity: 2 });
      expect(server.templates.at(-1)!.lanes).toEqual([{ name: "Ring 1" }, { name: "Ring 2" }, { name: "Ring 3" }]);
      expect(status()).toBe("Created Weekday.");
      expect(cardOf("Weekday").querySelector(".note")!.textContent).toBe("3 lanes × 2 places");
    });

    it("leaves lanes and places out when they are one unnamed lane and one place, and sends only what changed on an edit", async () => {
      const { calls } = await start({ templates: [RINGS, SATURDAY] });
      button("New template").click();
      fillMinimum();
      submit();
      await flush();
      expect(writes(calls)[0].body).not.toHaveProperty("lanes");
      expect(writes(calls)[0].body).not.toHaveProperty("capacity");
      edit("Rings");
      set("tpl-name", "Rings, renamed");
      submit();
      await flush();
      expect(writes(calls)[1].body).not.toHaveProperty("lanes");
      expect(writes(calls)[1].body).not.toHaveProperty("capacity");
      edit("Rings, renamed");
      laneName(1, "Paddock");
      set("tpl-capacity", "4");
      submit();
      await flush();
      expect(writes(calls)[2].body).toMatchObject({ lanes: [{ name: "Ring 1" }, { name: "Paddock" }, { name: "Ring 3" }], capacity: 4 });
    });

    it("sends an unreadable number of places as null, so the server's message shows against that field", async () => {
      const { calls } = await start({
        override: (c) => (c.method === "POST" ? reply(400, { error: { code: "invalid_input" }, fields: { capacity: "Enter a whole number of places from 1 to 50." } }) : undefined),
      });
      button("New template").click();
      fillMinimum();
      set("tpl-capacity", "");
      submit();
      await flush();
      expect(writes(calls)[0].body.capacity).toBeNull();
      expect(errorOf("tpl-capacity")).toBe("Enter a whole number of places from 1 to 50.");
      expect(field("tpl-capacity").getAttribute("aria-invalid")).toBe("true");
      expect(document.activeElement).toBe(field("tpl-capacity"));
      set("tpl-capacity", "2");
      expect(errorOf("tpl-capacity")).toBe("");
    });

    it("maps lanes.N.name onto lane N, and the list-level messages under the lanes", async () => {
      await start({
        override: (c) => (c.method === "POST"
          ? reply(400, { error: { code: "invalid_input" }, fields: { "lanes.1.name": "Two lanes can't have the same name.", "lanes.0.name": "Each lane needs a name." } })
          : undefined),
      });
      button("New template").click();
      fillMinimum();
      button("Add lane").click();
      laneName(1, "Same");
      submit();
      await flush();
      const [first, second] = laneInputs();
      expect(errorOf(first.id)).toBe("Each lane needs a name.");
      expect(errorOf(second.id)).toBe("Two lanes can't have the same name.");
      expect([first.getAttribute("aria-invalid"), second.getAttribute("aria-invalid")]).toEqual(["true", "true"]);
      expect(document.activeElement).toBe(first);
      laneName(0, "Other");
      expect(errorOf(first.id)).toBe("");
    });

    it("shows a lanes list error under the lanes, and clears it when a lane is added", async () => {
      await start({ override: (c) => (c.method === "POST" ? reply(400, { error: { code: "invalid_input" }, fields: { lanes: "You can have at most 10 lanes." } }) : undefined) });
      button("New template").click();
      fillMinimum();
      submit();
      await flush();
      expect(errorOf("tpl-lanes")).toBe("You can have at most 10 lanes.");
      expect($("#tpl-summary, .form-error").textContent).toBe("");
      button("Add lane").click();
      expect(errorOf("tpl-lanes")).toBe("");
    });

    it("fills {lanes} in the share preview from the lanes typed, and drops the line for one unnamed lane", async () => {
      await start();
      button("New template").click();
      set("tpl-share", "{lanes}\n{link}");
      expect(preview()).toBe("https://club.example/e/example");
      button("Add lane").click();
      laneName(0, "Ring 1");
      laneName(1, "Ring 2");
      expect(preview()).toBe("Ring 1, Ring 2\nhttps://club.example/e/example");
      removeButton(2).click();
      expect(preview()).toBe("Ring 1\nhttps://club.example/e/example");
    });
  });
});

describe("booking form", () => {
  const FORM = [
    { label: "Dog", required: true, maxLength: 60, identity: true }, { label: "Handler", required: true, maxLength: 80, identity: true },
    { label: "Phone", required: false, maxLength: 20, identity: false },
  ];
  const AGILITY: Template = { ...EVENING, id: 3, name: "Agility", fields: FORM, identityLimit: 2 };
  const cardRows = () => $$(".field-def");
  const part = (row: number, what: "label" | "required" | "max" | "identity") => cardRows()[row].querySelector(`[id$="-${what}"]`) as HTMLInputElement;
  const typeInto = (el: HTMLInputElement, value: string) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); };
  const limit = () => field("tpl-identity-limit");
  const errorText = (el: HTMLElement) => document.getElementById(`${el.id}-error`)!.textContent;

  describe("the list", () => {
    it("summarises the fields of a template whose form isn't the default Name, and says nothing otherwise", async () => {
      await start({ templates: [SATURDAY, AGILITY, { ...EVENING, id: 4, name: "Named", fields: [FORM[0]] }, { ...EVENING, id: 5, name: "Plain", fields: [{ label: "Name", required: true, maxLength: 80, identity: true }] }] });
      const note = (name: string) => [...cardOf(name).querySelectorAll(".note")].map((n) => n.textContent);
      expect(note("Saturday trial")).toEqual([]);
      expect(note("Agility")).toEqual(["Fields: Dog, Handler, Phone"]);
      expect(note("Named")).toEqual(["Fields: Dog"]);
      expect(note("Plain")).toEqual([]);
    });

    it("passes the fields and the limit through when making a template the default", async () => {
      const { calls } = await start({ templates: [SATURDAY, AGILITY] });
      cardButton("Agility", "Make default").click();
      await flush();
      expect(writes(calls)[0].body).toMatchObject({ fields: FORM, identityLimit: 2, isDefault: true });
    });
  });

  describe("the form", () => {
    it("starts a new template with the one required Name field that identifies a booking, and a limit of 1", async () => {
      await start();
      button("New template").click();
      expect($(".fields-group legend")!.textContent).toBe("Booking form");
      expect(cardRows()).toHaveLength(1);
      expect([part(0, "label").value, part(0, "required").checked, part(0, "required").disabled, part(0, "identity").checked, part(0, "max").value]).toEqual(["Name", true, true, true, "80"]);
      expect(limit().value).toBe("1");
      expect($("label[for='tpl-identity-limit']").textContent).toBe("How many bookings can one Name make?");
    });

    it("adds up to four fields, removes them, forces Required, and words the limit by the identity labels", async () => {
      await start();
      button("New template").click();
      typeInto(part(0, "label"), "Dog");
      button("Add field").click();
      expect(document.activeElement).toBe(part(1, "label"));
      typeInto(part(1, "label"), "Handler");
      part(1, "identity").click();
      expect([part(1, "required").checked, part(1, "required").disabled]).toEqual([true, true]);
      expect($("label[for='tpl-identity-limit']").textContent).toBe("How many bookings can one Dog + Handler make?");
      button("Add field").click();
      button("Add field").click();
      expect(cardRows()).toHaveLength(4);
      expect(button("Add field").disabled).toBe(true);
      ($("button[aria-label='Remove field 4']") as HTMLButtonElement).click();
      expect(button("Add field").disabled).toBe(false);
      expect(document.activeElement).toBe(button("Add field"));
    });

    it("loads a template's fields and limit for editing, and an old one as the Name field", async () => {
      await start({ templates: [AGILITY, SATURDAY] });
      cardButton("Agility", "Edit").click();
      expect(cardRows().map((_, i) => part(i, "label").value)).toEqual(["Dog", "Handler", "Phone"]);
      expect(part(0, "max").value).toBe("60");
      expect(part(2, "required").checked).toBe(false);
      expect(limit().value).toBe("2");
      expect(document.getElementById("tpl-fields-locked")!.hidden).toBe(true);
      expect(button("Add field").disabled).toBe(false);
      ($("a.back") as HTMLElement).click();
      cardButton("Saturday trial", "Edit").click();
      expect(cardRows().map((_, i) => part(i, "label").value)).toEqual(["Name"]);
      expect(limit().value).toBe("1");
    });

    it("sends the fields and the limit with a create", async () => {
      const { calls } = await start({ templates: [SATURDAY] });
      button("New template").click();
      fillMinimum();
      typeInto(part(0, "label"), "Rider");
      button("Add field").click();
      typeInto(part(1, "label"), "Pony");
      part(1, "identity").click();
      typeInto(limit(), "2");
      submit();
      await flush();
      expect(writes(calls)[0].body).toMatchObject({
        fields: [{ label: "Rider", required: true, maxLength: 80, identity: true }, { label: "Pony", required: true, maxLength: 80, identity: true }], identityLimit: 2,
      });
    });

    it("leaves the fields and the limit out of an edit that didn't change them, and sends what changed", async () => {
      const { calls } = await start({ templates: [AGILITY, SATURDAY] });
      cardButton("Agility", "Edit").click();
      set("tpl-name", "Agility 2");
      submit();
      await flush();
      expect(writes(calls)[0].body).not.toHaveProperty("fields");
      expect(writes(calls)[0].body).not.toHaveProperty("identityLimit");
      cardButton("Agility 2", "Edit").click();
      typeInto(part(2, "label"), "Mobile");
      submit();
      await flush();
      expect(writes(calls)[1].body.fields).toEqual([FORM[0], FORM[1], { ...FORM[2], label: "Mobile" }]);
      expect(writes(calls)[1].body).not.toHaveProperty("identityLimit");
      cardButton("Agility 2", "Edit").click();
      typeInto(limit(), "5");
      submit();
      await flush();
      expect(writes(calls)[2].body.identityLimit).toBe(5);
      expect(writes(calls)[2].body).not.toHaveProperty("fields");
    });

    it("maps the server's field errors onto the card's inputs, focusing the first", async () => {
      await start({
        override: (c) => (c.method === "POST"
          ? reply(400, { error: { code: "invalid_input" }, fields: { "fields.0.label": "Enter the field label.", "fields.1.maxLength": "Enter a whole number of characters from 1 to 80.", identityLimit: "Enter a whole number of bookings from 1 to 20." } })
          : undefined),
      });
      button("New template").click();
      fillMinimum();
      button("Add field").click();
      submit();
      await flush();
      expect(errorText(part(0, "label"))).toBe("Enter the field label.");
      expect(errorText(part(1, "max"))).toBe("Enter a whole number of characters from 1 to 80.");
      expect(errorText(limit())).toBe("Enter a whole number of bookings from 1 to 20.");
      expect(part(0, "label").getAttribute("aria-invalid")).toBe("true");
      expect(document.activeElement).toBe(part(0, "label"));
      expect($(".form-error")!.textContent).toBe("");
    });

    it("shows a list-level card error (no identity field) at the card and focuses it", async () => {
      await start({ override: (c) => (c.method === "POST" ? reply(400, { error: { code: "invalid_input" }, fields: { fields: "At least one field must identify a booking." } }) : undefined) });
      button("New template").click();
      fillMinimum();
      part(0, "identity").click();
      submit();
      await flush();
      expect(document.getElementById("tpl-fields-error")!.textContent).toBe("At least one field must identify a booking.");
      expect(document.activeElement).toBe(document.getElementById("tpl-fields-error"));
    });
  });
});

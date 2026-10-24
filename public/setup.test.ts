// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trimAdminSecret as loginTrim } from "./admin/login.js";
import { init, trimAdminSecret } from "./setup.js";

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const SECRET = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw";
const RECOVERY = "Q7mT2vLx9RkWc4HnYp8aBd3sFgJu6ZeNiOo1VtXyM0w";
const issued = () => reply(200, { secret: SECRET, recoveryCode: RECOVERY });

type Call = { url: string; init?: RequestInit };
type Clipboard = { writeText: (text: string) => Promise<void> };

/**
 * Loads the real setup.html body, then starts the page with a scripted fetch. `handler` answers the POSTs and `state`
 * answers the GET /api/setup the page makes first; `calls` holds the POSTs and `gets` the GETs.
 */
async function start(handler: (call: Call) => Response | Promise<Response> = issued, clipboard?: Clipboard, navigate: (url: string) => void = () => {}, state: () => Response | Promise<Response> = () => reply(200, { state: "code" })) {
  const html = readFileSync("public/setup.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
  const calls: Call[] = [];
  const gets: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      calls.push({ url, init });
      return handler({ url, init });
    }
    gets.push({ url, init });
    return state();
  });
  await init({ document, fetch: fetch as unknown as typeof globalThis.fetch, navigator: { clipboard }, navigate });
  return { calls, gets };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const code = () => $("#code") as HTMLInputElement;
const button = () => $("#setup-form button") as HTMLButtonElement;
const error = () => $("#setup-error");
const saved = () => $("#saved") as HTMLInputElement;
const signIn = () => $("#sign-in") as HTMLButtonElement;
const claim = () => $("#claim") as HTMLButtonElement;
const visible = () => ["#setup-form", "#claim-step", "#taken-step", "#secret-step"].filter((sel) => !$(sel).hidden);
const hint = () => $("#sign-in-hint");
const submit = async (value: string) => {
  code().value = value;
  $("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(button().disabled).toBe(false)); // disabled synchronously, re-enabled when settled
};
const submitOk = async () => {
  code().value = "club-setup-phrase";
  $("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect($("#secret-step").hidden).toBe(false));
};

afterEach(() => { document.body.innerHTML = ""; localStorage.clear(); sessionStorage.clear(); });

describe("setup page markup", () => {
  const html = readFileSync("public/setup.html", "utf8");
  it("is British English, mobile-friendly, noindex, and has no inline script or style", () => {
    expect(html).toContain('<html lang="en-GB">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain('<script type="module" src="/setup.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/<style|style=|\son[a-z]+=/i);
    expect(html).not.toMatch(/action=/);
  });
  it("has no novalidate-less form: the page shows its own 'Enter the setup code.' rather than the browser's bubble", () => {
    expect(html).toMatch(/<form[^>]*id="setup-form"[^>]*\bnovalidate\b/);
    expect(html).toMatch(/<input[^>]*id="code"[^>]*\brequired\b/);
  });
  it("has the secret step's heading focusable by script, and a real disabled button (not a link without an address) for going on to sign in", () => {
    expect(html).toMatch(/<h2[^>]*id="secret-heading"[^>]*tabindex="-1"[^>]*>Your admin secret and recovery code<\/h2>/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*id="sign-in"[^>]*\bdisabled\b[^>]*>Go to sign in<\/button>|<button[^>]*id="sign-in"[^>]*type="button"[^>]*\bdisabled\b[^>]*>Go to sign in<\/button>/);
    expect(html).toContain('aria-describedby="sign-in-hint"');
    expect(html).toMatch(/id="sign-in-hint"[^>]*>Tick the box first\.<\/p>/);
    expect(html).not.toMatch(/<a[^>]*id="sign-in"/);
  });
  it("shares the theme, styles and icons of the other pages", () => {
    expect(html).toContain('<link rel="stylesheet" href="/style.css" />');
    expect(html).toContain('<link rel="stylesheet" href="/api/theme.css" />');
    expect(html).toContain('href="/api/icon/32"');
  });
  it("has one code field with autocomplete off, its label, an alert region, a Continue button, and every step hidden until the page knows which to show", () => {
    expect(html.match(/<input/g)).toHaveLength(2); // the code, and the "I've saved both" checkbox
    expect(html).toMatch(/<input[^>]*id="code"[^>]*autocomplete="off"|<input[^>]*autocomplete="off"[^>]*id="code"/);
    expect(html).toContain('<label for="code">Setup code</label>');
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button[^>]*>Continue<\/button>/);
    expect(html).toContain("Both are shown only this once");
    expect(html).toContain("If you run setup again before you first sign in, both are replaced");
    for (const id of ["setup-form", "claim-step", "taken-step", "secret-step"]) expect(html).toMatch(new RegExp(`id="${id}"[^>]*\\bhidden\\b`));
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(RECOVERY);
  });
});

describe("setup page, choosing the step", () => {
  it("asks /api/setup once, with a plain GET, and shows nothing until it answers", async () => {
    let answer!: () => void;
    const pending = new Promise<Response>((resolve) => { answer = () => resolve(reply(200, { state: "code" })); });
    const html = readFileSync("public/setup.html", "utf8");
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
    const fetch = vi.fn(async () => pending);
    const loaded = init({ document, fetch: fetch as unknown as typeof globalThis.fetch, navigator: {} as Navigator, navigate: () => {} });
    expect(visible()).toEqual([]);
    answer();
    await loaded;
    expect(visible()).toEqual(["#setup-form"]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/setup", { credentials: "same-origin", cache: "no-store" });
  });

  it("state code shows the form only, and posts nothing yet", async () => {
    const { calls, gets } = await start();
    expect(gets).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(visible()).toEqual(["#setup-form"]);
    expect($("#secret").textContent).toBe("");
    expect(signIn().disabled).toBe(true);
  });

  it("state claim shows the claim step only, with the design's sentence and a button that has not been pressed", async () => {
    const { calls } = await start(undefined, undefined, undefined, () => reply(200, { state: "claim" }));
    expect(visible()).toEqual(["#claim-step"]);
    expect($("#claim-step").textContent).toContain("This site has no admin yet. Press the button to make your admin secret and a recovery code. Both are shown once. Save both in a password manager before you leave this page.");
    expect(claim().textContent).toBe("Create my admin secret");
    expect(calls).toEqual([]);
  });

  it("state reissue shows the claim step, with a button that offers a new secret", async () => {
    await start(undefined, undefined, undefined, () => reply(200, { state: "reissue" }));
    expect(visible()).toEqual(["#claim-step"]);
    expect(claim().textContent).toBe("Show me a new secret");
    expect($("#claim-step").textContent).toContain("Both are shown once");
    expect($("#claim-step").textContent).not.toContain("This site has no admin yet");
  });

  it("state taken shows the sign-in link only", async () => {
    await start(undefined, undefined, undefined, () => reply(200, { state: "taken" }));
    expect(visible()).toEqual(["#taken-step"]);
    expect($("#taken-step").textContent).toContain("This site has already been set up");
    const link = $("#taken-step a");
    expect(link.getAttribute("href")).toBe("/admin/login");
    expect(link.textContent).toBe("Sign in");
  });

  it("explains a closed setup, shows the server's message when it isn't ready, and a generic one for anything else", async () => {
    await start(undefined, undefined, undefined, () => reply(404, { error: { code: "not_found", message: "Not found." } }));
    expect(visible()).toEqual([]);
    expect($("#page-error").textContent).toBe("Setup has already been completed. Sign in instead.");
    expect($("#page-error a").getAttribute("href")).toBe("/admin/login");
    await start(undefined, undefined, undefined, () => reply(503, { error: { code: "setup_not_ready", message: "Setup is closed. The first-run window ended." } }));
    expect(visible()).toEqual([]);
    expect($("#page-error").textContent).toBe("Setup is closed. The first-run window ended.");
    await start(undefined, undefined, undefined, () => { throw new TypeError("Failed to fetch"); });
    expect($("#page-error").textContent).toBe("Something went wrong. Please try again.");
    await start(undefined, undefined, undefined, () => new Response("<html>oops</html>", { status: 500 }));
    expect($("#page-error").textContent).toBe("Something went wrong. Please try again.");
    await start(undefined, undefined, undefined, () => reply(200, { state: "something-new" }));
    expect($("#page-error").textContent).toBe("Something went wrong. Please try again.");
    expect(visible()).toEqual([]);
  });
});

describe("setup page, the claim", () => {
  const claimState = () => reply(200, { state: "claim" });
  const press = () => claim().click();

  it("posts the JSON {} to /api/setup, same-origin and uncached, and shows both values", async () => {
    const { calls } = await start(undefined, undefined, undefined, claimState);
    press();
    await vi.waitFor(() => expect($("#secret-step").hidden).toBe(false));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/setup");
    expect(calls[0].init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({});
    expect(visible()).toEqual(["#secret-step"]);
    expect($("#secret").textContent).toBe(SECRET);
    expect($("#recovery").textContent).toBe(RECOVERY);
    expect(document.activeElement).toBe($("#secret-heading"));
  });

  it("works the same from the reissue state", async () => {
    const { calls } = await start(undefined, undefined, undefined, () => reply(200, { state: "reissue" }));
    press();
    await vi.waitFor(() => expect($("#secret-step").hidden).toBe(false));
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({});
    expect($("#recovery").textContent).toBe(RECOVERY);
  });

  it("ignores a second press while the first is in flight", async () => {
    let release!: () => void;
    const { calls } = await start(() => new Promise<Response>((resolve) => { release = () => resolve(issued()); }), undefined, undefined, claimState);
    press();
    press();
    expect(calls).toHaveLength(1);
    expect(claim().disabled).toBe(true);
    release();
    await vi.waitFor(() => expect($("#secret-step").hidden).toBe(false));
    expect(calls).toHaveLength(1);
  });

  it("shows the taken step on a 409, and the closed text with the sign-in link on a 404", async () => {
    await start(() => reply(409, { error: { code: "conflict", message: "Already set up." } }), undefined, undefined, claimState);
    press();
    await vi.waitFor(() => expect(visible()).toEqual(["#taken-step"]));
    await start(() => reply(404, { error: { code: "not_found", message: "Not found." } }), undefined, undefined, claimState);
    press();
    await vi.waitFor(() => expect($("#claim-error").textContent).toBe("Setup has already been completed. Sign in instead."));
    expect($("#claim-error a").getAttribute("href")).toBe("/admin/login");
    expect($("#secret").textContent).toBe("");
  });

  it("shows the generic error after a network failure or an unusable answer, and lets the user press again", async () => {
    await start(() => { throw new TypeError("Failed to fetch"); }, undefined, undefined, claimState);
    press();
    await vi.waitFor(() => expect($("#claim-error").textContent).toBe("Something went wrong. Please try again."));
    expect(claim().disabled).toBe(false);
    expect(visible()).toEqual(["#claim-step"]);
    await start(() => reply(200, { secret: SECRET }), undefined, undefined, claimState); // no recovery code: never show half a pair
    press();
    await vi.waitFor(() => expect($("#claim-error").textContent).toBe("Something went wrong. Please try again."));
    expect($("#secret").textContent).toBe("");
    expect(visible()).toEqual(["#claim-step"]);
  });

  it("clears an earlier error when pressed again", async () => {
    let fail = true;
    await start(() => { if (fail) throw new TypeError("Failed to fetch"); return issued(); }, undefined, undefined, claimState);
    press();
    await vi.waitFor(() => expect($("#claim-error").textContent).not.toBe(""));
    fail = false;
    press();
    await vi.waitFor(() => expect($("#secret-step").hidden).toBe(false));
    expect($("#claim-error").textContent).toBe("");
  });
});

describe("setup page, the code flow", () => {
  it("asks for a code when the field is empty or only whitespace, without a request", async () => {
    const { calls } = await start();
    await submit("  ​\t ");
    expect(error().textContent).toBe("Enter the setup code.");
    expect(calls).toEqual([]);
  });

  it("posts the trimmed code as same-origin, uncached JSON to /api/setup, and nowhere else", async () => {
    const { calls } = await start();
    await submitOk();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/setup");
    expect(calls[0].init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ code: "club-setup-phrase" });
  });

  it("sends the code trimmed", async () => {
    const { calls } = await start();
    code().value = "  club-setup-phrase​ ";
    $("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ code: "club-setup-phrase" });
  });

  it("shows the server's message for a wrong code, clears the field, and lets the user try again", async () => {
    await start(() => reply(401, { error: { code: "invalid_setup_code", message: "That setup code isn't right." } }));
    await submit("wrong-code-here");
    expect(error().textContent).toBe("That setup code isn't right.");
    expect(code().value).toBe("");
    expect($("#secret-step").hidden).toBe(true);
    expect(button().disabled).toBe(false);
  });

  it("says how many minutes to wait when rate limited", async () => {
    await start(() => reply(429, { error: { code: "too_many_attempts", message: "Too many attempts. Try again later." } }, { "Retry-After": "600" }));
    await submit("wrong-code-here");
    expect(error().textContent).toBe("Too many attempts. Try again in 10 minutes.");
    await start(() => reply(429, {}, { "Retry-After": "61" }));
    await submit("wrong-code-here");
    expect(error().textContent).toBe("Too many attempts. Try again in 2 minutes.");
    await start(() => reply(429, {}, { "Retry-After": "30" }));
    await submit("wrong-code-here");
    expect(error().textContent).toBe("Too many attempts. Try again in 1 minute.");
    await start(() => reply(429, {}));
    await submit("wrong-code-here");
    expect(error().textContent).toBe("Too many attempts. Try again later.");
  });

  it("explains a closed setup, shows the server's message for other refusals, and a generic one for a network failure", async () => {
    await start(() => reply(404, { error: { code: "not_found", message: "Not found." } }));
    await submit("club-setup-phrase");
    expect(error().textContent).toBe("Setup has already been completed. Sign in instead.");
    const signInLink = error().querySelector("a")!;
    expect(signInLink.getAttribute("href")).toBe("/admin/login");
    expect(signInLink.textContent).toBe("Sign in instead.");
    expect(error().querySelectorAll("a")).toHaveLength(1);
    await start(() => reply(503, { error: { code: "setup_not_ready", message: "Setup isn't ready: set SETUP_CODE to a phrase of at least 12 characters." } }));
    await submit("club-setup-phrase");
    expect(error().textContent).toBe("Setup isn't ready: set SETUP_CODE to a phrase of at least 12 characters.");
    await start(() => { throw new TypeError("Failed to fetch"); });
    await submit("club-setup-phrase");
    expect(error().textContent).toBe("Something went wrong. Please try again.");
    await start(() => new Response("<html>oops</html>", { status: 500 }));
    await submit("club-setup-phrase");
    expect(error().textContent).toBe("Something went wrong. Please try again.");
    await start(() => reply(200, { secret: SECRET })); // no recovery code: never show half a pair
    await submit("club-setup-phrase");
    expect(error().textContent).toBe("Something went wrong. Please try again.");
    expect($("#secret").textContent).toBe("");
  });

  it("ignores a second submit while one is in flight", async () => {
    let release!: () => void;
    const { calls } = await start(() => new Promise<Response>((resolve) => { release = () => resolve(issued()); }));
    code().value = "club-setup-phrase";
    $("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    $("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(calls).toHaveLength(1);
    expect(button().disabled).toBe(true);
    release();
    await vi.waitFor(() => expect($("#secret-step").hidden).toBe(false));
  });

  it("replaces the form with the save screen: both values from the response, and forgets the code", async () => {
    await start();
    await submitOk();
    expect(visible()).toEqual(["#secret-step"]);
    expect($("#secret").textContent).toBe(SECRET);
    expect($("#recovery").textContent).toBe(RECOVERY);
    expect(code().value).toBe("");
    expect(document.activeElement).toBe($("#secret-heading"));
    expect(document.body.textContent).toContain("Both are shown only this once");
    expect(document.body.textContent).toContain("If you run setup again before you first sign in, both are replaced");
  });

  it("keeps both values out of the URL, local and session storage, and cookies", async () => {
    await start();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await submitOk();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    for (const value of [SECRET, RECOVERY]) {
      expect(globalThis.location.href).not.toContain(value);
      expect(document.cookie).not.toContain(value);
    }
    setItem.mockRestore();
  });
});

describe("setup page, the save screen as the page wires it", () => {
  it("lets the user go to sign in only after the one 'I've saved both' tick", async () => {
    const navigate = vi.fn();
    await start(undefined, undefined, navigate);
    await submitOk();
    expect(saved().checked).toBe(false);
    expect(signIn().disabled).toBe(true);
    expect(hint().textContent).toBe("Tick the box first.");
    signIn().click();
    expect(navigate).not.toHaveBeenCalled();
    saved().checked = true;
    saved().dispatchEvent(new Event("change", { bubbles: true }));
    expect(signIn().disabled).toBe(false);
    expect(hint().hidden).toBe(true);
    signIn().click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/admin/login");
  });

  it("copies each value with its own button, from either flow", async () => {
    const writeText = vi.fn(async () => {});
    await start(undefined, { writeText }, undefined, () => reply(200, { state: "claim" }));
    claim().click();
    await vi.waitFor(() => expect($("#secret-step").hidden).toBe(false));
    ($("#copy") as HTMLButtonElement).click();
    ($("#copy-recovery") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenNthCalledWith(1, SECRET);
    expect(writeText).toHaveBeenNthCalledWith(2, RECOVERY);
  });
});

describe("setup page source", () => {
  it("writes the invisible characters as \\u escapes, like crypto.ts and the sign-in page, not as literal characters", () => {
    const js = readFileSync("public/setup.js", "utf8");
    expect(js).toContain('const INVISIBLE = "\\u200B\\u200C\\u200D\\u2060\\u180E\\u00AD";');
    expect(js).not.toMatch(/[\u200B-\u200F\u2060\u180E\u00AD\uFEFF]/);
  });

  it("puts a gap between the copy status line and the note under it (the generic .message p rule would remove it)", () => {
    const css = readFileSync("public/style.css", "utf8");
    expect(css).toMatch(/\.login \.message \.copy-status \{[^}]*margin: 0\.5rem 0 1rem;/);
  });
});

describe("trimming", () => {
  it("agrees with the admin sign-in page and the server (src/server/auth/crypto.ts)", () => {
    for (const input of ["", " ", "abc", "  abc  ", "​abc​", "­abc᠎", "a b", "﻿ abc\n\t", " ​ ", "a​b"]) {
      expect(trimAdminSecret(input), JSON.stringify(input)).toBe(loginTrim(input));
    }
  });
});

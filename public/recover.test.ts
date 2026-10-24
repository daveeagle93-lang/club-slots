// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trimAdminSecret as loginTrim } from "./admin/login.js";
import { init, trimAdminSecret } from "./recover.js";
import { trimAdminSecret as setupTrim } from "./setup.js";

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const SECRET = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw";
const RECOVERY = "Q7mT2vLx9RkWc4HnYp8aBd3sFgJu6ZeNiOo1VtXyM0w";
const CODE = "Zk3pD8sWq1LmV6xRtY0uHc5nBg9aJe2FoIi4TyXdN7A";
const issued = (envPinned = false) => reply(200, { secret: SECRET, recoveryCode: RECOVERY, envPinned });

type Call = { url: string; init?: RequestInit };
type Clipboard = { writeText: (text: string) => Promise<void> };

/** Loads the real recover.html body, then starts the page with a scripted fetch that answers the POSTs. */
async function start(handler: (call: Call) => Response | Promise<Response> = () => issued(), clipboard?: Clipboard, navigate: (url: string) => void = () => {}) {
  const html = readFileSync("public/recover.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init });
  });
  await init({ document, fetch: fetch as unknown as typeof globalThis.fetch, navigator: { clipboard }, navigate });
  return { calls };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const code = () => $("#recovery-code") as HTMLInputElement;
const button = () => $("#recover-form button") as HTMLButtonElement;
const error = () => $("#recover-error");
const saved = () => $("#saved") as HTMLInputElement;
const signIn = () => $("#sign-in") as HTMLButtonElement;
const submit = async (value: string) => {
  code().value = value;
  $("#recover-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(button().disabled).toBe(false)); // disabled synchronously, re-enabled when settled
};
const submitOk = async (value = CODE) => {
  code().value = value;
  $("#recover-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect($("#secret-step").hidden).toBe(false));
};

afterEach(() => { document.body.innerHTML = ""; localStorage.clear(); sessionStorage.clear(); });

describe("recover page markup", () => {
  const html = readFileSync("public/recover.html", "utf8");
  it("is British English, mobile-friendly, noindex, and has no inline script or style", () => {
    expect(html).toContain('<html lang="en-GB">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain('<script type="module" src="/recover.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/<style|style=|\son[a-z]+=/i);
    expect(html).not.toMatch(/action=/);
  });
  it("shares the theme, styles and icons of the other pages", () => {
    expect(html).toContain('<link rel="stylesheet" href="/style.css" />');
    expect(html).toContain('<link rel="stylesheet" href="/api/theme.css" />');
    expect(html).toContain('href="/api/icon/32"');
  });
  it("has one recovery code field (a password input, autocomplete off) with its label and an alert region, and nothing but the save screen's tick besides", () => {
    const inputs = html.match(/<input[^>]*>/g)!;
    expect(inputs).toHaveLength(2); // the code, and the "I've saved both" checkbox
    const field = inputs.find((i) => i.includes('id="recovery-code"'))!;
    expect(field).toMatch(/type="password"/);
    expect(field).toMatch(/autocomplete="off"/);
    expect(field).toMatch(/\brequired\b/);
    expect(inputs.filter((i) => i !== field)[0]).toMatch(/id="saved"[^>]*type="checkbox"|type="checkbox"[^>]*id="saved"/);
    expect(html).toContain('<label for="recovery-code">Recovery code</label>');
    expect(html).toMatch(/<form[^>]*id="recover-form"[^>]*\bnovalidate\b/);
    expect(html).toContain('role="alert"');
  });
  it("has the save screen's ids, hidden at first, with the heading focusable by script and a real disabled button for going on", () => {
    for (const id of ["secret-step", "secret-heading", "secret", "copy", "recovery", "copy-recovery", "copy-status", "saved", "sign-in", "sign-in-hint", "env-note"]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toMatch(/id="secret-step"[^>]*\bhidden\b/);
    expect(html).toMatch(/id="env-note"[^>]*\bhidden\b/);
    expect(html).toMatch(/<h2[^>]*id="secret-heading"[^>]*tabindex="-1"/);
    expect(html).toMatch(/<button[^>]*id="sign-in"[^>]*\bdisabled\b/);
    expect(html).toContain("Both are shown only this once");
    expect(html).toContain("Sign-in is still set to Access in your deployment settings: remove <code>ADMIN_AUTH</code> there too.");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(RECOVERY);
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u); // no emoji
  });
});

describe("recover page, asking for the code", () => {
  it("shows the form and the save screen hidden, and sends nothing on load", async () => {
    const { calls } = await start();
    expect(calls).toEqual([]);
    expect($("#recover-form").hidden).toBe(false);
    expect($("#secret-step").hidden).toBe(true);
    expect($("#secret").textContent).toBe("");
  });

  it("asks for a code when the field is empty or only whitespace, without a request", async () => {
    const { calls } = await start();
    await submit("  \u200B\t ");
    expect(error().textContent).toBe("Enter the recovery code.");
    expect(calls).toEqual([]);
  });

  it("posts the trimmed code as same-origin, uncached JSON to /api/recover, and nowhere else", async () => {
    const { calls } = await start();
    await submitOk(`  ${CODE}\u200B `);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/recover");
    expect(calls[0].init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ code: CODE });
  });

  it("ignores a second submit while one is in flight", async () => {
    let release!: () => void;
    const { calls } = await start(() => new Promise<Response>((resolve) => { release = () => resolve(issued()); }));
    code().value = CODE;
    $("#recover-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    $("#recover-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(calls).toHaveLength(1);
    expect(button().disabled).toBe(true);
    release();
    await vi.waitFor(() => expect($("#secret-step").hidden).toBe(false));
  });
});

describe("recover page, the answers", () => {
  it("success: replaces the form with the save screen showing both values, forgets the code, and puts focus on the warning", async () => {
    await start();
    await submitOk();
    expect($("#recover-form").hidden).toBe(true);
    expect($("#secret-step").hidden).toBe(false);
    expect($("#secret").textContent).toBe(SECRET);
    expect($("#recovery").textContent).toBe(RECOVERY);
    expect(code().value).toBe("");
    expect(document.activeElement).toBe($("#secret-heading"));
    expect($("#env-note").hidden).toBe(true);
  });

  it("success with envPinned: also shows the notice to remove ADMIN_AUTH in the deployment settings", async () => {
    await start(() => issued(true));
    await submitOk();
    expect($("#env-note").hidden).toBe(false);
    expect($("#env-note").textContent).toBe("Sign-in is still set to Access in your deployment settings: remove ADMIN_AUTH there too.");
    expect($("#secret").textContent).toBe(SECRET);
  });

  it("shows the notice only for envPinned exactly true", async () => {
    await start(() => reply(200, { secret: SECRET, recoveryCode: RECOVERY, envPinned: "yes" }));
    await submitOk();
    expect($("#env-note").hidden).toBe(true);
  });

  it("401: shows the server's message, clears the field, and lets the user try again", async () => {
    await start(() => reply(401, { error: { code: "invalid_recovery_code", message: "That recovery code isn't right." } }));
    await submit(CODE);
    expect(error().textContent).toBe("That recovery code isn't right.");
    expect(code().value).toBe("");
    expect($("#secret-step").hidden).toBe(true);
    expect(button().disabled).toBe(false);
  });

  it("429: says how many minutes to wait", async () => {
    await start(() => reply(429, { error: { code: "too_many_attempts", message: "Too many attempts. Try again later." } }, { "Retry-After": "600" }));
    await submit(CODE);
    expect(error().textContent).toBe("Too many attempts. Try again in 10 minutes.");
    await start(() => reply(429, {}, { "Retry-After": "61" }));
    await submit(CODE);
    expect(error().textContent).toBe("Too many attempts. Try again in 2 minutes.");
    await start(() => reply(429, {}, { "Retry-After": "30" }));
    await submit(CODE);
    expect(error().textContent).toBe("Too many attempts. Try again in 1 minute.");
    await start(() => reply(429, {}));
    await submit(CODE);
    expect(error().textContent).toBe("Too many attempts. Try again later.");
  });

  it("404: says recovery is not available here, with a way on to sign-in", async () => {
    await start(() => reply(404, { error: { code: "not_found", message: "Not found." } }));
    await submit(CODE);
    expect(error().textContent).toBe("Recovery isn't available on this site. Sign in instead.");
    const link = error().querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/admin/login");
    expect(link.textContent).toBe("Sign in instead.");
    expect(error().querySelectorAll("a")).toHaveLength(1);
    expect(code().value).toBe("");
  });

  it("409: shows the server's message", async () => {
    await start(() => reply(409, { error: { code: "recovery_code_used", message: "That recovery code has already been used." } }));
    await submit(CODE);
    expect(error().textContent).toBe("That recovery code has already been used.");
  });

  it("a network failure or an unusable answer gives the generic message, keeps what was typed, and never shows half a pair", async () => {
    await start(() => { throw new TypeError("Failed to fetch"); });
    await submit(CODE);
    expect(error().textContent).toBe("Something went wrong. Please try again.");
    expect(code().value).toBe(CODE);
    await start(() => new Response("<html>oops</html>", { status: 500 }));
    await submit(CODE);
    expect(error().textContent).toBe("Something went wrong. Please try again.");
    await start(() => reply(200, { secret: SECRET }));
    await submit(CODE);
    expect(error().textContent).toBe("Something went wrong. Please try again.");
    expect($("#secret").textContent).toBe("");
    expect($("#secret-step").hidden).toBe(true);
  });

  it("clears an earlier error when submitted again", async () => {
    let fail = true;
    await start(() => { if (fail) throw new TypeError("Failed to fetch"); return issued(); });
    await submit(CODE);
    expect(error().textContent).not.toBe("");
    fail = false;
    await submitOk();
    expect(error().textContent).toBe("");
  });
});

describe("recover page, the save screen as the page wires it", () => {
  it("lets the user go to sign in only after the one 'I've saved both' tick", async () => {
    const navigate = vi.fn();
    await start(undefined, undefined, navigate);
    await submitOk();
    expect(saved().checked).toBe(false);
    expect(signIn().disabled).toBe(true);
    expect($("#sign-in-hint").textContent).toBe("Tick the box first.");
    signIn().click();
    expect(navigate).not.toHaveBeenCalled();
    saved().checked = true;
    saved().dispatchEvent(new Event("change", { bubbles: true }));
    expect(signIn().disabled).toBe(false);
    signIn().click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/admin/login");
  });

  it("copies each value with its own button", async () => {
    const writeText = vi.fn(async () => {});
    await start(undefined, { writeText });
    await submitOk();
    ($("#copy") as HTMLButtonElement).click();
    ($("#copy-recovery") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenNthCalledWith(1, SECRET);
    expect(writeText).toHaveBeenNthCalledWith(2, RECOVERY);
  });

  it("keeps the values and the code out of the URL, local and session storage, and cookies", async () => {
    await start();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await submitOk();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    for (const value of [SECRET, RECOVERY, CODE]) {
      expect(globalThis.location.href).not.toContain(value);
      expect(document.cookie).not.toContain(value);
    }
    setItem.mockRestore();
  });
});

describe("trimming", () => {
  const inputs = ["", " ", "abc", "  abc  ", "\u200Babc\u200B", "\u00ADabc\u180E", "a b", "\uFEFF abc\n\t", " \u200B ", "a\u200Bb", "\u2060abc\u200C", "\u200D abc"];
  it("is the same as setup.js, the admin sign-in page and the server, so a code typed with stray characters is trimmed alike", () => {
    for (const input of inputs) {
      expect(trimAdminSecret(input), JSON.stringify(input)).toBe(setupTrim(input));
      expect(trimAdminSecret(input), JSON.stringify(input)).toBe(loginTrim(input));
    }
  });

  it("is written in recover.js the way setup.js writes it: the invisible characters as \\u escapes, not literal", () => {
    const js = readFileSync("public/recover.js", "utf8");
    const setup = readFileSync("public/setup.js", "utf8");
    const line = 'const INVISIBLE = "\\u200B\\u200C\\u200D\\u2060\\u180E\\u00AD";';
    expect(js).toContain(line);
    expect(setup).toContain(line);
    expect(js).not.toMatch(/[\u200B-\u200F\u2060\u180E\u00AD\uFEFF]/);
    expect(js).toContain("export function trimAdminSecret(input) {");
    expect(js).toMatch(/const code = trimAdminSecret\(field\.value\);/);
  });
});

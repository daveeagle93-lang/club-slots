// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { init, trimAdminSecret } from "./login.js";

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const SIGNED_OUT = () => reply(401, { error: { code: "unauthenticated" }, provider: "password" });

type Call = { url: string; init?: RequestInit };

/**
 * Loads the real login.html body, then starts the page with a scripted fetch. The page also asks whether /recover exists
 * (a HEAD request): that is answered here, by `recover` (a status, or "network" for a failed request, 404 unless a test says
 * otherwise), and kept out of `calls` so the tests of the session check and the sign-in POST see only their own requests.
 */
async function start(handler: (call: Call) => Response | Promise<Response>, { recover = 404 }: { recover?: number | "network" } = {}) {
  const html = readFileSync("public/admin/login.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
  const calls: Call[] = [];
  const recoverCalls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/recover") {
      recoverCalls.push({ url, init });
      if (recover === "network") throw new TypeError("Failed to fetch");
      return new Response(null, { status: recover });
    }
    calls.push({ url, init });
    return handler({ url, init });
  });
  const location = { assign: vi.fn() };
  await init({ document, fetch: fetch as unknown as typeof globalThis.fetch, location });
  return { calls, recoverCalls, location };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const password = () => $("#password") as HTMLInputElement;
const button = () => $("#login-form button") as HTMLButtonElement;
const error = () => $("#login-error");
const submit = async (value: string) => {
  password().value = value;
  $("#login-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(button().disabled).toBe(false)); // disabled synchronously, re-enabled when settled
};
const SECRET = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw";
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { document.body.innerHTML = ""; });

describe("login page markup", () => {
  const html = readFileSync("public/admin/login.html", "utf8");
  it("is British English, mobile-friendly and has no inline script or style", () => {
    expect(html).toContain('<html lang="en-GB">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<script type="module" src="/admin/login.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/<style|style=|\son[a-z]+=/i);
  });
  it("has one secret field that password managers recognise, a limit that does not truncate a padded secret, and an alert region", () => {
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autocomplete="current-password"|<input[^>]*autocomplete="current-password"[^>]*type="password"/);
    expect(html).toContain('<label for="password">Admin secret</label>');
    expect(html).toMatch(/<input[^>]*maxlength="256"/); // the server's cap on the raw value
    expect(html).toMatch(/<input[^>]*spellcheck="false"/);
    expect(html).toMatch(/<input[^>]*autocapitalize="off"/);
    expect(html).toContain('role="alert"');
    expect(html).not.toMatch(/action=/);
  });
});

describe("login page", () => {
  it("asks the session endpoint first, uncached, and shows the form when signed out", async () => {
    const { calls } = await start(SIGNED_OUT);
    expect(calls[0].url).toBe("/api/admin/session");
    expect(calls[0].init?.cache).toBe("no-store");
    expect($("#login-form").hidden).toBe(false);
    expect($("#login-status").hidden).toBe(true);
  });

  it("goes straight to the admin pages when already signed in, without showing the form", async () => {
    const { location } = await start(() => reply(200, { identity: "admin", provider: "password", csrfToken: "t" }));
    expect(location.assign).toHaveBeenCalledWith("/admin/");
    expect($("#login-form").hidden).toBe(true);
  });

  it("offers no password form when sign-in is handled by Access", async () => {
    const { calls } = await start(() => reply(401, { error: { code: "unauthenticated" }, provider: "access" }));
    expect($("#login-form").hidden).toBe(true);
    expect($("#login-status").textContent).toContain("Cloudflare Access");
    expect(calls).toHaveLength(1);
  });

  it("says so when admin sign-in is not set up", async () => {
    await start(() => reply(503, { error: { code: "admin_not_configured" } }));
    expect($("#login-form").hidden).toBe(true);
    expect($("#login-status").textContent).toContain("isn't set up");
  });

  it("posts the secret as JSON, disables the button meanwhile, and navigates on success", async () => {
    let release!: (r: Response) => void;
    const { calls, location } = await start((call) =>
      call.url === "/api/admin/session" ? SIGNED_OUT() : new Promise<Response>((resolve) => { release = resolve; }));
    password().value = SECRET;
    $("#login-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(button().disabled).toBe(true);
    const post = calls[1];
    expect(post.url).toBe("/api/admin/login");
    expect(post.init?.method).toBe("POST");
    expect((post.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(post.init?.credentials).toBe("same-origin");
    expect(JSON.parse(post.init?.body as string)).toEqual({ password: SECRET });
    expect(location.assign).not.toHaveBeenCalled();
    release(reply(200, { identity: "admin", csrfToken: "t" }));
    await vi.waitFor(() => expect(location.assign).toHaveBeenCalledWith("/admin/"));
  });

  it("trims whitespace around a pasted secret, and treats whitespace alone as empty", async () => {
    const { calls } = await start((call) => call.url === "/api/admin/session" ? SIGNED_OUT() : reply(401, {}));
    await submit(`  ${SECRET}\t `);
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ password: SECRET });
    password().value = " \t ";
    $("#login-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls).toHaveLength(2);
    expect(error().textContent).toBe("Enter the admin secret.");
  });

  it("trims NBSP and zero-width characters too, and keeps a padded paste whole in the field", async () => {
    const { calls } = await start((call) => call.url === "/api/admin/session" ? SIGNED_OUT() : reply(401, {}));
    const padded = ` \u00A0\u200B${SECRET}\uFEFF\u00AD\n`;
    const limit = Number(password().getAttribute("maxlength"));
    expect(limit).toBeGreaterThanOrEqual(padded.length);
    await submit(padded.slice(0, limit)); // what the browser would keep of the paste
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ password: SECRET });
  });

  it("trims exactly the code units the server helper does, for every UTF-16 code unit", async () => {
    // Loaded through a variable path so the public type-check (DOM lib) does not pull in the server file.
    const serverModule = "../../src/server/auth/crypto";
    const { trimAdminSecret: trimOnServer } = (await import(/* @vite-ignore */ serverModule)) as { trimAdminSecret: (s: string) => string };
    for (let code = 0; code <= 0xffff; code++) {
      const c = String.fromCharCode(code);
      expect(trimAdminSecret(`${c}a${c}`), `U+${code.toString(16)}`).toBe(trimOnServer(`${c}a${c}`));
    }
    expect(trimAdminSecret("\u200B a \u200B")).toBe("a");
  });

  it("sends interior whitespace and other characters as typed, leaving the server to refuse them", async () => {
    const { calls } = await start((call) => call.url === "/api/admin/session" ? SIGNED_OUT() : reply(401, {}));
    await submit("abc def");
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ password: "abc def" });
  });

  it("ignores a second submit while one is in flight", async () => {
    const { calls } = await start((call) => call.url === "/api/admin/session" ? SIGNED_OUT() : new Promise<Response>(() => {}));
    password().value = "a long enough password";
    for (let i = 0; i < 3; i++) $("#login-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.filter((c) => c.url === "/api/admin/login")).toHaveLength(1);
  });

  it("shows a generic error in the alert region, re-enables the button and clears the field on a wrong secret", async () => {
    const { location } = await start((call) =>
      call.url === "/api/admin/session" ? SIGNED_OUT() : reply(401, { error: { code: "invalid_credentials" } }));
    await submit("not the secret");
    expect(error().getAttribute("role")).toBe("alert");
    expect(error().textContent).toBe("That admin secret isn't right.");
    expect(button().disabled).toBe(false);
    expect(password().value).toBe("");
    expect(location.assign).not.toHaveBeenCalled();
  });

  it("explains a rate limit, in minutes, from Retry-After", async () => {
    await start((call) => call.url === "/api/admin/session" ? SIGNED_OUT() : reply(429, { error: { code: "too_many_attempts" } }, { "Retry-After": "800" }));
    await submit("anything at all here");
    expect(error().textContent).toBe("Too many attempts. Try again in 14 minutes.");
    expect(button().disabled).toBe(false);
  });

  it("copes with a missing Retry-After and says '1 minute' in the singular", async () => {
    await start((call) => call.url === "/api/admin/session" ? SIGNED_OUT() : reply(429, {}, { "Retry-After": "30" }));
    await submit("anything at all here");
    expect(error().textContent).toBe("Too many attempts. Try again in 1 minute.");
    await start((call) => call.url === "/api/admin/session" ? SIGNED_OUT() : reply(429, {}));
    await submit("anything at all here");
    expect(error().textContent).toBe("Too many attempts. Try again later.");
  });

  it("shows a generic message for server errors and network failures", async () => {
    await start((call) => call.url === "/api/admin/session" ? SIGNED_OUT() : reply(500, {}));
    await submit("anything at all here");
    expect(error().textContent).toBe("Something went wrong. Please try again.");
    await start((call) => {
      if (call.url === "/api/admin/session") return SIGNED_OUT();
      throw new TypeError("offline");
    });
    await submit("anything at all here");
    expect(error().textContent).toBe("Something went wrong. Please try again.");
    expect(button().disabled).toBe(false);
  });

  it("does not post an empty secret", async () => {
    const { calls } = await start(SIGNED_OUT);
    $("#login-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls).toHaveLength(1);
    expect(error().textContent).toBe("Enter the admin secret.");
  });

  it("still shows the form if the session check itself fails", async () => {
    await start(() => { throw new TypeError("offline"); });
    expect($("#login-form").hidden).toBe(false);
  });
});

// /recover is a plain 404 unless a recovery code is stored (a site made on v1.1 has none), so the page only offers the link
// when a HEAD request to /recover says it exists, rather than sending an admin to "Not found".
describe("recovery link", () => {
  const TEXT = "Lost your admin secret? Use your recovery code.";
  const hint = () => $("#recover-hint");
  const link = (within: Element | null) => within?.querySelector<HTMLAnchorElement>('a[href="/recover"]') ?? null;
  const wrong = () => reply(401, { error: { code: "invalid_credentials" } });
  /** Signed out; the sign-in POST answers `login`. */
  const signedOut = (login: () => Response = wrong) => (call: Call) => (call.url === "/api/admin/session" ? SIGNED_OUT() : login());

  it("is in the sign-in page, hidden until the page knows /recover exists", () => {
    const html = readFileSync("public/admin/login.html", "utf8");
    expect(html).toMatch(/<p id="recover-hint"[^>]*\shidden[^>]*><a href="\/recover">Lost your admin secret\? Use your recovery code\.<\/a><\/p>/);
  });

  it("shows the link under the form when /recover is there, asking with HEAD and without the cache", async () => {
    const { recoverCalls } = await start(signedOut(), { recover: 200 });
    expect(recoverCalls).toHaveLength(1);
    expect(recoverCalls[0].init?.method).toBe("HEAD");
    expect(recoverCalls[0].init?.cache).toBe("no-store");
    expect(hint().hidden).toBe(false);
    expect(link(hint())?.textContent).toBe(TEXT);
    expect($("#login-form").hidden).toBe(false);
  });

  it("keeps the link hidden when the site has no recovery code (/recover answers 404)", async () => {
    await start(signedOut(), { recover: 404 });
    expect(hint().hidden).toBe(true);
    expect($("#login-form").hidden).toBe(false);
  });

  it("keeps the link hidden, and still shows the form, if the check fails", async () => {
    await start(signedOut(), { recover: "network" });
    expect(hint().hidden).toBe(true);
    expect($("#login-form").hidden).toBe(false);
  });

  it("does not ask when there is no password form to sign in with", async () => {
    const { recoverCalls } = await start(() => reply(401, { error: { code: "unauthenticated" }, provider: "access" }), { recover: 200 });
    expect(recoverCalls).toHaveLength(0);
    expect(hint().hidden).toBe(true);
  });

  it("offers it again in the error after a wrong secret", async () => {
    await start(signedOut(), { recover: 200 });
    await submit("not the secret");
    expect(error().textContent).toBe(`That admin secret isn't right. ${TEXT}`);
    expect(link(error())?.textContent).toBe(TEXT);
  });

  it("offers it again in the error after too many attempts", async () => {
    await start(signedOut(() => reply(429, { error: { code: "too_many_attempts" } }, { "Retry-After": "800" })), { recover: 200 });
    await submit("anything at all here");
    expect(error().textContent).toBe(`Too many attempts. Try again in 14 minutes. ${TEXT}`);
    expect(link(error())).not.toBeNull();
  });

  it("does not put it in the error when the site has no recovery code", async () => {
    await start(signedOut(), { recover: 404 });
    await submit("not the secret");
    expect(error().textContent).toBe("That admin secret isn't right.");
    expect(link(error())).toBeNull();
  });

  it("does not put it in a server-error message, which a recovery code would not fix", async () => {
    await start(signedOut(() => reply(500)), { recover: 200 });
    await submit("anything at all here");
    expect(error().textContent).toBe("Something went wrong. Please try again.");
    expect(link(error())).toBeNull();
  });

  it("clears the link from the error when the next attempt starts", async () => {
    let first = true;
    await start(signedOut(() => { const r = first ? wrong() : reply(500); first = false; return r; }), { recover: 200 });
    await submit("first");
    expect(link(error())).not.toBeNull();
    await submit("second");
    expect(link(error())).toBeNull();
  });
});

// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showSaveScreen } from "./save-screen.js";

const SECRET = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw"; // gitleaks:allow
const RECOVERY = "Q7mT2vLx9RkWc4HnYp8aBd3sFgJu6ZeNiOo1VtXyM0w"; // gitleaks:allow

type Clipboard = { writeText: (text: string) => Promise<void> };

/** Loads the real setup.html body, then shows the save screen the way a page would. */
function show(clipboard?: Clipboard, navigate: (url: string) => void = () => {}, signInUrl?: string) {
  const html = readFileSync("public/setup.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
  showSaveScreen({ document, navigator: { clipboard } as Navigator, navigate }, { secret: SECRET, recoveryCode: RECOVERY, signInUrl });
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const saved = () => $("#saved") as HTMLInputElement;
const signIn = () => $("#sign-in") as HTMLButtonElement;
const tick = (checked: boolean) => {
  saved().checked = checked;
  saved().dispatchEvent(new Event("change", { bubbles: true }));
};

afterEach(() => { document.body.innerHTML = ""; localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe("showSaveScreen", () => {
  it("reveals the step (hidden in the markup) and puts each value in its own element, then moves focus to the heading", () => {
    show();
    expect($("#secret-step").hidden).toBe(false);
    expect($("#secret").textContent).toBe(SECRET);
    expect($("#recovery").textContent).toBe(RECOVERY);
    expect(document.activeElement).toBe($("#secret-heading"));
  });

  it("warns that both are shown once and suggests keeping the two apart", () => {
    show();
    const text = $("#secret-step").textContent!;
    expect(text).toContain("Both are shown only this once");
    expect(text).toContain("keep them as two separate entries");
  });

  it("keeps the sign-in button disabled, with its hint, until the single 'I've saved both' tick is ticked", () => {
    show();
    expect(document.querySelectorAll("#secret-step input")).toHaveLength(1);
    expect($("label[for=saved]").textContent).toBe("I've saved both");
    expect(signIn().disabled).toBe(true);
    expect($("#sign-in-hint").hidden).toBe(false);
    tick(true);
    expect(signIn().disabled).toBe(false);
    expect($("#sign-in-hint").hidden).toBe(true);
    tick(false);
    expect(signIn().disabled).toBe(true);
    expect($("#sign-in-hint").hidden).toBe(false);
  });

  it("goes to /admin/login by default, and to the given address when there is one, only once ticked", () => {
    const navigate = vi.fn();
    show(undefined, navigate);
    signIn().click();
    expect(navigate).not.toHaveBeenCalled();
    tick(true);
    signIn().click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/admin/login");

    const other = vi.fn();
    show(undefined, other, "/admin/somewhere");
    tick(true);
    signIn().click();
    expect(other).toHaveBeenCalledExactlyOnceWith("/admin/somewhere");
  });

  it("copies the secret with its button and the recovery code with its own, and says which", async () => {
    const writeText = vi.fn(async () => {});
    show({ writeText });
    ($("#copy") as HTMLButtonElement).click();
    await vi.waitFor(() => expect($("#copy-status").textContent).toBe("Copied the admin secret."));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(SECRET);
    ($("#copy-recovery") as HTMLButtonElement).click();
    await vi.waitFor(() => expect($("#copy-status").textContent).toBe("Copied the recovery code."));
    expect(writeText).toHaveBeenLastCalledWith(RECOVERY);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("tells the user to copy by hand when the clipboard is missing or refuses, naming the right value", async () => {
    show(undefined);
    ($("#copy") as HTMLButtonElement).click();
    await vi.waitFor(() => expect($("#copy-status").textContent).toContain("Select the admin secret above and copy it yourself"));
    show({ writeText: async () => { throw new Error("denied"); } });
    ($("#copy-recovery") as HTMLButtonElement).click();
    await vi.waitFor(() => expect($("#copy-status").textContent).toContain("Select the recovery code above and copy it yourself"));
  });

  it("writes neither value anywhere but its element: not the address, storage or cookies", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const assign = vi.fn();
    const writeText = vi.fn(async () => {});
    show({ writeText }, assign);
    ($("#copy") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    for (const value of [SECRET, RECOVERY]) {
      expect(globalThis.location.href).not.toContain(value);
      expect(document.cookie).not.toContain(value);
      expect(assign).not.toHaveBeenCalled();
      for (const el of document.querySelectorAll("*")) {
        for (const attr of el.getAttributeNames()) expect(el.getAttribute(attr), `${el.tagName} ${attr}`).not.toContain(value);
      }
    }
    expect($("#secret").textContent).not.toContain(RECOVERY);
    expect($("#recovery").textContent).not.toContain(SECRET);
  });
});

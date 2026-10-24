import { brandPage, loadSettings } from "./branding.js";
import { showSaveScreen } from "./save-screen.js";

const SIGN_IN = "/admin/login";
const GENERIC_ERROR = "Something went wrong. Please try again.";
const CLOSED = "Setup has already been completed.";

function rateLimitMessage(retryAfter) {
  const seconds = Number(retryAfter);
  if (!retryAfter || !Number.isFinite(seconds) || seconds <= 0) return "Too many attempts. Try again later.";
  const minutes = Math.ceil(seconds / 60);
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

// Same trimming as trimAdminSecret in src/server/auth/crypto.ts (this page cannot import from src/, nor from the
// guarded /admin/login.js); setup.test.ts checks it agrees with the sign-in page's copy. Whitespace plus the invisible
// characters String.prototype.trim leaves in.
const INVISIBLE = "\u200B\u200C\u200D\u2060\u180E\u00AD";
const isIgnorable = (char) => char.trim() === "" || INVISIBLE.includes(char);

/** Drops whitespace and invisible characters from both ends only. */
export function trimAdminSecret(input) {
  let start = 0;
  let end = input.length;
  while (start < end && isIgnorable(input[start])) start++;
  while (end > start && isIgnorable(input[end - 1])) end--;
  return input.slice(start, end);
}

/** The closed-setup text, with a way on to sign-in. */
function showClosed(document, target) {
  const link = document.createElement("a");
  link.href = SIGN_IN;
  link.textContent = "Sign in instead.";
  target.textContent = CLOSED;
  target.append(" ", link);
}

/**
 * Wires the first-run page. It first asks /api/setup which step to show: the setup code form, the claim button (also
 * offered again to the browser that claimed), or a note that the site is already set up. Either way in, the admin secret
 * and the recovery code the server made are then shown once, by the shared save screen.
 */
export async function init({ document, fetch, navigator, navigate = (url) => document.location.assign(url) }) {
  const form = document.getElementById("setup-form");
  const field = document.getElementById("code");
  const error = document.getElementById("setup-error");
  const button = form.querySelector("button");
  const pageError = document.getElementById("page-error");
  const claimStep = document.getElementById("claim-step");
  const claimHeading = document.getElementById("claim-heading");
  const claimText = document.getElementById("claim-text");
  const claimError = document.getElementById("claim-error");
  const claim = document.getElementById("claim");
  const takenStep = document.getElementById("taken-step");
  let submitting = false;
  let claiming = false;

  const showSecrets = (body) => showSaveScreen({ document, navigator, navigate }, body);
  const hasBoth = (body) => typeof body?.secret === "string" && typeof body?.recoveryCode === "string";

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    const code = trimAdminSecret(field.value);
    if (code === "") {
      error.textContent = "Enter the setup code.";
      return;
    }
    submitting = true;
    button.disabled = true;
    error.textContent = "";
    let message = GENERIC_ERROR;
    let closed = false;
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && hasBoth(body)) {
        field.value = "";
        form.hidden = true;
        showSecrets(body);
        return;
      }
      if (res.status === 429) message = rateLimitMessage(res.headers.get("Retry-After"));
      else if (res.status === 404) { message = CLOSED; closed = true; }
      else if (typeof body?.error?.message === "string") message = body.error.message;
    } catch { /* offline or blocked: the generic message */ }
    if (message !== GENERIC_ERROR) field.value = "";
    if (closed) showClosed(document, error);
    else error.textContent = message;
    submitting = false;
    button.disabled = false;
    field.focus();
  }
  form.addEventListener("submit", submit);

  // Nothing is made by loading the page: only this press asks the server to (design 3.3).
  async function makeSecrets() {
    if (claiming) return;
    claiming = true;
    claim.disabled = true;
    claimError.textContent = "";
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: "{}",
      });
      const body = await res.json().catch(() => null);
      if (res.ok && hasBoth(body)) {
        claimStep.hidden = true;
        showSecrets(body);
        return;
      }
      if (res.status === 409) {
        claimStep.hidden = true;
        takenStep.hidden = false;
        return;
      }
      if (res.status === 404) showClosed(document, claimError);
      else claimError.textContent = typeof body?.error?.message === "string" ? body.error.message : GENERIC_ERROR;
    } catch {
      claimError.textContent = GENERIC_ERROR;
    }
    claiming = false;
    claim.disabled = false;
  }
  claim.addEventListener("click", makeSecrets);

  let state = null;
  try {
    const res = await fetch("/api/setup", { credentials: "same-origin", cache: "no-store" });
    const body = await res.json().catch(() => null);
    if (res.ok && typeof body?.state === "string") state = body.state;
    else if (res.status === 404) showClosed(document, pageError);
    else pageError.textContent = typeof body?.error?.message === "string" ? body.error.message : GENERIC_ERROR;
  } catch {
    pageError.textContent = GENERIC_ERROR;
  }
  if (state === "code") form.hidden = false;
  else if (state === "claim" || state === "reissue") {
    if (state === "reissue") {
      claimHeading.textContent = "Get a new admin secret";
      claimText.textContent = "You made an admin secret here but have not signed in yet. Press the button to replace it with a new admin secret and a new recovery code. Both are shown once. Save both in a password manager before you leave this page.";
      claim.textContent = "Show me a new secret";
    }
    claimStep.hidden = false;
  } else if (state === "taken") takenStep.hidden = false;
  else if (state !== null) pageError.textContent = GENERIC_ERROR;
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  brandPage(document, loadSettings((...args) => fetch(...args)), { pageTitle: document.title, home: "/" });
  init({ document, fetch: (...args) => fetch(...args), navigator });
}

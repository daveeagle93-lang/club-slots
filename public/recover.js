import { brandPage, loadSettings } from "./branding.js";
import { showSaveScreen } from "./save-screen.js";

const SIGN_IN = "/admin/login";
const GENERIC_ERROR = "Something went wrong. Please try again.";

function rateLimitMessage(retryAfter) {
  const seconds = Number(retryAfter);
  if (!retryAfter || !Number.isFinite(seconds) || seconds <= 0) return "Too many attempts. Try again later.";
  const minutes = Math.ceil(seconds / 60);
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

// Same trimming as trimAdminSecret in src/server/auth/crypto.ts and public/setup.js (this page cannot import setup.js, which
// starts the setup page when it finds #app[data-autostart]); recover.test.ts checks the copies agree. Whitespace plus the
// invisible characters String.prototype.trim leaves in.
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

/** The unavailable text, with a way on to sign-in. */
function showUnavailable(document, target) {
  const link = document.createElement("a");
  link.href = SIGN_IN;
  link.textContent = "Sign in instead.";
  target.textContent = "Recovery isn't available on this site.";
  target.append(" ", link);
}

/**
 * Wires the recovery page: the recovery code is sent to /api/recover, and the new admin secret and recovery code it answers
 * with are shown once by the shared save screen. The page is only served while recovery is available, so it asks nothing first.
 */
export async function init({ document, fetch, navigator, navigate = (url) => document.location.assign(url) }) {
  const form = document.getElementById("recover-form");
  const field = document.getElementById("recovery-code");
  const error = document.getElementById("recover-error");
  const button = form.querySelector("button");
  let submitting = false;

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    const code = trimAdminSecret(field.value);
    if (code === "") {
      error.textContent = "Enter the recovery code.";
      return;
    }
    submitting = true;
    button.disabled = true;
    error.textContent = "";
    let message = GENERIC_ERROR;
    let unavailable = false;
    try {
      const res = await fetch("/api/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && typeof body?.secret === "string" && typeof body?.recoveryCode === "string") {
        field.value = "";
        form.hidden = true;
        showSaveScreen({ document, navigator, navigate }, body);
        if (body.envPinned === true) document.getElementById("env-note").hidden = false;
        return;
      }
      if (res.status === 429) message = rateLimitMessage(res.headers.get("Retry-After"));
      else if (res.status === 404) unavailable = true;
      else if (typeof body?.error?.message === "string") message = body.error.message;
    } catch { /* offline or blocked: the generic message */ }
    if (message !== GENERIC_ERROR || unavailable) field.value = "";
    if (unavailable) showUnavailable(document, error);
    else error.textContent = message;
    submitting = false;
    button.disabled = false;
    field.focus();
  }
  form.addEventListener("submit", submit);
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  brandPage(document, loadSettings((...args) => fetch(...args)), { pageTitle: document.title, home: "/" });
  init({ document, fetch: (...args) => fetch(...args), navigator });
}

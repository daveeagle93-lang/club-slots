import { brandPage, loadSettings } from "../branding.js";

const ADMIN_HOME = "/admin/";
const GENERIC_ERROR = "Something went wrong. Please try again.";

function rateLimitMessage(retryAfter) {
  const seconds = Number(retryAfter);
  if (!retryAfter || !Number.isFinite(seconds) || seconds <= 0) return "Too many attempts. Try again later.";
  const minutes = Math.ceil(seconds / 60);
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

// Same trimming as trimAdminSecret in src/server/auth/crypto.ts (this page cannot import from src/); login.test.ts
// checks the two agree. Whitespace plus the invisible characters String.prototype.trim leaves in.
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

/** Wires the sign-in page. Resolves once the session check has settled. */
export async function init({ document, fetch, location }) {
  const status = document.getElementById("login-status");
  const form = document.getElementById("login-form");
  const field = document.getElementById("password");
  const error = document.getElementById("login-error");
  const button = form.querySelector("button");
  let submitting = false;

  const showMessage = (text) => {
    form.hidden = true;
    status.textContent = text;
    status.hidden = false;
  };
  const showForm = () => {
    status.hidden = true;
    form.hidden = false;
    field.focus();
  };

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    // Whitespace and zero-width characters around a pasted secret are dropped; a generated secret has none,
    // and the server checks what is sent (and trims the same way), so this can't make a wrong value pass.
    const secret = trimAdminSecret(field.value);
    if (secret === "") {
      error.textContent = "Enter the admin secret.";
      return;
    }
    submitting = true;
    button.disabled = true;
    error.textContent = "";
    let message = GENERIC_ERROR;
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ password: secret }),
      });
      if (res.ok) return location.assign(ADMIN_HOME); // stays disabled while the page changes
      if (res.status === 401) message = "That admin secret isn't right.";
      else if (res.status === 429) message = rateLimitMessage(res.headers.get("Retry-After"));
    } catch { /* offline or blocked: the generic message */ }
    if (message !== GENERIC_ERROR) field.value = "";
    error.textContent = message;
    submitting = false;
    button.disabled = false;
    field.focus();
  }
  form.addEventListener("submit", submit);

  // A SameSite=Strict cookie is not sent on a cross-site navigation (a link from a chat app, say), so a
  // signed-in admin can land here; the fetch below is same-origin and does carry it.
  try {
    const res = await fetch("/api/admin/session", { cache: "no-store", credentials: "same-origin" });
    if (res.ok) return location.assign(ADMIN_HOME);
    if (res.status === 503) return showMessage("Admin sign-in isn't set up yet.");
    const body = res.status === 401 ? await res.json().catch(() => null) : null;
    if (body?.provider === "access") {
      return showMessage("Sign-in is handled by your organisation's Cloudflare Access login. Open the admin pages from the link you were given.");
    }
  } catch { /* fall through: show the form and let the sign-in attempt report any problem */ }
  showForm();
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  brandPage(document, loadSettings((...args) => fetch(...args)), { pageTitle: document.title, home: "/admin/" });
  init({ document, location, fetch: (...args) => fetch(...args) });
}

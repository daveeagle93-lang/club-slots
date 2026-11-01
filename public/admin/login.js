import { brandPage, loadSettings } from "../branding.js";

const ADMIN_HOME = "/admin/";
const GENERIC_ERROR = "Something went wrong. Please try again.";
const RECOVERY_TEXT = "Lost your admin secret? Use your recovery code.";

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
  const hint = document.getElementById("recover-hint");
  let submitting = false;
  let recoveryAvailable = false;

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

  /**
   * /recover is a plain 404 unless a recovery code is stored (a site made on v1.1 has none), so the link to it is only offered
   * once a HEAD request says the page is there. Any failure to find out leaves it out.
   */
  async function checkRecovery() {
    try {
      const res = await fetch("/recover", { method: "HEAD", cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return;
      recoveryAvailable = true;
      hint.hidden = false;
    } catch { /* offline or blocked: no link */ }
  }

  /** The error line; with `offerRecovery` it ends with the link to /recover, for the failures a recovery code can fix. */
  function showError(text, offerRecovery) {
    error.textContent = text;
    if (!offerRecovery || !recoveryAvailable) return;
    const link = document.createElement("a");
    link.href = "/recover";
    link.textContent = RECOVERY_TEXT;
    error.append(" ", link);
  }

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
    let offerRecovery = false;
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ password: secret }),
      });
      if (res.ok) return location.assign(ADMIN_HOME); // stays disabled while the page changes
      if (res.status === 401) { message = "That admin secret isn't right."; offerRecovery = true; }
      else if (res.status === 429) { message = rateLimitMessage(res.headers.get("Retry-After")); offerRecovery = true; }
    } catch { /* offline or blocked: the generic message */ }
    if (message !== GENERIC_ERROR) field.value = "";
    showError(message, offerRecovery);
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
  await checkRecovery();
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  brandPage(document, loadSettings((...args) => fetch(...args)), { pageTitle: document.title, home: "/admin/" });
  init({ document, location, fetch: (...args) => fetch(...args) });
}

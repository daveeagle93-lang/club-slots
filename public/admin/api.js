// Shared by the admin pages: the session, CSRF-aware requests, and two tiny DOM helpers.

export const LOGIN_URL = "/admin/login";

/**
 * `fetch` and `navigate` are injected so tests can drive this without a browser.
 * `request` resolves to `{ status, data }` (data is null if the body was not JSON) and rejects on network errors.
 */
export function createApi({ fetch, navigate }) {
  let session = null;

  /** The signed-in session, or null after sending the browser to the login page (not signed in). */
  async function loadSession() {
    const res = await fetch("/api/admin/session", { cache: "no-store" });
    if (res.status === 401) {
      navigate(LOGIN_URL);
      return null;
    }
    const data = res.ok ? await res.json().catch(() => null) : null;
    if (!data || typeof data.csrfToken !== "string") throw new Error(`Session request failed (${res.status})`);
    session = data;
    return session;
  }

  async function send(method, url, body, signal) {
    const init = { method };
    if (signal) init.signal = signal;
    if (method !== "GET") {
      init.headers = { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken };
      init.body = JSON.stringify(body ?? {});
    }
    const res = await fetch(url, init);
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  /**
   * A stale CSRF token (an Access JWT refresh changes it) gets one fresh session and one retry, never a loop.
   * A 401 sends the browser to the login page.
   */
  async function request(method, url, body, signal) {
    const write = method !== "GET";
    if (write && !session && !(await loadSession())) return { status: 401, data: null };
    let result = await send(method, url, body, signal);
    if (write && result.status === 403 && result.data?.error?.code === "csrf_failed") {
      if (!(await loadSession())) return { status: 401, data: null };
      result = await send(method, url, body, signal);
    }
    if (result.status === 401) navigate(LOGIN_URL);
    return result;
  }

  /** Password sessions go to the login page; Access sessions go to the logout URL the server gives. */
  async function logout() {
    const { status, data } = await request("POST", "/api/admin/logout");
    if (status === 401) return;
    if (status !== 200) throw new Error(`Sign out failed (${status})`);
    navigate(typeof data?.logoutUrl === "string" ? data.logoutUrl : LOGIN_URL);
  }

  return { loadSession, request, logout };
}

/** `h(tag, attrs, ...children)`: elements are built with attributes and text nodes only, never parsed HTML. */
export function makeH(document) {
  return (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  };
}

/** True if the text reached the clipboard; false means the caller should offer it for manual copying. */
export async function writeClipboard(clipboard, text) {
  try {
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch { /* denied or unavailable */ }
  return false;
}

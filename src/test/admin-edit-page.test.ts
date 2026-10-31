/// <reference types="node" />
// The real edit page (public/admin/edit.js and event-form.js in happy-dom) against the real Worker and a real local D1, because the
// page's own tests stub fetch and so cannot notice when what the page sends and what the server requires drift apart.
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOW, ORIGIN, passwordEnv, TEST_PASSWORD } from "../server/auth/test-harness";
import { createWorker } from "../worker";
import { init as initEdit } from "../../public/admin/edit.js";
import { createTestEnv, insertEvent, type TestEnv } from "./db";

let t: TestEnv;
let env: Awaited<ReturnType<typeof passwordEnv>>;
let cookie = "";
const worker = createWorker({ now: () => NOW });

beforeAll(async () => {
  t = await createTestEnv();
  env = await passwordEnv(t.env.DB);
  const login = await worker.fetch(new Request(`${ORIGIN}/api/admin/login`, {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.60" },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  }), env);
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
});
afterAll(async () => { await t.dispose(); });

/** An edit page for `slug`, its requests going to the Worker as the browser would send them. */
async function openEdit(slug: string) {
  const window = new Window({ url: `${ORIGIN}/` });
  window.document.body.innerHTML = '<main id="app"></main>';
  const fetchImpl = (url: string, init: any = {}) => {
    const headers = new Headers(init.headers ?? {});
    headers.set("Origin", ORIGIN);
    headers.set("Cookie", cookie);
    return worker.fetch(new Request(`${ORIGIN}${url}`, { method: init.method ?? "GET", headers, body: init.body }), env);
  };
  await initEdit({
    document: window.document, fetch: fetchImpl, navigate: () => {}, clipboard: null,
    location: { origin: ORIGIN, search: `?slug=${slug}` },
  });
  const doc = window.document;
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 25)); };
  await settle();
  const type = (id: string, value: string) => {
    const el = doc.getElementById(id) as unknown as { value: string; dispatchEvent(e: unknown): void };
    el.value = value;
    el.dispatchEvent(new window.Event("input", { bubbles: true }) as never);
  };
  const save = async () => {
    doc.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as never);
    await settle();
  };
  return { doc, type, save, button: (name: string) => [...doc.querySelectorAll("button")].find((b) => b.textContent === name), settle };
}

const capacityOf = async (slug: string) =>
  (await t.env.DB.prepare("SELECT l.capacity AS c FROM event_layout l JOIN events e ON e.id = l.event_id WHERE e.slug = ?").bind(slug).first<{ c: number }>())!.c;
const FUTURE = { startUtc: "2026-10-17T08:00:00Z", endUtc: "2026-10-17T10:00:00Z" };

describe("the edit page against the real server", () => {
  it("saves a change of the places: the page sends the revision the server asks for", async () => {
    const { slug } = await insertEvent(t.env.DB, FUTURE);
    const page = await openEdit(slug);
    page.type("capacity", "3");
    await page.save();
    expect(page.doc.querySelector("h1")!.textContent).toBe("Saved.");
    expect(await capacityOf(slug)).toBe(3);
  });

  it("two admins: the one who saves second is told, reloads, and then saves", async () => {
    const { slug } = await insertEvent(t.env.DB, FUTURE);
    const a = await openEdit(slug);
    const b = await openEdit(slug);
    a.type("capacity", "2");
    await a.save();
    expect(await capacityOf(slug)).toBe(2);
    b.type("capacity", "4");
    await b.save();
    expect(b.doc.querySelector(".form-error span")!.textContent).toContain("were changed by someone else");
    expect(await capacityOf(slug)).toBe(2); // nothing written
    b.button("Reload")!.dispatchEvent(new (b.doc.defaultView as any).Event("click", { bubbles: true }));
    await b.settle();
    expect((b.doc.getElementById("capacity") as unknown as { value: string }).value).toBe("2");
    b.type("capacity", "4");
    await b.save();
    expect(b.doc.querySelector("h1")!.textContent).toBe("Saved.");
    expect(await capacityOf(slug)).toBe(4);
  });
});

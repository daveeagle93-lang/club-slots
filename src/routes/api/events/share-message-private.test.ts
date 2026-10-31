import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../../server/env";
import { pageAssets } from "../../../test/assets";
import { createTestEnv, insertEvent, insertTemplate, type TestEnv } from "../../../test/db";
import { createWorker } from "../../../worker";
import { onRequestGet as publicEvents } from "./index";
import { onRequestGet as publicEvent } from "./[slug]/index";

// The share message and the templates are for the admin only: no public endpoint or page may carry them.

const SECRET = "SECRET-SHARE-WORDING-{event}";
const TEMPLATE_SECRET = "TEMPLATE-SHARE-WORDING";

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(async () => {
  vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
  await t.env.DB.prepare("DELETE FROM events").run();
  await t.env.DB.prepare("DELETE FROM event_templates").run();
});
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

describe("public endpoints and pages", () => {
  it("never carry an event's share message or a template, in the event JSON, the list JSON or the link-preview page", async () => {
    const { slug } = await insertEvent(t.env.DB, { name: "Summer show", shareMessage: SECRET });
    await insertTemplate(t.env.DB, { name: "Default", isDefault: true, shareMessage: TEMPLATE_SECRET });

    const one = await publicEvent({ request: new Request(`http://localhost/api/events/${slug}`), env: { DB: t.env.DB }, params: { slug } } as unknown as Parameters<typeof publicEvent>[0]);
    const oneText = await one.text();
    expect(one.status).toBe(200);
    const parsed = JSON.parse(oneText) as { event: Record<string, unknown> };
    expect(Object.keys(parsed.event)).not.toContain("shareMessage");
    expect(Object.keys(parsed)).not.toContain("defaultShareMessage");

    const many = await publicEvents({ request: new Request("http://localhost/api/events"), env: t.env as AppEnv } as unknown as Parameters<typeof publicEvents>[0]);
    const manyText = await many.text();
    expect(many.status).toBe(200);
    expect(JSON.parse(manyText).events).toHaveLength(1);

    const worker = createWorker();
    const pages: string[] = [];
    for (const path of [`/e/${slug}`, "/"]) {
      const res = await worker.fetch(new Request(`https://club.example${path}`), { DB: t.env.DB, ASSETS: pageAssets() });
      expect(res.status).toBe(200);
      pages.push(await res.text());
    }
    expect(pages[0]).toContain("Summer show"); // the event page really was built from the event

    for (const text of [oneText, manyText, ...pages]) {
      expect(text).not.toContain("SECRET-SHARE-WORDING");
      expect(text).not.toContain(TEMPLATE_SECRET);
      expect(text).not.toMatch(/shareMessage|share_message|defaultShareMessage/);
    }
  });
});

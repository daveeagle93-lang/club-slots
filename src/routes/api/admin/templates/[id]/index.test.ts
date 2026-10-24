import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { countRows, createTestEnv, insertBreak, insertEvent, insertTemplate, type TestEnv } from "../../../../../test/db";
import { onRequestPost as createEventRoute } from "../../events/index";
import { onRequestGet as listTemplates, onRequestPost } from "../index";
import { onRequestDelete, onRequestGet, onRequestPut } from "./index";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };
// An event date (YYYY-MM-DD) always in the future, so creating an event never trips the "must start in the future" check.
const FUTURE_DATE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
beforeEach(async () => {
  await t.env.DB.prepare("DELETE FROM event_templates").run();
  await t.env.DB.prepare("DELETE FROM events").run();
});
afterAll(async () => { await t.dispose(); });

interface Options { contentType?: string | null; raw?: string; data?: unknown; env?: unknown }

const call = <H extends (c: never) => Response | Promise<Response>>(handler: H, method: string, id: string, body: unknown, o: Options): Promise<Response> => {
  const headers: Record<string, string> = {};
  if ((body !== undefined || o.raw !== undefined) && o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  return Promise.resolve(handler({
    request: new Request(`http://localhost/api/admin/templates/${id}`, { method, headers, body: o.raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
    env: o.env ?? t.env, params: { id }, data: "data" in o ? o.data : ADMIN,
  } as never));
};
const get = (id: string | number, o: Options = {}) => call(onRequestGet, "GET", String(id), undefined, o);
const put = (id: string | number, body: unknown, o: Options = {}) => call(onRequestPut, "PUT", String(id), body, o);
const del = (id: string | number, o: Options = {}) => call(onRequestDelete, "DELETE", String(id), undefined, o);
const post = (body: unknown): Promise<Response> =>
  Promise.resolve(onRequestPost({
    request: new Request("http://localhost/api/admin/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    env: t.env, data: ADMIN,
  } as unknown as Parameters<typeof onRequestPost>[0]));

const body = (over: Record<string, unknown> = {}) => ({
  name: "Saturday trial", details: "Bring water", venuePostcode: "ab1  2cd", costPence: 1500, start: "09:00", end: "12:00",
  sessionMinutes: 15, gapMinutes: 0, breaks: [{ start: "10:00", end: "10:30", label: "Lunch" }], shareMessage: "Book {event}", ...over,
});
interface Made {
  id: number; name: string; isDefault: boolean; details: string; venuePostcode: string; costPence: number; start: string; end: string;
  sessionMinutes: number; gapMinutes: number; breaks: { start: string; end: string; label: string }[]; shareMessage: string;
}
const create = async (over: Record<string, unknown> = {}): Promise<Made> => {
  const res = await post(body(over));
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return ((await res.json()) as { template: Made }).template;
};
const all = async (): Promise<Made[]> => {
  const res = await Promise.resolve(
    listTemplates({
      request: new Request("http://localhost/api/admin/templates"), env: t.env, data: ADMIN,
    } as unknown as Parameters<typeof listTemplates>[0]),
  );
  return ((await res.json()) as { templates: Made[] }).templates;
};
const defaults = async (): Promise<string[]> => (await all()).filter((x) => x.isDefault).map((x) => x.name);
const fieldsOf = async (res: Response): Promise<Record<string, string>> => {
  expect(res.status).toBe(400);
  return ((await res.json()) as { fields: Record<string, string> }).fields;
};
/** Everything stored for templates and their breaks, to prove a refused request changed nothing. */
const snapshot = async (): Promise<string> => JSON.stringify([
  (await t.env.DB.prepare("SELECT * FROM event_templates ORDER BY id").all()).results,
  (await t.env.DB.prepare("SELECT * FROM event_template_breaks ORDER BY id").all()).results,
]);

describe("the :id in the URL", () => {
  it.each(["0", "-1", "1.5", "abc", "01", "1e3", "", " 1", "1 ", "+1", "0x1", "9007199254740993", "99999999999999999999"])(
    "is a 404 for %j on GET, PUT and DELETE, touching nothing", async (id) => {
      await create();
      const before = await snapshot();
      for (const res of [await get(id), await put(id, body()), await del(id)]) {
        expect(res.status, id).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ error: { code: "not_found", message: "Template not found" } });
      }
      expect(await snapshot()).toBe(before);
    });

  it("is a 404 for a well-formed id that doesn't exist", async () => {
    await create();
    for (const res of [await get(999_999), await put(999_999, body({ name: "Other" })), await del(999_999)]) expect(res.status).toBe(404);
    expect(await countRows(t.env.DB, "event_templates")).toBe(1);
  });
});

describe("GET /api/admin/templates/:id", () => {
  it("returns the template in the list's shape, no-store", async () => {
    const made = await create({ breaks: [{ start: "11:00", end: "11:10" }, { start: "10:00", end: "10:30", label: "Lunch" }] });
    const res = await get(made.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ template: made });
    expect(made.breaks.map((b) => b.start)).toEqual(["10:00", "11:00"]);
  });

  it("keeps each template's breaks to itself", async () => {
    const a = await create({ name: "A", breaks: [{ start: "10:00", end: "10:30", label: "A break" }] });
    const b = await create({ name: "B", breaks: [] });
    expect(((await (await get(a.id)).json()) as { template: Made }).template.breaks).toHaveLength(1);
    expect(((await (await get(b.id)).json()) as { template: Made }).template.breaks).toEqual([]);
  });

  it("refuses with 401 unless the guard set an admin identity", async () => {
    const made = await create();
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      expect((await get(made.id, { data })).status).toBe(401);
      expect((await put(made.id, body(), { data })).status).toBe(401);
      expect((await del(made.id, { data })).status).toBe(401);
    }
    expect(await countRows(t.env.DB, "event_templates")).toBe(1);
  });
});

describe("PUT /api/admin/templates/:id", () => {
  it("replaces every field and all the breaks, and returns what a GET then shows", async () => {
    const made = await create();
    const res = await put(made.id, body({
      name: "  Sunday ", details: "New details", venuePostcode: " cd3  4ef", costPence: 2000, start: "10:00", end: "13:00", sessionMinutes: 20,
      gapMinutes: 5, breaks: [{ start: "12:00", end: "12:15", label: "Tea" }, { start: "11:00", end: "11:15" }], shareMessage: "New {event}",
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const saved = ((await res.json()) as { template: Made }).template;
    expect(saved).toEqual({
      id: made.id, name: "Sunday", isDefault: true, details: "New details", venuePostcode: "CD3 4EF", costPence: 2000, start: "10:00", end: "13:00",
      sessionMinutes: 20, gapMinutes: 5, shareMessage: "New {event}", lanes: [{ name: "" }], capacity: 1,
      fields: [{ label: "Name", required: true, maxLength: 80, identity: true }], identityLimit: 1,
      breaks: [{ start: "11:00", end: "11:15", label: "" }, { start: "12:00", end: "12:15", label: "Tea" }],
    });
    expect(((await (await get(made.id)).json()) as { template: Made }).template).toEqual(saved);
    expect(await countRows(t.env.DB, "event_template_breaks")).toBe(2);
  });

  it("can remove all the breaks, and leaves other templates alone", async () => {
    const other = await create({ name: "Other" });
    const made = await create({ name: "Mine" });
    const before = JSON.stringify(((await (await get(other.id)).json()) as { template: Made }).template);
    expect(((await (await put(made.id, body({ name: "Mine", breaks: [] }))).json()) as { template: Made }).template.breaks).toEqual([]);
    expect(JSON.stringify(((await (await get(other.id)).json()) as { template: Made }).template)).toBe(before);
  });

  it("moves updated_at on, and leaves created_at", async () => {
    const made = await create();
    await t.env.DB.prepare("UPDATE event_templates SET created_at = '2026-01-01T00:00:00Z', updated_at = '2026-01-01T00:00:00Z' WHERE id = ?").bind(made.id).run();
    await put(made.id, body());
    const row = await t.env.DB.prepare("SELECT created_at, updated_at FROM event_templates WHERE id = ?").bind(made.id).first<{ created_at: string; updated_at: string }>();
    expect(row!.created_at).toBe("2026-01-01T00:00:00Z");
    expect(row!.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(row!.updated_at > "2026-01-01T00:00:00Z").toBe(true);
  });

  it("runs the same validation as create, under the same keys, changing nothing", async () => {
    const made = await create();
    const before = await snapshot();
    expect(await fieldsOf(await put(made.id, body({ name: "", end: "08:00", breaks: [{ start: "10:00", end: "10:30", label: "l".repeat(41) }], shareMessage: 1, isDefault: "x" }))))
      .toEqual({
        name: "Enter the template name.", end: "The end must be after the start.", "breaks.0.label": "The break name must be at most 40 characters.",
        shareMessage: "The share message must be text (it can be empty).",
        isDefault: "Default must be true or false.",
      });
    expect(await fieldsOf(await put(made.id, body({ costPence: 100001 })))).toEqual({ costPence: "Enter the cost in pence as a whole number from 0 to 100000." });
    expect(await snapshot()).toBe(before);
  });

  it("returns 415, 400 and 413 for bad bodies, changing nothing", async () => {
    const made = await create();
    const before = await snapshot();
    expect((await put(made.id, body(), { contentType: "text/plain" })).status).toBe(415);
    expect((await put(made.id, undefined, { raw: "{nope", contentType: "application/json" })).status).toBe(400);
    expect((await put(made.id, undefined, { raw: "[]", contentType: "application/json" })).status).toBe(400);
    expect((await put(made.id, { ...body(), padding: "x".repeat(32768) })).status).toBe(413);
    expect(await snapshot()).toBe(before);
  });

  describe("the name", () => {
    it("can be kept, or changed only in case, but not made the same as another template's (ignoring case)", async () => {
      const mine = await create({ name: "Mine", breaks: [] });
      await create({ name: "Other" });
      expect((await put(mine.id, body({ name: "Mine" }))).status).toBe(200);
      expect(((await (await put(mine.id, body({ name: "MINE" }))).json()) as { template: Made }).template.name).toBe("MINE");
      const before = await snapshot();
      for (const name of ["Other", "OTHER", " other "]) {
        expect(await fieldsOf(await put(mine.id, body({ name, isDefault: true }))), name).toEqual({ name: "There is already a template with that name." });
      }
      expect(await snapshot()).toBe(before);
    });
  });

  describe("isDefault", () => {
    it("true makes it the only default, in one step", async () => {
      await create({ name: "First" });
      const second = await create({ name: "Second" });
      const res = await put(second.id, body({ name: "Second", isDefault: true }));
      expect(((await res.json()) as { template: Made }).template.isDefault).toBe(true);
      expect(await defaults()).toEqual(["Second"]);
    });

    it("true on the current default changes nothing about who is the default", async () => {
      const first = await create({ name: "First" });
      await create({ name: "Second" });
      expect((await put(first.id, body({ name: "First", isDefault: true }))).status).toBe(200);
      expect(await defaults()).toEqual(["First"]);
    });

    it("false on the current default is a field error, changing nothing: choose another template instead", async () => {
      const first = await create({ name: "First" });
      await create({ name: "Second" });
      const before = await snapshot();
      expect(await fieldsOf(await put(first.id, body({ name: "Renamed", isDefault: false })))).toEqual({ isDefault: "Choose another template as the default instead." });
      expect(await snapshot()).toBe(before);
      await t.env.DB.prepare("DELETE FROM event_templates WHERE name = 'Second'").run();
      expect(await fieldsOf(await put(first.id, body({ name: "First", isDefault: false })))).toEqual({ isDefault: "Choose another template as the default instead." });
      expect(await defaults()).toEqual(["First"]);
    });

    it("false on a template that isn't the default is fine and leaves the default where it is", async () => {
      await create({ name: "First" });
      const second = await create({ name: "Second" });
      const res = await put(second.id, body({ name: "Second", isDefault: false }));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { template: Made }).template.isDefault).toBe(false);
      expect(await defaults()).toEqual(["First"]);
    });

    it("missing leaves it as it is, for the default and for another template", async () => {
      const first = await create({ name: "First" });
      const second = await create({ name: "Second" });
      expect((await put(first.id, body({ name: "First" }))).status).toBe(200);
      expect((await put(second.id, body({ name: "Second" }))).status).toBe(200);
      expect(await defaults()).toEqual(["First"]);
    });

    it("never leaves two defaults or none when simultaneous requests each make a different template the default", async () => {
      const ids = [(await create({ name: "A" })).id, (await create({ name: "B" })).id, (await create({ name: "C" })).id, (await create({ name: "D" })).id];
      const results = await Promise.all(ids.map((id, i) => put(id, body({ name: "ABCD"[i], isDefault: true }))));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(await defaults()).toHaveLength(1);
    });

    it("is not fooled by the default changing between the read and the write: the guard refuses, nothing is written", async () => {
      const first = await create({ name: "First" });
      const second = await create({ name: "Second" });
      let ran = false;
      const hooked = {
        prepare: (q: string) => t.env.DB.prepare(q),
        batch: async (statements: D1PreparedStatement[]) => {
          if (!ran) {
            ran = true;
            await t.env.DB.batch([
              t.env.DB.prepare("UPDATE event_templates SET is_default = 0 WHERE id = ?").bind(first.id),
              t.env.DB.prepare("UPDATE event_templates SET is_default = 1 WHERE id = ?").bind(second.id),
            ]);
          }
          return t.env.DB.batch(statements);
        },
      };
      // Read as a non-default, then it becomes the default before the batch: unsetting it must not leave no default.
      const res = await put(second.id, body({ name: "Second renamed", isDefault: false }), { env: { DB: hooked } });
      expect(await fieldsOf(res)).toEqual({ isDefault: "Choose another template as the default instead." });
      expect(await defaults()).toEqual(["Second"]);
      expect((await all()).map((x) => x.name).sort()).toEqual(["First", "Second"]);
    });
  });

  describe("shareMessage", () => {
    it("changes when sent (including to empty), and stays as it is when missing", async () => {
      const made = await create({ shareMessage: "Original" });
      const { shareMessage: _omitted, ...without } = body();
      expect(((await (await put(made.id, { ...without, costPence: 1600 })).json()) as { template: Made }).template).toMatchObject({ shareMessage: "Original", costPence: 1600 });
      expect(((await (await put(made.id, body({ shareMessage: "Changed\r\n{event}" }))).json()) as { template: Made }).template.shareMessage).toBe("Changed\n{event}");
      expect(((await (await put(made.id, body({ shareMessage: "" }))).json()) as { template: Made }).template.shareMessage).toBe("");
    });
  });

  it("answers 404 when the template is deleted between the read and the write, writing nothing", async () => {
    const made = await create();
    const hooked = {
      prepare: (q: string) => t.env.DB.prepare(q),
      batch: async (statements: D1PreparedStatement[]) => {
        await t.env.DB.prepare("DELETE FROM event_templates WHERE id = ?").bind(made.id).run();
        return t.env.DB.batch(statements);
      },
    };
    expect((await put(made.id, body({ name: "Renamed" }), { env: { DB: hooked } })).status).toBe(404);
    expect(await countRows(t.env.DB, "event_templates")).toBe(0);
    expect(await countRows(t.env.DB, "event_template_breaks")).toBe(0);
  });

  it("returns a generic 500, without leaking the cause, when the batch fails", async () => {
    const made = await create();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const hooked = { prepare: (q: string) => t.env.DB.prepare(q), batch: () => Promise.reject(new Error("D1_ERROR: secret detail")) };
      const res = await put(made.id, body(), { env: { DB: hooked } });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("internal_error");
      expect(text).not.toContain("secret");
    } finally {
      error.mockRestore();
    }
  });
});

describe("DELETE /api/admin/templates/:id", () => {
  it("deletes the template and its breaks and says which, no-store", async () => {
    const keep = await create({ name: "Keep" });
    const drop = await create({ name: "Drop", breaks: [{ start: "10:00", end: "10:30" }, { start: "11:00", end: "11:10" }] });
    expect(await countRows(t.env.DB, "event_template_breaks")).toBe(3);
    const res = await del(drop.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ deleted: { id: drop.id, name: "Drop" } });
    expect((await get(drop.id)).status).toBe(404);
    expect((await del(drop.id)).status).toBe(404);
    expect((await all()).map((x) => x.id)).toEqual([keep.id]);
    expect(await countRows(t.env.DB, "event_template_breaks")).toBe(1);
    // Its layout and lane go too; the other template keeps its own.
    expect(await countRows(t.env.DB, "event_template_layout")).toBe(1);
    expect(await countRows(t.env.DB, "event_template_lanes")).toBe(1);
    expect((await t.env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("leaves the default where it is when another template is deleted", async () => {
    await create({ name: "First" });
    const second = await create({ name: "Second" });
    await create({ name: "Third" });
    await del(second.id);
    expect(await defaults()).toEqual(["First"]);
  });

  it("promotes the oldest remaining template when the default is deleted (by creation time, then id)", async () => {
    const a = await create({ name: "A" });
    const b = await create({ name: "B", isDefault: true });
    const c = await create({ name: "C" });
    await t.env.DB.prepare("UPDATE event_templates SET created_at = '2026-01-03T00:00:00Z' WHERE id = ?").bind(a.id).run();
    await t.env.DB.prepare("UPDATE event_templates SET created_at = '2026-01-02T00:00:00Z' WHERE id = ?").bind(b.id).run();
    await t.env.DB.prepare("UPDATE event_templates SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?").bind(c.id).run();
    expect(await defaults()).toEqual(["B"]);
    expect((await del(b.id)).status).toBe(200);
    expect(await defaults()).toEqual(["C"]);
  });

  it("breaks a tie in creation time by id", async () => {
    const a = await create({ name: "A" });
    const b = await create({ name: "B", isDefault: true });
    await create({ name: "C" });
    await t.env.DB.prepare("UPDATE event_templates SET created_at = '2026-01-01T00:00:00Z'").run();
    await del(b.id);
    expect(await defaults()).toEqual(["A"]);
    expect(a.id).toBeGreaterThan(0);
  });

  it("promotes in the same batch: exactly one default straight after, whichever the order", async () => {
    const first = await create({ name: "First" });
    await create({ name: "Second" });
    await create({ name: "Third" });
    await del(first.id);
    expect(await defaults()).toEqual(["Second"]);
    expect(await countRows(t.env.DB, "event_templates")).toBe(2);
  });

  it("leaves no template and no default when the last one goes, and the next one made becomes the default", async () => {
    const only = await create({ name: "Only" });
    expect((await del(only.id)).status).toBe(200);
    expect(await all()).toEqual([]);
    expect((await create({ name: "Fresh", isDefault: false })).isDefault).toBe(true);
  });

  it("deletes a template with no default (an inconsistent database) and heals by promoting the oldest remaining", async () => {
    const a = await insertTemplate(t.env.DB, { name: "A" });
    await insertTemplate(t.env.DB, { name: "B" });
    expect((await del(a.id)).status).toBe(200);
    expect(await defaults()).toEqual(["B"]);
  });
});

describe("templates and events are separate", () => {
  /** Every column and break of every event, to prove template changes never reach them. */
  const eventsSnapshot = async (): Promise<string> => JSON.stringify([
    (await t.env.DB.prepare("SELECT * FROM events ORDER BY id").all()).results,
    (await t.env.DB.prepare("SELECT * FROM breaks ORDER BY id").all()).results,
  ]);

  it("leaves events (and their copies of the share message) untouched by creating, editing, switching the default of and deleting templates", async () => {
    const copy = "Join us at {event}!";
    const e1 = await insertEvent(t.env.DB, { name: "Event one", details: "Same as template", shareMessage: copy });
    await insertBreak(t.env.DB, e1.id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z", "Lunch");
    await insertEvent(t.env.DB, { name: "Event two", shareMessage: "" });
    const before = await eventsSnapshot();

    const a = await create({ name: "A", details: "Same as template", shareMessage: copy });
    const b = await create({ name: "B", shareMessage: copy });
    expect(await eventsSnapshot()).toBe(before);
    expect((await put(a.id, body({ name: "A edited", details: "Different", shareMessage: "Changed", costPence: 1, breaks: [] }))).status).toBe(200);
    expect(await eventsSnapshot()).toBe(before);
    expect((await put(b.id, body({ name: "B", isDefault: true, shareMessage: "Also changed" }))).status).toBe(200);
    expect(await eventsSnapshot()).toBe(before);
    expect((await del(b.id)).status).toBe(200); // the default: promotes A
    expect(await eventsSnapshot()).toBe(before);
    expect((await del(a.id)).status).toBe(200);
    expect(await all()).toEqual([]);
    expect(await eventsSnapshot()).toBe(before);
    const row = await t.env.DB.prepare("SELECT share_message AS m FROM events WHERE id = ?").bind(e1.id).first();
    expect(row).toEqual({ m: copy });
  });

  it("has no template reference on events or breaks", async () => {
    for (const table of ["events", "breaks"]) {
      const { results } = await t.env.DB.prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name LIKE '%template%'`).all();
      expect(results, table).toEqual([]);
    }
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('events')").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("templates: lanes and capacity on update and in a round trip to an event", () => {
  const made = async (over: Record<string, unknown> = {}) => {
    const res = await post(body({ lanes: [{ name: "Ring 1" }, { name: "Ring 2" }], capacity: 2, ...over }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { template: { id: number; lanes: { name: string }[]; capacity: number } }).template;
  };
  const stored = async (id: number) => ({
    lanes: (await t.env.DB.prepare("SELECT name FROM event_template_lanes WHERE template_id = ? ORDER BY position").bind(id).all<{ name: string }>()).results.map((l) => l.name),
    layout: await t.env.DB.prepare("SELECT capacity FROM event_template_layout WHERE template_id = ?").bind(id).first(),
  });

  it("replaces the lanes as a whole and the capacity when sent, and leaves them when not", async () => {
    const tpl = await made();
    expect((await put(tpl.id, body({ lanes: [{ name: "Only" }], capacity: 5 }))).status).toBe(200);
    expect(await stored(tpl.id)).toEqual({ lanes: ["Only"], layout: { capacity: 5 } });
    expect((await put(tpl.id, body({ name: "Renamed" }))).status).toBe(200);
    expect(await stored(tpl.id)).toEqual({ lanes: ["Only"], layout: { capacity: 5 } });
    expect((await put(tpl.id, body({ lanes: [{ name: "Z" }, { name: "Y" }, { name: "X" }] }))).status).toBe(200);
    expect(await stored(tpl.id)).toEqual({ lanes: ["Z", "Y", "X"], layout: { capacity: 5 } });
  });

  it("lets an update keep a lane name and a field label the template already has that today's rules would refuse, and refuses a new one like it", async () => {
    const tpl = await made({ lanes: [{ name: "Ring 1" }, { name: "Ring 2" }], fields: [{ label: "Dog", required: true, maxLength: 80, identity: true }] });
    await t.env.DB.prepare("UPDATE event_template_lanes SET name = ? WHERE template_id = ? AND position = 1").bind("Ring 1\uFE0F", tpl.id).run();
    await t.env.DB.prepare("UPDATE event_template_fields SET label = ? WHERE template_id = ?").bind("Dog\uFE0F", tpl.id).run();
    const fields = [{ label: "Dog\uFE0F", required: true, maxLength: 80, identity: true }];
    expect((await put(tpl.id, body({ lanes: [{ name: "Ring 1\uFE0F" }, { name: "Ring 2" }], fields }))).status).toBe(200);
    const res = await put(tpl.id, body({ lanes: [{ name: "Ring 1\uFE0F" }, { name: "Ring 3\uFE0F" }], fields: [{ ...fields[0], label: "Hors\uFE0F" }] }));
    expect(Object.keys(await fieldsOf(res)).sort()).toEqual(["fields.0.label", "lanes.1.name"]);
  });

  describe("the 2000 places rule uses what an update leaves alone (the template's stored lanes or capacity)", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Ring ${i + 1}` }));
    // The test template has 10 slots (09:00 to 12:00, quarter hours, a break at 10:00 to 10:30).
    it("refuses new lanes alone that, with the stored capacity, make more than 2000 places, and changes nothing", async () => {
      const tpl = await made({ lanes: names(4), capacity: 50 }); // 10 x 4 x 50 = 2000
      const before = await stored(tpl.id);
      const res = await put(tpl.id, body({ lanes: names(5) })); // 10 x 5 x 50 = 2500
      expect(await fieldsOf(res)).toEqual({ lanes: expect.stringContaining("2500 places") });
      expect(await stored(tpl.id)).toEqual(before);
      expect((await put(tpl.id, body({ lanes: names(4) }))).status).toBe(200);
    });

    it("refuses a capacity alone that, with the stored lanes, makes more than 2000 places, and changes nothing", async () => {
      const tpl = await made({ lanes: names(10), capacity: 1 });
      const before = await stored(tpl.id);
      const res = await put(tpl.id, body({ capacity: 21 })); // 10 x 10 x 21 = 2100
      expect(await fieldsOf(res)).toEqual({ capacity: expect.stringContaining("2100 places") });
      expect(await stored(tpl.id)).toEqual(before);
      expect((await put(tpl.id, body({ capacity: 20 }))).status).toBe(200);
    });

    it("counts one lane for a template that has no lane rows", async () => {
      const { id } = await insertTemplate(t.env.DB);
      await t.env.DB.prepare("DELETE FROM event_template_lanes WHERE template_id = ?").bind(id).run();
      expect((await put(id, body({ capacity: 50 }))).status).toBe(200); // 10 x 1 x 50
      expect(await fieldsOf(await put(id, body({ lanes: names(5) })))).toEqual({ lanes: expect.stringContaining("2500 places") });
    });

    it("answers 404, not a places error, for a template that does not exist", async () => {
      expect((await put(999_999, body({ capacity: 50 }))).status).toBe(404);
    });
  });

  it("refuses bad lanes on update with field errors and changes nothing", async () => {
    const tpl = await made();
    const res = await put(tpl.id, body({ name: "Changed", lanes: [{ name: "A" }, { name: "" }], capacity: 51 }));
    expect(res.status).toBe(400);
    expect(await stored(tpl.id)).toEqual({ lanes: ["Ring 1", "Ring 2"], layout: { capacity: 2 } });
  });

  it("recreates a template's layout row if a hand-made template has none (an update with capacity)", async () => {
    const { id } = await insertTemplate(t.env.DB);
    await t.env.DB.prepare("DELETE FROM event_template_layout WHERE template_id = ?").bind(id).run();
    expect((await put(id, body({ name: "Hand made", capacity: 3 }))).status).toBe(200);
    expect(await stored(id)).toMatchObject({ layout: { capacity: 3 } });
  });

  it("reads a template with no field rows as the Dog and Handler form", async () => {
    const { id } = await insertTemplate(t.env.DB);
    await t.env.DB.prepare("DELETE FROM event_template_fields WHERE template_id = ?").bind(id).run();
    expect(((await (await get(id)).json()) as { template: { fields: unknown } }).template.fields).toEqual([
      { label: "Dog", required: true, maxLength: 80, identity: true }, { label: "Handler", required: true, maxLength: 80, identity: true },
    ]);
  });

  it("reads a template with no lane or layout rows as one unnamed lane and capacity 1", async () => {
    const { id } = await insertTemplate(t.env.DB);
    await t.env.DB.prepare("DELETE FROM event_template_lanes WHERE template_id = ?").bind(id).run();
    await t.env.DB.prepare("DELETE FROM event_template_layout WHERE template_id = ?").bind(id).run();
    expect(((await (await get(id)).json()) as { template: unknown }).template).toMatchObject({ lanes: [{ name: "" }], capacity: 1 });
  });

  it("round trip: an event created from a template's lanes and capacity has its own copy, which a later template edit doesn't touch", async () => {
    const tpl = await made();
    const fetched = ((await (await get(tpl.id)).json()) as { template: { lanes: { name: string }[]; capacity: number } }).template;
    const res = await createEventRoute({
      request: new Request("http://localhost/api/admin/events", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "template-trip-aaaaaaaa", name: "From template", date: FUTURE_DATE, start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 0,
          costPence: 0, venuePostcode: "AB1 2CD", details: "", breaks: [], lanes: fetched.lanes, capacity: fetched.capacity,
        }),
      }),
      env: t.env, data: ADMIN,
    } as unknown as Parameters<typeof createEventRoute>[0]);
    expect(res.status).toBe(201);
    const event = ((await res.json()) as { event: { slug: string; lanes: { name: string }[]; capacity: number } }).event;
    expect(event.lanes.map((l) => l.name)).toEqual(["Ring 1", "Ring 2"]);
    expect(event.capacity).toBe(2);
    expect((await put(tpl.id, body({ lanes: [{ name: "Changed" }], capacity: 9 }))).status).toBe(200);
    const row = await t.env.DB.prepare("SELECT (SELECT COUNT(*) FROM event_lanes WHERE event_id = e.id) AS lanes, (SELECT capacity FROM event_layout WHERE event_id = e.id) AS capacity FROM events e WHERE slug = ?").bind(event.slug).first();
    expect(row).toEqual({ lanes: 2, capacity: 2 });
  });
});

describe("templates: the booking form's fields on update and in a round trip to an event", () => {
  const F = (label: string, over: Record<string, unknown> = {}) => ({ label, required: true, maxLength: 80, identity: false, ...over });
  const RIDER_PONY = [F("Rider", { identity: true }), F("Pony", { identity: true, maxLength: 30 }), F("Phone", { required: false, maxLength: 12 })];
  const made = async (over: Record<string, unknown> = {}) => {
    const res = await post(body({ fields: RIDER_PONY, identityLimit: 2, ...over }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { template: { id: number; fields: unknown[]; identityLimit: number } }).template;
  };
  const stored = async (id: number) => ({
    fields: (await t.env.DB.prepare("SELECT label, required, max_length, in_identity FROM event_template_fields WHERE template_id = ? ORDER BY position").bind(id).all<{ label: string }>()).results.map((f) => f.label),
    limit: (await t.env.DB.prepare("SELECT identity_limit, capacity FROM event_template_layout WHERE template_id = ?").bind(id).first<{ identity_limit: number; capacity: number }>()),
  });

  it("replaces the fields as a whole and the limit when sent, and leaves them when not (and the capacity alone leaves the limit)", async () => {
    const tpl = await made();
    expect((await put(tpl.id, body({ fields: [F("Car reg", { identity: true })], identityLimit: 5 }))).status).toBe(200);
    expect(await stored(tpl.id)).toEqual({ fields: ["Car reg"], limit: { identity_limit: 5, capacity: 1 } });
    expect((await put(tpl.id, body({ name: "Renamed" }))).status).toBe(200);
    expect(await stored(tpl.id)).toEqual({ fields: ["Car reg"], limit: { identity_limit: 5, capacity: 1 } });
    expect((await put(tpl.id, body({ capacity: 3 }))).status).toBe(200);
    expect(await stored(tpl.id)).toEqual({ fields: ["Car reg"], limit: { identity_limit: 5, capacity: 3 } });
    expect((await put(tpl.id, body({ identityLimit: 1, fields: [F("B", { identity: true }), F("A")] }))).status).toBe(200);
    expect(await stored(tpl.id)).toEqual({ fields: ["B", "A"], limit: { identity_limit: 1, capacity: 3 } });
    expect(((await (await get(tpl.id)).json()) as { template: { fields: unknown } }).template.fields).toEqual([F("B", { identity: true }), F("A")]);
  });

  it("swaps two labels on update without meeting the unique label index half-way", async () => {
    const tpl = await made({ fields: [F("A", { identity: true }), F("B")] });
    expect((await put(tpl.id, body({ fields: [F("B", { identity: true }), F("A")] }))).status).toBe(200);
    expect((await stored(tpl.id)).fields).toEqual(["B", "A"]);
  });

  it("refuses bad fields on update with field errors and changes nothing", async () => {
    const tpl = await made();
    const res = await put(tpl.id, body({ name: "Changed", fields: [F("A"), F("a")], identityLimit: 99 }));
    expect(res.status).toBe(400);
    expect(await stored(tpl.id)).toEqual({ fields: ["Rider", "Pony", "Phone"], limit: { identity_limit: 2, capacity: 1 } });
  });

  it("recreates a template's layout row if a hand-made template has none (an update with the limit)", async () => {
    const { id } = await insertTemplate(t.env.DB);
    await t.env.DB.prepare("DELETE FROM event_template_layout WHERE template_id = ?").bind(id).run();
    expect((await put(id, body({ name: "Hand made", identityLimit: 4 }))).status).toBe(200);
    expect((await stored(id)).limit).toEqual({ identity_limit: 4, capacity: 1 });
  });

  it("round trip: an event created from a template's fields and limit has its own copy, which a later template edit doesn't touch", async () => {
    const tpl = await made();
    const fetched = ((await (await get(tpl.id)).json()) as { template: { fields: unknown[]; identityLimit: number } }).template;
    const res = await createEventRoute({
      request: new Request("http://localhost/api/admin/events", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "template-fields-aaaaaaaa", name: "From template", date: FUTURE_DATE, start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 0,
          costPence: 0, venuePostcode: "AB1 2CD", details: "", breaks: [], fields: fetched.fields, identityLimit: fetched.identityLimit,
        }),
      }),
      env: t.env, data: ADMIN,
    } as unknown as Parameters<typeof createEventRoute>[0]);
    expect(res.status).toBe(201);
    const event = ((await res.json()) as { event: { slug: string; fields: unknown[]; identityLimit: number } }).event;
    expect(event.fields).toEqual(RIDER_PONY);
    expect(event.identityLimit).toBe(2);
    expect((await put(tpl.id, body({ fields: [F("Changed", { identity: true })], identityLimit: 9 }))).status).toBe(200);
    const row = await t.env.DB.prepare(
      `SELECT (SELECT group_concat(label, '|') FROM (SELECT label FROM event_fields WHERE event_id = e.id ORDER BY position)) AS labels,
              (SELECT identity_limit FROM event_layout WHERE event_id = e.id) AS identity_limit FROM events e WHERE slug = ?`,
    ).bind(event.slug).first();
    expect(row).toEqual({ labels: "Rider|Pony|Phone", identity_limit: 2 });
  });
});

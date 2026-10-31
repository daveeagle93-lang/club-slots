import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { countRows, createTestEnv, insertTemplate, type TestEnv } from "../../../../test/db";
import { createTemplate, parseTemplateDraft } from "../../../../server/admin-templates";
import { onRequestGet, onRequestPost } from "./index";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
beforeEach(async () => { await t.env.DB.prepare("DELETE FROM event_templates").run(); });
afterAll(async () => { await t.dispose(); });

interface PostOptions { contentType?: string | null; raw?: string; data?: unknown; env?: unknown }

const post = (body: unknown, o: PostOptions = {}): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  return Promise.resolve(
    onRequestPost({
      request: new Request("http://localhost/api/admin/templates", { method: "POST", headers, body: o.raw ?? JSON.stringify(body) }),
      env: o.env ?? t.env,
      data: "data" in o ? o.data : ADMIN,
    } as unknown as Parameters<typeof onRequestPost>[0]),
  );
};

/** Pass a second argument (even undefined) to replace the admin data. */
const list = (...data: unknown[]): Promise<Response> =>
  Promise.resolve(
    onRequestGet({
      request: new Request("http://localhost/api/admin/templates"), env: t.env, data: data.length > 0 ? data[0] : ADMIN,
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );

const body = (over: Record<string, unknown> = {}) => ({
  name: "Saturday trial", details: "Bring water", venuePostcode: "ab1  2cd", costPence: 1500, start: "09:00", end: "12:00",
  sessionMinutes: 15, gapMinutes: 0, breaks: [{ start: "10:00", end: "10:30", label: "Lunch" }], shareMessage: "Book {event}", ...over,
});

interface Made {
  id: number; name: string; isDefault: boolean; details: string; venuePostcode: string; costPence: number; start: string; end: string;
  sessionMinutes: number; gapMinutes: number; breaks: { start: string; end: string; label: string }[]; shareMessage: string;
  lanes: { name: string }[]; capacity: number;
}
const listed = async (): Promise<Made[]> => ((await (await list()).json()) as { templates: Made[] }).templates;
const defaults = async (): Promise<string[]> => (await listed()).filter((x) => x.isDefault).map((x) => x.name);
const create = async (over: Record<string, unknown> = {}): Promise<Made> => {
  const res = await post(body(over));
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return ((await res.json()) as { template: Made }).template;
};
const fieldsOf = async (res: Response): Promise<Record<string, string>> => {
  expect(res.status).toBe(400);
  const json = (await res.json()) as { error: { code: string; message: string }; fields: Record<string, string> };
  expect(json.error).toEqual({ code: "invalid_input", message: "Check the highlighted fields." });
  return json.fields;
};
const INVISIBLE = (what: string) =>
  `The ${what} can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.`;

describe("GET /api/admin/templates", () => {
  it("is an empty list with no templates, no-store", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ templates: [] });
  });

  it("lists the default first, then the rest by name ignoring case, each with its own breaks in start order", async () => {
    await create({ name: "Zebra", breaks: [] });
    await create({ name: "beta", breaks: [{ start: "11:00", end: "11:10" }, { start: "10:00", end: "10:30", label: "Lunch" }] });
    await create({ name: "Alpha", breaks: [{ start: "10:00", end: "10:15" }] });
    await create({ name: "Mid default", isDefault: true, breaks: [] });
    const all = await listed();
    expect(all.map((x) => [x.name, x.isDefault])).toEqual([["Mid default", true], ["Alpha", false], ["beta", false], ["Zebra", false]]);
    expect(all.map((x) => x.breaks)).toEqual([
      [], [{ start: "10:00", end: "10:15", label: "" }],
      [{ start: "10:00", end: "10:30", label: "Lunch" }, { start: "11:00", end: "11:10", label: "" }], [],
    ]);
  });

  it("refuses with 401 unless the guard set an admin identity", async () => {
    for (const data of [undefined, {}, { admin: {} }, { admin: { identity: "" } }]) {
      const res = await list(data);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("POST /api/admin/templates", () => {
  it("creates the template and its breaks: 201, no-store, tidied, with the shape the front end uses", async () => {
    const res = await post(body());
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      template: {
        id: expect.any(Number), name: "Saturday trial", isDefault: true, details: "Bring water", venuePostcode: "AB1 2CD", costPence: 1500,
        start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 0, breaks: [{ start: "10:00", end: "10:30", label: "Lunch" }],
        shareMessage: "Book {event}", lanes: [{ name: "" }], capacity: 1,
        fields: [{ label: "Name", required: true, maxLength: 80, identity: true }], identityLimit: 1,
      },
    });
    expect(await listed()).toHaveLength(1);
  });

  it("stores London local HH:MM as written (no clock conversion), and the breaks sorted by start", async () => {
    const made = await create({ breaks: [{ start: "11:00", end: "11:10" }, { start: "10:00", end: "10:30", label: "Lunch" }, { start: "10:00", end: "10:15" }] });
    expect(made.breaks).toEqual([
      { start: "10:00", end: "10:15", label: "" }, { start: "10:00", end: "10:30", label: "Lunch" }, { start: "11:00", end: "11:10", label: "" },
    ]);
    const row = await t.env.DB.prepare("SELECT start_time, end_time FROM event_templates WHERE id = ?").bind(made.id).first();
    expect(row).toEqual({ start_time: "09:00", end_time: "12:00" });
    const { results } = await t.env.DB.prepare("SELECT start_time, end_time, label FROM event_template_breaks WHERE template_id = ? ORDER BY id").bind(made.id).all();
    expect(results).toEqual([
      { start_time: "10:00", end_time: "10:15", label: "" }, { start_time: "10:00", end_time: "10:30", label: "Lunch" }, { start_time: "11:00", end_time: "11:10", label: "" },
    ]);
  });

  it("stores no message when the request has none, and the message with \\r\\n as \\n", async () => {
    const { shareMessage: _omitted, ...without } = body();
    const a = ((await (await post({ ...without, name: "A" })).json()) as { template: Made }).template;
    expect(a.shareMessage).toBe("");
    expect((await create({ name: "B", shareMessage: "one\r\ntwo {event}" })).shareMessage).toBe("one\ntwo {event}");
  });

  it("ignores unknown and extra fields, and a date, which a template doesn't have", async () => {
    const made = await create({ id: 99, createdAt: "x", listed: "nope", date: "not a date", idempotencyKey: "k", extra: { a: 1 } });
    expect(made.id).not.toBe(99);
    expect(Object.keys(made).sort()).toEqual([
      "breaks", "capacity", "costPence", "details", "end", "fields", "gapMinutes", "id", "identityLimit", "isDefault", "lanes", "name", "sessionMinutes", "shareMessage", "start", "venuePostcode",
    ]);
  });

  it("accepts the limits: 60-character name, 2000 details, 1000 message, cost 0 and 100000, 20 breaks", async () => {
    const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const breaks = Array.from({ length: 20 }, (_, i) => ({ start: hhmm(540 + i * 8), end: hhmm(545 + i * 8) }));
    const made = await create({ name: "n".repeat(60), details: "d".repeat(2000), shareMessage: "m".repeat(1000), costPence: 100000, breaks, sessionMinutes: 5 });
    expect(made.breaks).toHaveLength(20);
    expect((await create({ name: "\u{1F415}".repeat(60), costPence: 0 })).costPence).toBe(0);
  });

  describe("the name", () => {
    it("is trimmed, and a missing, non-text, blank or over-long one is refused under `name`", async () => {
      expect((await create({ name: "  Padded  " })).name).toBe("Padded");
      const { name: _omitted, ...without } = body();
      expect(await fieldsOf(await post(without))).toEqual({ name: "Enter the template name." });
      for (const name of [5, null, "", "   "]) expect(await fieldsOf(await post(body({ name }))), JSON.stringify(name)).toEqual({ name: "Enter the template name." });
      expect(await fieldsOf(await post(body({ name: "x".repeat(61) })))).toEqual({ name: "The template name must be at most 60 characters." });
      expect(await fieldsOf(await post(body({ name: "\u{1F415}".repeat(61) })))).toEqual({ name: "The template name must be at most 60 characters." });
    });

    it("refuses invisible characters, line separators, control characters and unpaired surrogates", async () => {
      expect(await fieldsOf(await post(body({ name: "A‍b" })))).toEqual({ name: INVISIBLE("template name") });
      expect(await fieldsOf(await post(body({ name: "A‮b" })))).toEqual({ name: INVISIBLE("template name") });
      expect(await fieldsOf(await post(body({ name: "A b" })))).toEqual({ name: "The template name can't contain line or paragraph separators." });
      expect(await fieldsOf(await post(body({ name: "A\u0007b" })))).toEqual({ name: "The template name can't contain control characters." });
      expect(await fieldsOf(await post(body({ name: "A\uD800" })))).toEqual({ name: "The template name can't contain unpaired surrogate characters." });
      expect(await countRows(t.env.DB, "event_templates")).toBe(0);
    });

    it("must be unique ignoring case and surrounding spaces: a clash is a field error on `name`, writing nothing", async () => {
      await create({ name: "Saturday" });
      await create({ name: "Sunday", breaks: [] });
      for (const name of ["Saturday", "SATURDAY", "saturday", "  sAtUrDaY  "]) {
        expect(await fieldsOf(await post(body({ name, isDefault: true }))), name).toEqual({ name: "There is already a template with that name." });
      }
      expect(await countRows(t.env.DB, "event_templates")).toBe(2);
      expect(await countRows(t.env.DB, "event_template_breaks")).toBe(1);
      expect(await defaults()).toEqual(["Saturday"]); // the refused request's isDefault did not clear the default
    });
  });

  // [what, body override, the fields the one validation path reports]
  it.each([
    ["a missing start", { start: undefined }, { start: "Enter a time as HH:MM." }],
    ["a start that isn't HH:MM", { start: "9:00" }, { start: "Enter a time as HH:MM." }],
    ["a start of 24:00", { start: "24:00" }, { start: "Enter a time as HH:MM." }],
    ["a start that is a number", { start: 900 }, { start: "Enter a time as HH:MM." }],
    ["an end that isn't a time", { end: "noon" }, { end: "Enter a time as HH:MM." }],
    ["an end at the start", { end: "09:00", breaks: [] }, { end: "The end must be after the start." }],
    ["an end before the start", { end: "08:00", breaks: [] }, { end: "The end must be after the start." }],
    ["a session of 0 minutes", { sessionMinutes: 0 }, { sessionMinutes: "Enter a whole number of minutes from 1 to 480." }],
    ["a session of 481 minutes", { sessionMinutes: 481 }, { sessionMinutes: "Enter a whole number of minutes from 1 to 480." }],
    ["a session of 1.5 minutes", { sessionMinutes: 1.5 }, { sessionMinutes: "Enter a whole number of minutes from 1 to 480." }],
    ["a session given as text", { sessionMinutes: "15" }, { sessionMinutes: "Enter a whole number of minutes from 1 to 480." }],
    ["a gap of -1 minutes", { gapMinutes: -1 }, { gapMinutes: "Enter a whole number of minutes from 0 to 120." }],
    ["a gap of 121 minutes", { gapMinutes: 121 }, { gapMinutes: "Enter a whole number of minutes from 0 to 120." }],
    ["a missing gap", { gapMinutes: undefined }, { gapMinutes: "Enter a whole number of minutes from 0 to 120." }],
    ["a negative cost", { costPence: -1 }, { costPence: "Enter the cost in pence as a whole number from 0 to 100000." }],
    ["a cost over 100000", { costPence: 100001 }, { costPence: "Enter the cost in pence as a whole number from 0 to 100000." }],
    ["a fractional cost", { costPence: 12.5 }, { costPence: "Enter the cost in pence as a whole number from 0 to 100000." }],
    ["a missing postcode", { venuePostcode: undefined }, { venuePostcode: "Enter a venue postcode of 2 to 10 letters and numbers." }],
    ["a one-letter postcode", { venuePostcode: "A" }, { venuePostcode: "Enter a venue postcode of 2 to 10 letters and numbers." }],
    ["a postcode with punctuation", { venuePostcode: "AB1-2CD" }, { venuePostcode: "Enter a venue postcode of 2 to 10 letters and numbers." }],
    ["an eleven-character postcode", { venuePostcode: "A".repeat(11) }, { venuePostcode: "Enter a venue postcode of 2 to 10 letters and numbers." }],
    ["details that are not text", { details: 5 }, { details: "Details must be text (they can be empty)." }],
    ["missing details", { details: undefined }, { details: "Details must be text (they can be empty)." }],
    ["details over 2000 characters", { details: "d".repeat(2001) }, { details: "The details must be at most 2000 characters." }],
    ["details with an invisible character", { details: "a‍b" }, { details: INVISIBLE("details") }],
    ["details with a line separator", { details: "a b" }, { details: "The details can't contain line or paragraph separators." }],
    ["a share message that is not text", { shareMessage: 5 }, { shareMessage: "The share message must be text (it can be empty)." }],
    ["a null share message", { shareMessage: null }, { shareMessage: "The share message must be text (it can be empty)." }],
    ["a share message over 1000 characters", { shareMessage: "m".repeat(1001) }, { shareMessage: "The share message must be at most 1000 characters." }],
    ["a share message with an invisible character", { shareMessage: "a‮b" }, { shareMessage: INVISIBLE("share message") }],
    ["a share message with a line separator", { shareMessage: "a b" }, { shareMessage: "The share message can't contain line or paragraph separators." }],
    ["a share message with a control character", { shareMessage: "a\u0000b" }, { shareMessage: "The share message can't contain control characters." }],
    ["a share message with an unpaired surrogate", { shareMessage: "a\uDC00" }, { shareMessage: "The share message can't contain unpaired surrogate characters." }],
    ["isDefault as text", { isDefault: "yes" }, { isDefault: "Default must be true or false." }],
    ["isDefault as null", { isDefault: null }, { isDefault: "Default must be true or false." }],
    ["breaks that aren't a list", { breaks: "none" }, { breaks: "Breaks must be a list." }],
    ["missing breaks", { breaks: undefined }, { breaks: "Breaks must be a list." }],
    ["21 breaks", { breaks: Array.from({ length: 21 }, () => ({ start: "10:00", end: "10:05" })) }, { breaks: "You can add at most 20 breaks." }],
    ["a break that isn't an object", { breaks: ["lunch"] }, { "breaks.0": "Each break needs a start and an end." }],
    ["a break with no start", { breaks: [{ end: "10:30" }] }, { "breaks.0.start": "Enter a time as HH:MM." }],
    ["a break with a bad end", { breaks: [{ start: "10:00", end: "10:60" }] }, { "breaks.0.end": "Enter a time as HH:MM." }],
    ["a break that ends before it starts", { breaks: [{ start: "10:30", end: "10:00" }] }, { "breaks.0.end": "The break must end after it starts." }],
    ["a break starting before the event", { breaks: [{ start: "08:30", end: "09:30" }] }, { "breaks.0.start": "The break must start within the event." }],
    ["a break ending after the event", { breaks: [{ start: "11:30", end: "12:30" }] }, { "breaks.0.end": "The break must end within the event." }],
    ["a second break that is bad", { breaks: [{ start: "10:00", end: "10:30" }, { start: "11:00", end: "10:00" }] }, { "breaks.1.end": "The break must end after it starts." }],
    ["a break name over 40 characters", { breaks: [{ start: "10:00", end: "10:30", label: "l".repeat(41) }] }, { "breaks.0.label": "The break name must be at most 40 characters." }],
    ["a break name that is a number", { breaks: [{ start: "10:00", end: "10:30", label: 5 }] }, { "breaks.0.label": "The break name must be text." }],
    ["a break name with an invisible character", { breaks: [{ start: "10:00", end: "10:30", label: "a‍b" }] }, { "breaks.0.label": INVISIBLE("break name") }],
    ["a break name with a line separator", { breaks: [{ start: "10:00", end: "10:30", label: "a b" }] }, { "breaks.0.label": "The break name can't contain line or paragraph separators." }],
    ["a break name with a control character", { breaks: [{ start: "10:00", end: "10:30", label: "a\u0007" }] }, { "breaks.0.label": "The break name can't contain control characters." }],
    ["no session fitting between start and end", { start: "09:00", end: "09:10", breaks: [] }, { end: "No sessions fit between the start and end." }],
    ["more than 500 slots", { start: "00:00", end: "23:59", sessionMinutes: 1, breaks: [] }, { sessionMinutes: "That would make more than 500 slots." }],
  ])("refuses %s, writing nothing", async (_what, over, fields) => {
    expect(await fieldsOf(await post(body(over)))).toEqual(fields);
    expect(await countRows(t.env.DB, "event_templates")).toBe(0);
    expect(await countRows(t.env.DB, "event_template_breaks")).toBe(0);
  });

  it("reports every field error together, name included", async () => {
    const fields = await fieldsOf(await post(body({ name: "", start: "x", costPence: -1, shareMessage: 3, isDefault: 1, breaks: [{ start: "10:30", end: "10:00" }] })));
    expect(fields).toEqual({
      name: "Enter the template name.", start: "Enter a time as HH:MM.", costPence: "Enter the cost in pence as a whole number from 0 to 100000.",
      shareMessage: "The share message must be text (it can be empty).", isDefault: "Default must be true or false.",
      "breaks.0.end": "The break must end after it starts.",
    });
  });

  it("checks the times as a day with no clock change, whatever today's date: 01:30 to 02:30 is accepted", async () => {
    const made = await create({ start: "01:30", end: "02:30", breaks: [{ start: "01:45", end: "02:00" }] });
    expect([made.start, made.end]).toEqual(["01:30", "02:30"]);
  });

  it("returns 415, 400 and 413 for bad bodies, writing nothing", async () => {
    expect((await post(body(), { contentType: "text/plain" })).status).toBe(415);
    expect((await post(undefined, { raw: "{nope" })).status).toBe(400);
    expect((await post(undefined, { raw: "[]" })).status).toBe(400);
    const res = await post({ ...body(), padding: "x".repeat(32768) });
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await countRows(t.env.DB, "event_templates")).toBe(0);
  });

  it("refuses with 401 unless the guard set an admin identity, writing nothing", async () => {
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await post(body(), { data });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await countRows(t.env.DB, "event_templates")).toBe(0);
  });

  it("returns a generic 500, without leaking the cause, when the batch fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const db = { batch: () => Promise.reject(new Error("D1_ERROR: secret detail")), prepare: () => ({ bind: () => ({}) }) };
      const res = await post(body(), { env: { DB: db } });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("internal_error");
      expect(text).not.toContain("secret");
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe("POST /api/admin/templates: layout", () => {
  it("stores the template's layout (capacity 1, identity limit 1) and one unnamed lane with it, and none when the create is refused", async () => {
    const made = await create();
    expect((await t.env.DB.prepare("SELECT capacity, identity_limit FROM event_template_layout WHERE template_id = ?").bind(made.id).all()).results).toEqual([{ capacity: 1, identity_limit: 1 }]);
    expect((await t.env.DB.prepare("SELECT position, name FROM event_template_lanes WHERE template_id = ?").bind(made.id).all()).results).toEqual([{ position: 1, name: "" }]);
    expect((await post(body({ name: made.name.toUpperCase() }))).status, "a duplicate name is a field error").toBe(400);
    expect(await countRows(t.env.DB, "event_template_layout")).toBe(1);
    expect(await countRows(t.env.DB, "event_template_lanes")).toBe(1);
  });
});

describe("POST /api/admin/templates: the default", () => {
  it("makes the first template ever the default, even when it says isDefault: false", async () => {
    expect((await create({ name: "First", isDefault: false })).isDefault).toBe(true);
    expect((await create({ name: "Second" })).isDefault).toBe(false);
    expect((await create({ name: "Third", isDefault: false })).isDefault).toBe(false);
    expect(await defaults()).toEqual(["First"]);
  });

  it("makes a later template the only default when it asks, in one step", async () => {
    await create({ name: "First" });
    await create({ name: "Second" });
    const third = await create({ name: "Third", isDefault: true });
    expect(third.isDefault).toBe(true);
    expect(await defaults()).toEqual(["Third"]);
    expect((await listed()).map((x) => x.name)).toEqual(["Third", "First", "Second"]);
  });

  it("makes a template the default when it is created while none is (the database holds none)", async () => {
    const orphan = await insertTemplate(t.env.DB, { name: "Orphan" });
    expect(await defaults()).toEqual([]);
    expect((await create({ name: "Next" })).isDefault).toBe(true);
    expect(await defaults()).toEqual(["Next"]);
    expect(orphan.id).toBeGreaterThan(0);
  });

  it("starts again from the first-ever rule after every template is deleted", async () => {
    const only = await create({ name: "Only" });
    await t.env.DB.prepare("DELETE FROM event_templates WHERE id = ?").bind(only.id).run();
    expect((await create({ name: "Again", isDefault: false })).isDefault).toBe(true);
  });

  it("never leaves two defaults or none when simultaneous requests all ask for the default", async () => {
    await create({ name: "First" });
    const results = await Promise.all(["A", "B", "C", "D"].map((name) => post(body({ name, isDefault: true, breaks: [] }))));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(await defaults()).toHaveLength(1);
    expect(await countRows(t.env.DB, "event_templates")).toBe(5);
  });
});

describe("POST /api/admin/templates: at most 20", () => {
  const fill = async (n: number) => { for (let i = 0; i < n; i++) await insertTemplate(t.env.DB, { name: `T${i}`, isDefault: i === 0 }); };

  it("accepts the 20th and refuses the 21st with 422 template_limit, writing nothing", async () => {
    await fill(19);
    expect((await post(body())).status).toBe(201);
    const events = await countRows(t.env.DB, "event_templates");
    const res = await post(body({ name: "One too many", isDefault: true }));
    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "template_limit", message: "You can have at most 20 templates. Delete one to add another." } });
    expect(await countRows(t.env.DB, "event_templates")).toBe(events);
    expect(await defaults()).toEqual(["T0"]); // the refused request's isDefault did not clear the default
  });

  it("lets one more in once a template is deleted", async () => {
    await fill(20);
    expect((await post(body())).status).toBe(422);
    await t.env.DB.prepare("DELETE FROM event_templates WHERE name = 'T5'").run();
    expect((await post(body())).status).toBe(201);
  });

  it("lets only one of two simultaneous requests take the last place", async () => {
    await fill(19);
    const results = await Promise.all([post(body({ name: "X" })), post(body({ name: "Y" }))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await countRows(t.env.DB, "event_templates")).toBe(20);
  });
});

describe("templates: lanes and capacity", () => {
  it("stores the lanes in order and the capacity, and the list and the stored rows show them", async () => {
    const made = await create({ lanes: [{ name: "Ring 2" }, { name: "Ring 1" }], capacity: 4 });
    expect(made).toMatchObject({ lanes: [{ name: "Ring 2" }, { name: "Ring 1" }], capacity: 4 });
    expect((await listed())[0]).toMatchObject({ lanes: [{ name: "Ring 2" }, { name: "Ring 1" }], capacity: 4 });
    expect((await t.env.DB.prepare("SELECT position, name FROM event_template_lanes WHERE template_id = ? ORDER BY position").bind(made.id).all()).results)
      .toEqual([{ position: 1, name: "Ring 2" }, { position: 2, name: "Ring 1" }]);
    expect(await t.env.DB.prepare("SELECT capacity, identity_limit FROM event_template_layout WHERE template_id = ?").bind(made.id).first()).toEqual({ capacity: 4, identity_limit: 1 });
  });

  it("makes one unnamed lane and capacity 1 when the body says nothing", async () => {
    expect(await create()).toMatchObject({ lanes: [{ name: "" }], capacity: 1 });
  });

  it("validates through the event's rules: the same keys and messages, lane ids refused, places checked against the template's slots", async () => {
    expect(await fieldsOf(await post(body({ lanes: [{ name: "A" }, { name: "a" }, { id: 4, name: "C" }], capacity: 0 })))).toEqual({
      capacity: "Enter a whole number of places from 1 to 50.", "lanes.1.name": "Two lanes can't have the same name.", "lanes.2.id": "A new event's lanes don't have an id.",
    });
    expect(await fieldsOf(await post(body({ lanes: [] })))).toEqual({ lanes: "An event needs at least one lane." });
    expect(await fieldsOf(await post(body({ lanes: [{ name: "Ri\u200Bng" }] })))).toEqual({ "lanes.0.name": INVISIBLE("lane name") });
    expect(await fieldsOf(await post(body({ start: "09:00", end: "18:00", sessionMinutes: 5, breaks: [], capacity: 19 })))).toEqual({ capacity: expect.stringContaining("2052 places") });
    expect(await countRows(t.env.DB, "event_templates")).toBe(0);
  });

  it("is atomic: nothing is left of a template whose lanes the database refuses (validation bypassed)", async () => {
    const parsed = parseTemplateDraft(body({ lanes: [{ name: "A" }, { name: "B" }] }));
    if (!("draft" in parsed)) throw new Error("rejected");
    await createTemplate(t.env.DB, { ...parsed.draft, lanes: [{ name: "A" }, { name: "a" }] });
    expect([await countRows(t.env.DB, "event_templates"), await countRows(t.env.DB, "event_template_lanes"), await countRows(t.env.DB, "event_template_layout")]).toEqual([0, 0, 0]);
  });
});

describe("templates: the booking form's fields and the identity limit", () => {
  const F = (label: string, over: Record<string, unknown> = {}) => ({ label, required: true, maxLength: 80, identity: false, ...over });
  const RIDER_PONY = [F("Rider", { identity: true }), F("Pony", { identity: true, maxLength: 30 }), F("Phone", { required: false, maxLength: 12 })];

  it("stores the fields in order and the identity limit, and the list and the stored rows show them", async () => {
    const made = await create({ fields: RIDER_PONY, identityLimit: 3 });
    expect(made).toMatchObject({ fields: RIDER_PONY, identityLimit: 3 });
    expect((await listed())[0]).toMatchObject({ fields: RIDER_PONY, identityLimit: 3 });
    expect((await t.env.DB.prepare("SELECT position, label, required, max_length, in_identity FROM event_template_fields WHERE template_id = ? ORDER BY position").bind(made.id).all()).results).toEqual([
      { position: 1, label: "Rider", required: 1, max_length: 80, in_identity: 1 },
      { position: 2, label: "Pony", required: 1, max_length: 30, in_identity: 1 },
      { position: 3, label: "Phone", required: 0, max_length: 12, in_identity: 0 },
    ]);
    expect(await t.env.DB.prepare("SELECT capacity, identity_limit FROM event_template_layout WHERE template_id = ?").bind(made.id).first()).toEqual({ capacity: 1, identity_limit: 3 });
  });

  it("makes one required field, Name, that identifies a booking, and identity limit 1, when the body says nothing", async () => {
    expect(await create()).toMatchObject({ fields: [{ label: "Name", required: true, maxLength: 80, identity: true }], identityLimit: 1 });
  });

  it("validates through the event's rules: the same keys and messages", async () => {
    expect(await fieldsOf(await post(body({ fields: [F("Dog", { identity: true }), F("dog", { required: false, identity: true })], identityLimit: 0 })))).toEqual({
      "fields.1.label": "Two fields can't have the same label.", "fields.1.required": "A field that identifies a booking must be required.",
      identityLimit: "Enter a whole number of bookings from 1 to 20.",
    });
    expect(await fieldsOf(await post(body({ fields: [] })))).toEqual({ fields: "A booking form needs at least one field." });
    expect(await fieldsOf(await post(body({ fields: [F("Dog")] })))).toEqual({ fields: "At least one field must identify a booking." });
    expect(await fieldsOf(await post(body({ fields: [F("Do\u200Bg", { identity: true })] })))).toEqual({ "fields.0.label": INVISIBLE("field label") });
    expect(await countRows(t.env.DB, "event_templates")).toBe(0);
  });

  it("is atomic: nothing is left of a template whose fields the database refuses (validation bypassed)", async () => {
    const parsed = parseTemplateDraft(body({ fields: [F("A", { identity: true }), F("B")] }));
    if (!("draft" in parsed)) throw new Error("rejected");
    await createTemplate(t.env.DB, { ...parsed.draft, fields: [F("A", { identity: true }), F("a")] }); // any UNIQUE failure of the batch answers duplicate_name
    expect([await countRows(t.env.DB, "event_templates"), await countRows(t.env.DB, "event_template_fields"), await countRows(t.env.DB, "event_template_layout")]).toEqual([0, 0, 0]);
  });
});

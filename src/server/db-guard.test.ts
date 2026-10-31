import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countRows, createTestEnv, insertBreak, insertEvent, type TestEnv } from "../test/db";
import { loadEventBySlug } from "./events";
import { guard, isGuardFailure, scheduleUnchanged } from "./db-guard";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

const caught = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a failure");
};

const insertNamed = (name: string) =>
  t.env.DB.prepare(
    `INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode)
     VALUES ('guard-test-slug-' || ?, ?, '2026-06-13T08:00:00Z', '2026-06-13T09:00:00Z', 5, 'AB1')`,
  ).bind(name, name);

describe("guard", () => {
  it("lets the batch through when the condition holds", async () => {
    const before = await countRows(t.env.DB, "events");
    await t.env.DB.batch([insertNamed("passes"), guard(t.env.DB, "1 = 1"), insertNamed("passes too")]);
    expect(await countRows(t.env.DB, "events")).toBe(before + 2);
  });

  it("fails with an error isGuardFailure recognises when the condition is false", async () => {
    const e = await caught(t.env.DB.batch([guard(t.env.DB, "1 = 2")]));
    expect(isGuardFailure(e)).toBe(true);
  });

  it("aborts the whole batch, before and after it, when the condition is false", async () => {
    const before = await countRows(t.env.DB, "events");
    const e = await caught(t.env.DB.batch([insertNamed("before"), guard(t.env.DB, "1 = 2"), insertNamed("after")]));
    expect(isGuardFailure(e)).toBe(true);
    expect(await countRows(t.env.DB, "events")).toBe(before);
    const stray = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE name IN ('before', 'after')").first<{ n: number }>();
    expect(stray!.n).toBe(0);
  });

  it("evaluates a condition on stored rows, with bound values, at the moment the batch runs", async () => {
    const { id } = await insertEvent(t.env.DB, { name: "Guarded" });
    const holds = "(SELECT COUNT(*) FROM events WHERE id = ? AND name = ?) = 1";
    await t.env.DB.batch([guard(t.env.DB, holds, id, "Guarded")]);
    expect(isGuardFailure(await caught(t.env.DB.batch([guard(t.env.DB, holds, id, "Other")])))).toBe(true);
  });

  it("sees what earlier statements in the same batch wrote", async () => {
    const { id } = await insertEvent(t.env.DB, { name: "Before" });
    const renamed = "(SELECT name FROM events WHERE id = ?) = 'After'";
    const rename = t.env.DB.prepare("UPDATE events SET name = 'After' WHERE id = ?").bind(id);
    await t.env.DB.batch([rename, guard(t.env.DB, renamed, id)]);
    expect((await t.env.DB.prepare("SELECT name FROM events WHERE id = ?").bind(id).first<{ name: string }>())!.name).toBe("After");
  });
});

describe("isGuardFailure", () => {
  it("does not recognise other database errors or non-errors", async () => {
    const { slug } = await insertEvent(t.env.DB);
    const clash = await caught(insertEvent(t.env.DB, { slug }));
    expect(String((clash as Error).message)).toContain("UNIQUE constraint failed");
    expect(isGuardFailure(clash)).toBe(false);
    expect(isGuardFailure(new Error("malformed JSON"))).toBe(false);
    expect(isGuardFailure("integer overflow")).toBe(false);
    expect(isGuardFailure(null)).toBe(false);
  });
});

describe("scheduleUnchanged", () => {
  const seed = async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T12:00:00Z", sessionMinutes: 15, gapMinutes: 5 });
    await insertBreak(t.env.DB, e.id, "2026-06-13T10:00:00Z", "2026-06-13T10:30:00Z", "Lunch");
    await insertBreak(t.env.DB, e.id, "2026-06-13T09:00:00Z", "2026-06-13T09:10:00Z");
    return { ...e, event: (await loadEventBySlug(t.env.DB, e.slug))! };
  };
  const run = (e: Awaited<ReturnType<typeof seed>>) => t.env.DB.batch([scheduleUnchanged(t.env.DB, e.event)]);
  const refused = async (e: Awaited<ReturnType<typeof seed>>) => isGuardFailure(await caught(run(e)));

  it("lets the batch through while the schedule is as read, however the breaks were inserted", async () => {
    await run(await seed());
  });

  it("lets it through when only fields that are not the schedule change (name, cost, a break's label)", async () => {
    const e = await seed();
    await t.env.DB.prepare("UPDATE events SET name = 'Renamed', cost_pence = 5, venue_postcode = 'ZZ9' WHERE id = ?").bind(e.id).run();
    await t.env.DB.prepare("UPDATE breaks SET label = 'Different' WHERE event_id = ?").bind(e.id).run();
    await run(e);
  });

  it("aborts when the layout's revision changed (lanes, capacity or identity limit were edited), and not when the layout is left as it was", async () => {
    const e = await seed();
    await t.env.DB.prepare("UPDATE event_layout SET capacity = 1 WHERE event_id = ?").bind(e.id).run();
    await run(e);
    await t.env.DB.prepare("UPDATE event_layout SET config_rev = config_rev + 1 WHERE event_id = ?").bind(e.id).run();
    expect(await refused(e)).toBe(true);
    await run({ ...e, event: (await loadEventBySlug(t.env.DB, e.slug))! });
  });

  it("treats an event with no layout row as revision 0", async () => {
    const e = await seed();
    await t.env.DB.prepare("DELETE FROM event_layout WHERE event_id = ?").bind(e.id).run();
    await run({ ...e, event: (await loadEventBySlug(t.env.DB, e.slug))! });
  });

  it("aborts when the start, end, session length or gap changed", async () => {
    for (const set of ["start_utc = '2026-06-13T07:45:00Z'", "end_utc = '2026-06-13T12:15:00Z'", "session_minutes = 10", "gap_minutes = 0"]) {
      const e = await seed();
      await t.env.DB.prepare(`UPDATE events SET ${set} WHERE id = ?`).bind(e.id).run();
      expect(await refused(e), set).toBe(true);
    }
  });

  it("aborts when a break was added, removed, moved or resized", async () => {
    const changes = [
      "INSERT INTO breaks (event_id, start_utc, end_utc) VALUES (?, '2026-06-13T11:00:00Z', '2026-06-13T11:05:00Z')",
      "DELETE FROM breaks WHERE event_id = ? AND start_utc = '2026-06-13T09:00:00Z'",
      "UPDATE breaks SET start_utc = '2026-06-13T10:05:00Z' WHERE event_id = ? AND start_utc = '2026-06-13T10:00:00Z'",
      "UPDATE breaks SET end_utc = '2026-06-13T10:35:00Z' WHERE event_id = ? AND start_utc = '2026-06-13T10:00:00Z'",
      "DELETE FROM breaks WHERE event_id = ?",
    ];
    for (const sql of changes) {
      const e = await seed();
      await t.env.DB.prepare(sql).bind(e.id).run();
      expect(await refused(e), sql).toBe(true);
    }
  });

  it("treats the breaks as a set: identical duplicates and insertion order make no difference", async () => {
    const e = await seed();
    await insertBreak(t.env.DB, e.id, "2026-06-13T10:00:00Z", "2026-06-13T10:30:00Z", "Lunch again");
    const reloaded = (await loadEventBySlug(t.env.DB, e.slug))!;
    expect(reloaded.breaks).toHaveLength(3);
    await run({ ...e, event: reloaded });
    // One of the two identical breaks goes, and one is added: the schedule is the same, so the guard holds.
    await t.env.DB.prepare("DELETE FROM breaks WHERE id = (SELECT MAX(id) FROM breaks WHERE event_id = ? AND start_utc = '2026-06-13T10:00:00Z')").bind(e.id).run();
    await run({ ...e, event: reloaded });
    await insertBreak(t.env.DB, e.id, "2026-06-13T09:00:00Z", "2026-06-13T09:10:00Z");
    await run({ ...e, event: reloaded });
  });

  it("is not fooled by breaks inserted in reverse order", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T12:00:00Z", sessionMinutes: 15, gapMinutes: 5 });
    for (const h of ["11", "10", "09"]) await insertBreak(t.env.DB, e.id, `2026-06-13T${h}:00:00Z`, `2026-06-13T${h}:05:00Z`);
    await run({ ...e, event: (await loadEventBySlug(t.env.DB, e.slug))! });
  });

  it("aborts when a break's end moves by one minute", async () => {
    const e = await seed();
    await t.env.DB.prepare("UPDATE breaks SET end_utc = '2026-06-13T10:31:00Z' WHERE event_id = ? AND start_utc = '2026-06-13T10:00:00Z'").bind(e.id).run();
    expect(await refused(e)).toBe(true);
  });

  it("aborts when the event has gone, and compares an event that never had breaks against none", async () => {
    const e = await seed();
    await t.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(e.id).run();
    expect(await refused(e)).toBe(true);
    const bare = await insertEvent(t.env.DB);
    await t.env.DB.batch([scheduleUnchanged(t.env.DB, (await loadEventBySlug(t.env.DB, bare.slug))!)]);
  });
});

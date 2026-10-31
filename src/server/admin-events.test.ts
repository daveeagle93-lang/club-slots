import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { londonToUtc } from "../core/london";
import { generateSchedule } from "../core/schedule";
import { generateSlug } from "../core/slug";
import { ANCHOR_CODE_POINTS, FORMAT_CODE_POINTS, hex, ORDINARY_NAMES } from "../test/format-chars";
import { countRows, createTestEnv, type TestEnv } from "../test/db";
import { loadEventBySlug } from "./events";
import { createdBody, createEvent, findEventByKey, insertEventWithBreaks, listAdminEvents, parseEventDraft, placeCountOf, previewSchedule, type EventDraft } from "./admin-events";

const NOW = new Date("2026-10-01T12:00:00Z");

/** A valid input: BST day, 09:00-12:00, quarter-hour sessions, no breaks. */
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "Saturday trial day", date: "2026-10-24", start: "09:00", end: "12:00",
  sessionMinutes: 15, gapMinutes: 0, costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water", breaks: [],
  ...over,
});

const parse = (over: Record<string, unknown> = {}, requireFuture = true) =>
  parseEventDraft(valid(over), { now: NOW, requireFuture });

/** The field errors for an input, or fails the test if it was accepted. */
function fieldsOf(over: Record<string, unknown>, requireFuture = true): Record<string, string> {
  const r = parse(over, requireFuture);
  if (!("fields" in r)) throw new Error(`accepted: ${JSON.stringify(over)}`);
  return r.fields;
}

function draftOf(over: Record<string, unknown> = {}, requireFuture = true): EventDraft {
  const r = parse(over, requireFuture);
  if (!("draft" in r)) throw new Error(`rejected: ${JSON.stringify(r.fields)}`);
  return r.draft;
}

const ok = (over: Record<string, unknown>, requireFuture = true): boolean => "draft" in parse(over, requireFuture);

describe("parseEventDraft: accepted input", () => {
  it("returns London strings and UTC instants (BST: 09:00 is 08:00Z)", () => {
    expect(draftOf({ breaks: [{ start: "10:00", end: "10:30" }] })).toEqual({
      name: "Saturday trial day", date: "2026-10-24", start: "09:00", end: "12:00",
      sessionMinutes: 15, gapMinutes: 0, costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water",
      startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z",
      breaks: [{ start: "10:00", end: "10:30", label: "", startUtc: "2026-10-24T09:00:00Z", endUtc: "2026-10-24T09:30:00Z" }],
    });
  });

  it("converts GMT correctly (2026-10-31: 09:00 is 09:00Z)", () => {
    expect(draftOf({ date: "2026-10-31" })).toMatchObject({ startUtc: "2026-10-31T09:00:00Z", endUtc: "2026-10-31T12:00:00Z" });
  });

  it("leaves `listed` unset when the input has none, and takes true or false as given", () => {
    expect(draftOf().listed).toBeUndefined();
    expect(draftOf({ listed: true }).listed).toBe(true);
    expect(draftOf({ listed: false }).listed).toBe(false);
  });

  it.each([["a string", "false"], ["a number", 0], ["null", null], ["an object", {}]])("refuses `listed` as %s, under its own key", (_n, listed) => {
    expect(fieldsOf({ listed })).toEqual({ listed: "Listed must be true or false." });
  });

  it("ignores unknown keys", () => {
    expect("draft" in parse({ colour: "red", id: 7 })).toBe(true);
  });

  it("never throws on junk, and reports every field", () => {
    for (const junk of [{}, { name: 1, date: 2, start: [], end: {}, sessionMinutes: "x", gapMinutes: null, costPence: true, venuePostcode: 0, details: 0, breaks: "no" }]) {
      const r = parseEventDraft(junk, { now: NOW, requireFuture: true });
      expect("fields" in r && Object.keys(r.fields).sort()).toEqual([
        "breaks", "costPence", "date", "details", "end", "gapMinutes", "name", "sessionMinutes", "start", "venuePostcode",
      ]);
    }
  });
});

describe("parseEventDraft: name", () => {
  it("trims, and accepts 1 to 100 code points", () => {
    expect(draftOf({ name: "  x  " }).name).toBe("x");
    expect(draftOf({ name: "😀".repeat(100) }).name).toBe("😀".repeat(100));
    expect(fieldsOf({ name: "😀".repeat(101) }).name).toMatch(/at most 100/);
  });

  it.each([["empty", ""], ["blank", "  \t "], ["a number", 5], ["missing", undefined]])("rejects %s", (_n, name) => {
    expect(fieldsOf({ name }).name).toBe("Enter the event name.");
  });

  it.each([
    ["a control character", "a\u0007b", /control/],
    ["a newline", "a\nb", /control/],
    ["a zero-width space", "a​b", /invisible/],
    ["a right-to-left override", "a‮b", /invisible/],
    ["a lone surrogate", "a\uD800b", /unpaired/],
    ["a line separator", "a\u2028b", /line or paragraph separators/],
    ["a paragraph separator", "a\u2029b", /line or paragraph separators/],
    ["a leading line separator (trim would hide it)", "\u2028a", /line or paragraph separators/],
    ["a trailing paragraph separator", "a\u2029", /line or paragraph separators/],
    ["a next-line (U+0085)", "a\u0085b", /control/],
  ])("rejects %s", (_n, name, message) => {
    expect(fieldsOf({ name }).name).toMatch(message);
  });

  it("rejects an emoji joiner (ZWJ, U+200D, is Cf)", () => {
    expect(fieldsOf({ name: "👩\u200D🐕" }).name).toMatch(/invisible/);
  });
});

describe("parseEventDraft: date", () => {
  it.each(["2026-02-30", "2026-13-01", "2026-10-4", "24/10/2026", "", 20261024, undefined])("rejects %j", (date) => {
    expect(fieldsOf({ date }).date).toBe("Enter a real date.");
  });

  it("still checks the times' shape when the date is bad", () => {
    expect(fieldsOf({ date: "nope", start: "9:00" })).toEqual({ date: "Enter a real date.", start: "Enter a time as HH:MM." });
  });

  it("must start strictly after now when requireFuture (event starts 2026-10-24T08:00:00Z)", () => {
    const at = (iso: string) => parseEventDraft(valid(), { now: new Date(iso), requireFuture: true });
    expect("draft" in at("2026-10-24T07:59:59Z")).toBe(true);
    expect("fields" in at("2026-10-24T08:00:00Z") && (at("2026-10-24T08:00:00Z") as { fields: Fields }).fields.date).toBe("The event must start in the future.");
    expect("fields" in at("2026-10-24T08:00:01Z")).toBe(true);
  });

  it("may be in the past when not requireFuture", () => {
    expect(ok({ date: "2020-01-01" }, false)).toBe(true);
    expect(fieldsOf({ date: "2020-01-01" }).date).toBe("The event must start in the future.");
  });

  it("is at most 730 days ahead of now (start exactly 730 days ahead is fine)", () => {
    const start = Date.parse("2026-10-24T08:00:00Z");
    const at = (ms: number) => parseEventDraft(valid(), { now: new Date(start - ms), requireFuture: true });
    const day = 86_400_000;
    expect("draft" in at(730 * day)).toBe(true);
    const over = at(730 * day + 1000);
    expect("fields" in over && over.fields.date).toMatch(/more than two years/);
    expect("draft" in parseEventDraft(valid(), { now: new Date(start - 730 * day - 1000), requireFuture: false })).toBe(true);
  });
});

type Fields = Record<string, string>;

describe("parseEventDraft: start and end", () => {
  it.each(["9:00", "24:00", "09:60", "0900", "09:00:00", "", 900, undefined])("rejects start %j", (start) => {
    expect(fieldsOf({ start }).start).toBe("Enter a time as HH:MM.");
  });
  it.each(["12:5", "25:00", null])("rejects end %j", (end) => {
    expect(fieldsOf({ end }).end).toBe("Enter a time as HH:MM.");
  });

  it("needs the end after the start on the same date", () => {
    expect(ok({ start: "09:00", end: "09:15" })).toBe(true);
    expect(fieldsOf({ start: "09:00", end: "09:00" }).end).toBe("The end must be after the start.");
    expect(fieldsOf({ start: "09:00", end: "08:59" }).end).toBe("The end must be after the start.");
    expect(fieldsOf({ start: "09:00", end: "00:00" }).end).toBe("The end must be after the start.");
    expect(ok({ start: "00:00", end: "23:59" })).toBe(true);
  });

  it("rejects a time the clocks skip (2026-03-29 01:30) and one they repeat (2026-10-25 01:30)", () => {
    expect(fieldsOf({ date: "2026-03-29", start: "01:30", end: "05:00" }).start).toBe("That time doesn't exist in London on that date (the clocks go forward).");
    expect(fieldsOf({ date: "2026-03-29", start: "00:00", end: "01:59" }).end).toMatch(/doesn't exist/);
    expect(fieldsOf({ date: "2026-10-25", start: "01:30", end: "05:00" }).start).toBe("That time happens twice in London on that date (the clocks go back).");
    expect(fieldsOf({ date: "2026-10-25", start: "00:00", end: "01:00" }).end).toMatch(/happens twice/);
  });

  it("accepts the times either side of the clock changes", () => {
    // These dates are before NOW, so only check them as previews.
    expect(draftOf({ date: "2026-03-29", start: "00:00", end: "02:00" }, false)).toMatchObject({
      startUtc: "2026-03-29T00:00:00Z", endUtc: "2026-03-29T01:00:00Z",
    });
    expect(draftOf({ date: "2026-10-25", start: "00:00", end: "02:00" })).toMatchObject({
      startUtc: "2026-10-24T23:00:00Z", endUtc: "2026-10-25T02:00:00Z",
    });
  });
});

describe("parseEventDraft: numbers", () => {
  const cases: [string, number, number][] = [["sessionMinutes", 1, 480], ["gapMinutes", 0, 120], ["costPence", 0, 100_000]];
  for (const [field, min, max] of cases) {
    it(`${field} accepts ${min} to ${max} and rejects either side, fractions, strings and null`, () => {
      // A 480-minute session needs a long day; a 1-minute one would make too many slots on one.
      expect(ok({ [field]: min })).toBe(true);
      expect(ok({ start: "00:00", end: "23:59", [field]: max })).toBe(true);
      expect(fieldsOf({ [field]: min - 1 })[field]).toBeDefined();
      expect(fieldsOf({ [field]: max + 1 })[field]).toBeDefined();
      for (const bad of [min + 0.5, String(min), null, NaN, undefined]) expect(fieldsOf({ [field]: bad })[field], String(bad)).toBeDefined();
    });
  }
});

describe("parseEventDraft: venue postcode", () => {
  it("tidies: trimmed, one space, upper case", () => {
    expect(draftOf({ venuePostcode: "  sw1a \t 1aa " }).venuePostcode).toBe("SW1A 1AA");
  });
  it("accepts 2 to 10 characters", () => {
    expect(ok({ venuePostcode: "AB" })).toBe(true);
    expect(ok({ venuePostcode: "ABCDE FGHI" })).toBe(true);
    expect(fieldsOf({ venuePostcode: "A" }).venuePostcode).toBeDefined();
    expect(fieldsOf({ venuePostcode: "ABCDE FGHIJ" }).venuePostcode).toBeDefined();
    expect(fieldsOf({ venuePostcode: "   " }).venuePostcode).toBeDefined();
  });
  it("rejects other characters, including ones that upper-case into ASCII", () => {
    for (const venuePostcode of ["AB-1 2CD", "AB1 2C!", "ßß1", "ab1\u00002cd", 5]) {
      expect(fieldsOf({ venuePostcode }).venuePostcode, String(venuePostcode)).toBeDefined();
    }
  });
});

describe("parseEventDraft: details", () => {
  it("may be empty, and is up to 2000 code points", () => {
    expect(draftOf({ details: "" }).details).toBe("");
    expect(ok({ details: "😀".repeat(2000) })).toBe(true);
    expect(fieldsOf({ details: "😀".repeat(2001) }).details).toMatch(/at most 2000/);
  });
  it("keeps newlines and normalises CRLF", () => {
    expect(draftOf({ details: "a\r\nb\nc" }).details).toBe("a\nb\nc");
  });
  it.each([["tab", "a\tb"], ["lone CR", "a\rb"], ["NUL", "a\u0000b"], ["escape", "a\u001Bb"]])("rejects %s", (_n, details) => {
    expect(fieldsOf({ details }).details).toMatch(/control/);
  });
  it.each([["right-to-left override", "a\u202Eb"], ["zero-width space", "a\u200Bb"], ["byte order mark", "a\uFEFFb"], ["soft hyphen", "a\u00ADb"]])("rejects a %s", (_n, details) => {
    expect(fieldsOf({ details }).details).toBe("The details can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.");
  });
  it.each([["line separator", "a\u2028b"], ["paragraph separator", "a\u2029b"], ["trailing line separator", "a\n\u2028"]])("rejects a %s (only \\n may break a line)", (_n, details) => {
    expect(fieldsOf({ details }).details).toBe("The details can't contain line or paragraph separators.");
  });
  it("rejects a next-line (U+0085) as a control character", () => {
    expect(fieldsOf({ details: "a\u0085b" }).details).toMatch(/control/);
  });
  it("allows newlines but rejects the joiners ZWJ and ZWNJ (U+200D, U+200C, both Cf)", () => {
    expect(draftOf({ details: "a\nc" }).details).toBe("a\nc");
    expect(fieldsOf({ details: "👩\u200D🐕" }).details).toMatch(/invisible/);
    expect(fieldsOf({ details: "a\u200Cb" }).details).toMatch(/invisible/);
  });
  it("rejects a lone surrogate and non-strings", () => {
    expect(fieldsOf({ details: "a\uD800" }).details).toMatch(/unpaired/);
    expect(fieldsOf({ details: undefined }).details).toBeDefined();
    expect(fieldsOf({ details: 3 }).details).toBeDefined();
  });
});

describe("parseEventDraft: breaks", () => {
  const brk = (start: string, end: string) => ({ start, end });

  it("must be a list of at most 20", () => {
    expect(fieldsOf({ breaks: "x" }).breaks).toBe("Breaks must be a list.");
    expect(fieldsOf({ breaks: undefined }).breaks).toBe("Breaks must be a list.");
    const many = (n: number) => Array.from({ length: n }, () => brk("10:00", "10:05"));
    expect(ok({ breaks: many(20) })).toBe(true);
    expect(fieldsOf({ breaks: many(21) }).breaks).toBe("You can add at most 20 breaks.");
  });

  it("each break must be an object", () => {
    expect(fieldsOf({ breaks: [brk("10:00", "10:30"), "x", null, [1]] })).toEqual({
      "breaks.1": "Each break needs a start and an end.", "breaks.2": "Each break needs a start and an end.",
      "breaks.3": "Each break needs a start and an end.",
    });
  });

  it("keys time errors by index and side", () => {
    expect(fieldsOf({ breaks: [brk("10:00", "10:30"), { start: "9:00", end: 5 }] })).toEqual({
      "breaks.1.start": "Enter a time as HH:MM.", "breaks.1.end": "Enter a time as HH:MM.",
    });
  });

  it("must end after it starts", () => {
    expect(fieldsOf({ breaks: [brk("10:00", "10:00")] })["breaks.0.end"]).toBe("The break must end after it starts.");
    expect(fieldsOf({ breaks: [brk("10:30", "10:00")] })["breaks.0.end"]).toBe("The break must end after it starts.");
    expect(ok({ breaks: [brk("10:00", "10:01")] })).toBe(true);
  });

  it("must lie within the event (09:00-12:00); touching the edges is fine", () => {
    expect(ok({ breaks: [brk("09:00", "09:30")] })).toBe(true);
    expect(ok({ breaks: [brk("11:30", "12:00")] })).toBe(true);
    expect(fieldsOf({ breaks: [brk("08:59", "09:30")] })["breaks.0.start"]).toBe("The break must start within the event.");
    expect(fieldsOf({ breaks: [brk("11:30", "12:01")] })["breaks.0.end"]).toBe("The break must end within the event.");
  });

  it("may overlap or touch each other", () => {
    expect(ok({ breaks: [brk("10:00", "10:30"), brk("10:15", "10:45"), brk("10:45", "11:00")] })).toBe(true);
  });

  it("a break time in the autumn overlap is rejected under its own key", () => {
    const f = fieldsOf({ date: "2026-10-25", start: "00:00", end: "06:00", breaks: [brk("00:30", "00:45"), brk("01:30", "03:00")] });
    expect(f).toEqual({ "breaks.1.start": "That time happens twice in London on that date (the clocks go back)." });
    expect(fieldsOf({ date: "2026-03-29", start: "00:00", end: "06:00", breaks: [brk("00:30", "01:30")] })["breaks.0.end"]).toMatch(/doesn't exist/);
  });
});

describe("parseEventDraft: break labels", () => {
  const labelled = (label: unknown) => ({ breaks: [{ start: "10:00", end: "10:30", label }] });
  const labelOf = (label: unknown) => draftOf(labelled(label)).breaks[0].label;

  it("defaults to the empty string when missing, undefined or null", () => {
    expect(labelOf(undefined)).toBe("");
    expect(labelOf(null)).toBe("");
    expect(draftOf({ breaks: [{ start: "10:00", end: "10:30" }] }).breaks[0].label).toBe("");
    expect(labelOf("")).toBe("");
  });

  it("is trimmed, and a blank one becomes empty", () => {
    expect(labelOf("  Lunch \t")).toBe("Lunch");
    expect(labelOf("   ")).toBe("");
  });

  it("accepts 40 code points and rejects 41, counting an emoji as one", () => {
    expect(labelOf("x".repeat(40))).toBe("x".repeat(40));
    expect(labelOf("😀".repeat(40))).toBe("😀".repeat(40));
    expect(fieldsOf(labelled("x".repeat(41)))["breaks.0.label"]).toBe("The break name must be at most 40 characters.");
    expect(fieldsOf(labelled("😀".repeat(41)))["breaks.0.label"]).toMatch(/at most 40/);
  });

  it.each([
    ["a control character", "a\u0007b", /control/],
    ["a newline inside", "a\nb", /control/],
    ["a zero-width space", "a\u200Bb", /invisible/],
    ["a right-to-left override", "a\u202Eb", /invisible/],
    ["a lone surrogate", "a\uD800b", /unpaired/],
    ["a line separator", "a\u2028b", /line or paragraph separators/],
    ["a paragraph separator", "a\u2029b", /line or paragraph separators/],
    ["a trailing line separator (trim would hide it)", "a\u2028", /line or paragraph separators/],
    ["a next-line (U+0085)", "a\u0085b", /control/],
  ])("rejects %s", (_n, label, message) => {
    expect(fieldsOf(labelled(label))["breaks.0.label"]).toMatch(message);
  });

  it.each([5, true, {}, ["Lunch"]])("rejects the non-string %j", (label) => {
    expect(fieldsOf(labelled(label))["breaks.0.label"]).toBe("The break name must be text.");
  });

  it("keeps the text as typed, but rejects an emoji joiner (ZWJ, U+200D, is Cf)", () => {
    expect(labelOf("🐕 <b>Lunch</b>")).toBe("🐕 <b>Lunch</b>");
    expect(fieldsOf(labelled("👩\u200D🐕 Lunch"))["breaks.0.label"]).toMatch(/invisible/);
  });

  it("reports the label error under its own break's index, alongside time errors", () => {
    const f = fieldsOf({ breaks: [{ start: "10:00", end: "10:30" }, { start: "9:00", end: "10:00", label: "x".repeat(41) }] });
    expect(Object.keys(f).sort()).toEqual(["breaks.1.label", "breaks.1.start"]);
  });
});

describe("parseEventDraft: slot count", () => {
  it("needs at least one session", () => {
    expect(ok({ start: "09:00", end: "09:15" })).toBe(true);
    expect(fieldsOf({ start: "09:00", end: "09:14" })).toEqual({ end: "No sessions fit between the start and end." });
    expect(fieldsOf({ breaks: [{ start: "09:00", end: "12:00" }] })).toEqual({ end: "No sessions fit between the start and end." });
  });

  it("allows 500 slots and rejects 501", () => {
    expect(previewSchedule(draftOf({ start: "09:00", end: "17:20", sessionMinutes: 1 })).slots).toHaveLength(500);
    expect(fieldsOf({ start: "09:00", end: "17:21", sessionMinutes: 1 })).toEqual({ sessionMinutes: "That would make more than 500 slots." });
  });
});

describe("previewSchedule", () => {
  // 15 minute sessions from 09:00 with no gap: slots at :00 :15 :30 :45. A break 12:05-13:00 is overrun
  // by the 12:00-12:15 session by 10 minutes, the near-miss limit, so the engine offers to move it to
  // 12:15-13:10 (same 55 minutes), after the dropped session.
  const day = { date: "2026-10-24", start: "09:00", end: "17:00" };

  it("returns the engine's own slots", () => {
    const d = draftOf({ ...day, gapMinutes: 5, breaks: [{ start: "12:00", end: "13:00" }] });
    const engine = generateSchedule({
      start: d.startUtc, end: d.endUtc, sessionMinutes: 15, gapMinutes: 5, breaks: [{ start: londonToUtc("2026-10-24", "12:00"), end: londonToUtc("2026-10-24", "13:00") }],
    });
    expect(previewSchedule(d).slots).toEqual(engine.slots);
    expect(previewSchedule(d).slots[0]).toEqual({ start: "2026-10-24T08:00:00Z", end: "2026-10-24T08:15:00Z" });
  });

  it("suggests moving a near-miss break later, with the break's index and London times", () => {
    const d = draftOf({ ...day, breaks: [{ start: "12:05", end: "13:00" }] });
    expect(previewSchedule(d).suggestions).toEqual([{
      breakIndex: 0,
      droppedSlot: { start: "2026-10-24T11:00:00Z", end: "2026-10-24T11:15:00Z" },
      overrunMinutes: 10,
      suggestedBreak: { start: "2026-10-24T11:15:00Z", end: "2026-10-24T12:10:00Z" },
      suggestedLocal: { start: "12:15", end: "13:10" },
      breakLabel: "",
    }]);
    expect(previewSchedule(d).slots.map((s) => s.start)).not.toContain("2026-10-24T11:00:00Z");
  });

  it("carries the label of the break each suggestion is about", () => {
    const d = draftOf({ ...day, breaks: [{ start: "14:35", end: "14:40" }, { start: "12:05", end: "13:00", label: "Lunch" }] });
    expect(previewSchedule(d).suggestions.map((s) => [s.breakIndex, s.breakLabel])).toEqual([[1, "Lunch"], [0, ""]]);
  });

  it("gives no suggestion when the overrun is 11 minutes", () => {
    expect(previewSchedule(draftOf({ ...day, breaks: [{ start: "12:04", end: "13:00" }] })).suggestions).toEqual([]);
  });

  it("points each suggestion at its own break, whatever order the breaks were given in", () => {
    const d = draftOf({ ...day, breaks: [{ start: "14:35", end: "14:40" }, { start: "12:05", end: "13:00" }] });
    const { suggestions } = previewSchedule(d);
    expect(suggestions.map((s) => [s.breakIndex, s.suggestedLocal])).toEqual([
      [1, { start: "12:15", end: "13:10" }],
      [0, { start: "14:45", end: "14:50" }],
    ]);
    for (const s of suggestions) {
      const b = d.breaks[s.breakIndex];
      expect(b.startUtc > s.droppedSlot.start && b.startUtc < s.droppedSlot.end).toBe(true);
    }
  });

  it("applying suggestedLocal to the form removes the suggestion and keeps the session", () => {
    const before = previewSchedule(draftOf({ ...day, breaks: [{ start: "14:35", end: "14:40" }, { start: "12:05", end: "13:00" }] }));
    const first = before.suggestions[0];
    const breaks = [{ start: "14:35", end: "14:40" }, { start: "12:05", end: "13:00" }];
    breaks[first.breakIndex] = first.suggestedLocal;
    const after = previewSchedule(draftOf({ ...day, breaks }));
    expect(after.suggestions.map((s) => s.breakIndex)).toEqual([0]); // only the other break's suggestion remains
    expect(before.slots.map((s) => s.start)).not.toContain(first.droppedSlot.start);
    expect(after.slots.map((s) => s.start)).toContain(first.droppedSlot.start);
    expect(after.slots.map((s) => s.start)).not.toContain("2026-10-24T11:15:00Z"); // inside the moved break
  });

  it("leaves out a suggestion whose London time the form cannot express (autumn overlap)", () => {
    // 00:55-02:00 on 2026-10-25 starts in BST. The 00:45 session ends at 01:00 BST (00:00Z) and overruns it
    // by 5 minutes, so the engine would move the break to start at "01:00", which happens twice that night.
    const d = draftOf({ date: "2026-10-25", start: "00:00", end: "06:00", breaks: [{ start: "00:55", end: "02:00" }] });
    const engine = generateSchedule({
      start: d.startUtc, end: d.endUtc, sessionMinutes: 15, gapMinutes: 0, breaks: [{ start: d.breaks[0].startUtc, end: d.breaks[0].endUtc }],
    });
    expect(engine.suggestions).toHaveLength(1);
    expect(previewSchedule(d).suggestions).toEqual([]);
    expect(previewSchedule(d).slots).toEqual(engine.slots);
  });
});

describe("parseEventDraft: shareMessage", () => {
  it("is left unset when the input has none, and kept as written (\\r\\n to \\n) when it has", () => {
    expect(draftOf().shareMessage).toBeUndefined();
    expect(draftOf({ shareMessage: "" }).shareMessage).toBe("");
    expect(draftOf({ shareMessage: "{event}\r\nBook now" }).shareMessage).toBe("{event}\nBook now");
  });

  it("applies the details' rules under its own key and wording", () => {
    expect(fieldsOf({ shareMessage: 5 })).toEqual({ shareMessage: "The share message must be text (it can be empty)." });
    expect(fieldsOf({ shareMessage: "x".repeat(1001) })).toEqual({ shareMessage: "The share message must be at most 1000 characters." });
    expect(fieldsOf({ shareMessage: "a\u2028b" })).toEqual({ shareMessage: "The share message can't contain line or paragraph separators." });
    expect(fieldsOf({ shareMessage: "a\u0000b" })).toEqual({ shareMessage: "The share message can't contain control characters." });
    expect(fieldsOf({ shareMessage: "a\uD800" })).toEqual({ shareMessage: "The share message can't contain unpaired surrogate characters." });
  });

  it("lets an edit keep the stored message even with an invisible character, but not change it to another with one", () => {
    const stored = { name: "x", details: "x", shareMessage: "Hi\u200D", breakLabels: [] };
    const run = (shareMessage: string) => parseEventDraft(valid({ shareMessage }), { now: NOW, requireFuture: false, stored });
    expect("draft" in run("Hi\u200D")).toBe(true);
    expect(run("Hi\u200D!")).toEqual({ fields: { shareMessage: expect.stringContaining("invisible") } });
  });
});

describe("parseEventDraft: lanes and capacity", () => {
  const named = (...names: string[]) => names.map((name) => ({ name }));

  it("leaves lanes and capacity unset when the input has none (create: one unnamed lane and 1; edit: unchanged)", () => {
    expect(draftOf().lanes).toBeUndefined();
    expect(draftOf().capacity).toBeUndefined();
  });

  it("accepts a single lane unnamed, whether the name is missing, null or blank, and tidies names", () => {
    for (const lane of [{}, { name: null }, { name: "" }, { name: "  \t " }]) expect(draftOf({ lanes: [lane] }).lanes).toEqual([{ name: "" }]);
    expect(draftOf({ lanes: named("  Ring 1 ") }).lanes).toEqual([{ name: "Ring 1" }]);
  });

  it("accepts 2 to 10 named lanes, in order, and capacity 1 to 50", () => {
    expect(draftOf({ lanes: named("Ring 1", "Ring 2"), capacity: 3 })).toMatchObject({ lanes: named("Ring 1", "Ring 2"), capacity: 3 });
    expect(draftOf({ lanes: named(...Array.from({ length: 10 }, (_, i) => `Ring ${i + 1}`)), capacity: 1 }).lanes).toHaveLength(10);
    expect(draftOf({ capacity: 50, end: "09:30" }).capacity).toBe(50);
  });

  it.each([
    ["not a list", "Ring 1", { lanes: "Lanes must be a list." }],
    ["empty", [], { lanes: "An event needs at least one lane." }],
    ["eleven", Array.from({ length: 11 }, (_, i) => ({ name: `R${i}` })), { lanes: "You can have at most 10 lanes." }],
  ])("refuses lanes that are %s, under `lanes`", (_n, lanes, expected) => {
    expect(fieldsOf({ lanes })).toEqual(expected);
  });

  it("refuses a lane that is not an object, under `lanes.N`", () => {
    expect(fieldsOf({ lanes: [{ name: "A" }, "B"] })).toEqual({ "lanes.1": "Each lane needs a name." });
  });

  it("needs every lane named once there are two, under `lanes.N.name`", () => {
    expect(fieldsOf({ lanes: [{ name: "A" }, { name: "" }] })).toEqual({ "lanes.1.name": "Enter the lane name." });
    expect(fieldsOf({ lanes: [{}, { name: "B" }] })).toEqual({ "lanes.0.name": "Enter the lane name." });
    expect(fieldsOf({ lanes: [{ name: 5 }] })).toEqual({ "lanes.0.name": "Enter the lane name." });
  });

  it("refuses names that differ only in case, or in Unicode form, naming the second", () => {
    expect(fieldsOf({ lanes: named("Ring 1", "RING 1") })).toEqual({ "lanes.1.name": "Two lanes can't have the same name." });
    expect(fieldsOf({ lanes: named("Zo\u00eb", "ZOE\u0308") })).toEqual({ "lanes.1.name": "Two lanes can't have the same name." });
  });

  it("allows 40 characters and refuses 41, counted in code points", () => {
    expect(ok({ lanes: named("a".repeat(40)) })).toBe(true);
    expect(ok({ lanes: named(`a${"\u{1F415}".repeat(39)}`) })).toBe(true); // an emoji is one code point; the name needs a letter or a number too
    expect(fieldsOf({ lanes: named("a".repeat(41)) })).toEqual({ "lanes.0.name": "The lane name must be at most 40 characters." });
  });

  it("applies the text hygiene of event names to lane names: Cf, controls, separators, unpaired surrogates", () => {
    expect(fieldsOf({ lanes: named("Ri\u200Bng") })["lanes.0.name"]).toMatch(/lane name can't contain invisible/);
    expect(fieldsOf({ lanes: named("Ri\u0007ng") })["lanes.0.name"]).toMatch(/lane name can't contain control/);
    expect(fieldsOf({ lanes: named("Ri\u2028ng") })["lanes.0.name"]).toMatch(/line or paragraph separators/);
    expect(fieldsOf({ lanes: named("Ri\ud800ng") })["lanes.0.name"]).toMatch(/unpaired surrogate/);
    // A lane named only with an invisible character is refused even when it is the only lane (it is not blank).
    expect(fieldsOf({ lanes: named("\u200B") })["lanes.0.name"]).toMatch(/invisible/);
  });

  it.each([[0], [51], [1.5], ["3"], [null], [true]])("refuses capacity %j, under `capacity`", (capacity) => {
    expect(fieldsOf({ capacity })).toEqual({ capacity: "Enter a whole number of places from 1 to 50." });
  });

  it("reports lane and capacity errors together with other fields", () => {
    expect(Object.keys(fieldsOf({ name: "", capacity: 0, lanes: [] })).sort()).toEqual(["capacity", "lanes", "name"]);
  });

  it("refuses a lane id on a new event or template, accepts known ids on an edit, and refuses unknown or repeated ones", () => {
    expect(fieldsOf({ lanes: [{ id: 7, name: "A" }] })).toEqual({ "lanes.0.id": "A new event's lanes don't have an id." });
    expect(draftOf({ lanes: [{ id: null, name: "A" }] }).lanes).toEqual([{ name: "A" }]);
    const layout = { laneIds: [7, 8], capacity: 1 };
    const edit = (lanes: unknown) => parseEventDraft(valid({ lanes }), { now: NOW, requireFuture: false, layout });
    expect(edit([{ id: 8, name: "B" }, { name: "New" }, { id: 7, name: "A" }])).toMatchObject({ draft: { lanes: [{ id: 8, name: "B" }, { name: "New" }, { id: 7, name: "A" }] } });
    expect(edit([{ id: 9, name: "A" }, { id: 7, name: "B" }])).toEqual({ fields: { "lanes.0.id": "That isn't one of this event's lanes." } });
    expect(edit([{ id: "7", name: "A" }, { name: "B" }])).toEqual({ fields: { "lanes.0.id": "That isn't one of this event's lanes." } });
    expect(edit([{ id: 7, name: "A" }, { id: 7, name: "B" }])).toEqual({ fields: { "lanes.1.id": "That lane is listed twice." } });
  });

  describe("the limit on places, with the slots (a 09:00 to 12:00 event with 15-minute sessions has 12)", () => {
    it("allows exactly 2000 and refuses more, keyed by what the request set", () => {
      // 09:00-18:00 in 5-minute sessions is 108 slots; 108 x 1 x 18 = 1944 is fine, 108 x 1 x 19 = 2052 is not.
      const day = { end: "18:00", sessionMinutes: 5 };
      expect(ok({ ...day, capacity: 18 })).toBe(true);
      expect(fieldsOf({ ...day, capacity: 19 }).capacity).toMatch(/would make 2052 places.*at most 2000/);
      expect(fieldsOf({ ...day, lanes: named("A", "B", "C", "D", "E", "F", "G", "H", "I", "J"), capacity: 2 }).capacity).toMatch(/2160 places/);
      expect(ok({ ...day, lanes: named(...Array.from({ length: 10 }, (_, i) => `L${i}`)), capacity: 1 })).toBe(true); // 1080 places
    });

    it("counts the lanes of the draft, the capacity of the draft, and what an omitted one keeps on an edit", () => {
      const day = { end: "18:00", sessionMinutes: 5 };
      const edit = (over: Record<string, unknown>, layout: { laneIds: number[]; capacity: number }) =>
        parseEventDraft(valid({ ...day, ...over }), { now: NOW, requireFuture: false, layout });
      expect(edit({}, { laneIds: [1], capacity: 18 })).toHaveProperty("draft");
      // the capacity is left out: the stored 19 applies, and the error is keyed to the field that is the cause of this request
      expect(edit({}, { laneIds: [1], capacity: 19 })).toEqual({ fields: { sessionMinutes: expect.stringContaining("2052 places") } });
      expect(edit({ lanes: [{ id: 1, name: "A" }, { name: "B" }] }, { laneIds: [1], capacity: 10 })).toEqual({ fields: { lanes: expect.stringContaining("2160 places") } });
      expect(edit({ capacity: 1 }, { laneIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], capacity: 50 })).toHaveProperty("draft");
    });

    it("keeps the existing limit of 500 slots, checked first", () => {
      expect(fieldsOf({ end: "23:00", sessionMinutes: 1, capacity: 50 })).toEqual({ sessionMinutes: "That would make more than 500 slots." });
    });
  });

  it("placeCountOf is slots times lanes times capacity", () => {
    expect(placeCountOf(12, 3, 2)).toBe(72);
  });
});

describe("parseEventDraft: lane names and field labels get the hygiene of a booking's values", () => {
  const named = (...names: string[]) => names.map((name) => ({ name }));
  const F = (label: string, over: Record<string, unknown> = {}) => ({ label, required: true, maxLength: 80, identity: true, ...over });
  /** A lane name and a field label in turn, so every rule is held to both. */
  const KINDS = [
    { kind: "lane name", key: "lanes.0.name", send: (v: string) => ({ lanes: named(v) }), at: (i: number) => `lanes.${i}.name` },
    { kind: "field label", key: "fields.0.label", send: (v: string) => ({ fields: [F(v)] }), at: (i: number) => `fields.${i}.label` },
  ];

  describe.each(KINDS)("$kind", ({ kind, key, send }) => {
    it.each([
      ["a variation selector after a letter (U+FE0F)", "Ring 1\uFE0F"],
      ["a Hangul filler (U+3164)", "Ring\u3164"],
      ["a combining grapheme joiner (U+034F)", "Ri\u034Fng"],
      ["a Mongolian free variation selector (U+180B)", "Ring\u180B"],
      ["a variation selector supplement (U+E0100)", "Ring\u{E0100}"],
      ["a half-width Hangul filler (U+FFA0)", "Ring\uFFA0"],
    ])("refuses %s, as invisible", (_n, value) => {
      expect(fieldsOf(send(value))[key]).toBe(`The ${kind} can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.`);
    });

    it("refuses a name that is only an invisible character, a symbol or punctuation: there must be a letter or a number", () => {
      for (const value of ["\uFE0F", "\u3164", "!!!", "\u{1F415}", "- -", "\u2603"]) {
        expect(fieldsOf(send(value))[key], JSON.stringify(value)).toMatch(/invisible|must contain at least one letter or number/);
      }
      expect(fieldsOf(send("!!!"))[key]).toBe(`The ${kind} must contain at least one letter or number.`);
      expect(fieldsOf(send("\u{1F415}"))[key]).toBe(`The ${kind} must contain at least one letter or number.`);
    });

    it("refuses private-use characters and the braille blank (U+2800), beside a letter too", () => {
      for (const value of ["Ring\uE000", "\uE000Ring", "Ring\u2800", "\u{F0000}Ring"]) {
        expect(fieldsOf(send(value))[key], JSON.stringify(value)).toBe(`The ${kind} can't contain private-use or blank-looking characters. Try plain text.`);
      }
    });

    it("still takes ordinary names, accents, other scripts, numbers alone and an emoji beside a letter", () => {
      for (const value of ["Ring 1", "Zo\u00EB", "\u3053\u3093\u306B\u3061\u306F", "7", "\u0645\u0631\u062D\u0628\u0627", "Ring \u{1F415}", "A-B_C"]) {
        expect("draft" in parse(send(value)), JSON.stringify(value)).toBe(true);
      }
    });
  });

  it("compares lane names by identity key: compatibility forms, spacing and case are the same name", () => {
    // "Ring 1" and "Ring 1" + U+FE0F are caught by the invisible-character rule; these are the same name by the key alone.
    for (const [a, b] of [["Ring 1", "RING 1"], ["Ring 1", "Ring  1"], ["Ring 1", "\uFF32ing 1"], ["Ring 1", "Ring \u2460"], ["Ring \u2460", "ring 1"]]) {
      expect(fieldsOf({ lanes: named(a, b) }), JSON.stringify([a, b])).toEqual({ "lanes.1.name": "Two lanes can't have the same name." });
    }
    expect("draft" in parse({ lanes: named("Ring 1", "Ring 2") })).toBe(true);
  });

  it("compares field labels by identity key too", () => {
    for (const [a, b] of [["Dog", "DOG "], ["Dog", "D\uFF4Fg"], ["Car 1", "Car  1"], ["Car 1", "Car \u2460"]]) {
      expect(fieldsOf({ fields: [F(a), F(b, { identity: false })] }), JSON.stringify([a, b])).toEqual({ "fields.1.label": "Two fields can't have the same label." });
    }
    expect("draft" in parse({ fields: [F("Dog"), F("Handler", { identity: false })] })).toBe(true);
  });

  it("keeps the empty name of a single lane valid, and still needs every lane of several named", () => {
    expect(draftOf({ lanes: named("") }).lanes).toEqual([{ name: "" }]);
    expect(draftOf({ lanes: [{}] }).lanes).toEqual([{ name: "" }]);
    expect(fieldsOf({ lanes: named("", "Ring 2") })).toEqual({ "lanes.0.name": "Enter the lane name." });
  });

  describe("an edit that leaves a stored name or label as it is", () => {
    const WEAK = ["Ring 1\uFE0F", "!!!", "Ring\uE000"];
    const layout = { laneIds: [7, 8, 9], capacity: 1 };
    const edit = (over: Record<string, unknown>, keep: { laneNames?: string[]; fieldLabels?: string[] }) =>
      parseEventDraft(valid(over), { now: NOW, requireFuture: false, layout, keep: { laneNames: [], fieldLabels: [], ...keep } });

    it("is not refused for a lane name the event already has (the new rules apply to what is typed afresh)", () => {
      const lanes = [{ id: 7, name: WEAK[0] }, { id: 8, name: WEAK[1] }, { id: 9, name: WEAK[2] }];
      expect(edit({ lanes }, { laneNames: WEAK })).toMatchObject({ draft: { lanes } });
      // Changing one to another weak name, or adding a weak new one, is refused.
      expect(edit({ lanes: [{ id: 7, name: "Ring 2\uFE0F" }, { id: 8, name: "Ring 3" }] }, { laneNames: WEAK })).toEqual({ fields: { "lanes.0.name": expect.stringContaining("invisible") } });
      expect(edit({ lanes: [{ id: 7, name: WEAK[0] }, { name: "???" }] }, { laneNames: WEAK })).toEqual({ fields: { "lanes.1.name": expect.stringContaining("letter or number") } });
    });

    it("is not refused for a field label the event already has", () => {
      const fields = [F("Do\uFE0Fg"), F("!!!", { identity: false })];
      expect(edit({ fields }, { fieldLabels: ["Do\uFE0Fg", "!!!"] })).toMatchObject({ draft: { fields } });
      expect(edit({ fields }, { fieldLabels: ["Do\uFE0Fg"] })).toEqual({ fields: { "fields.1.label": expect.stringContaining("letter or number") } });
    });

    it("still refuses two stored names that are one name, unless both are stored as they are; one new look-alike is refused", () => {
      const both = [{ id: 7, name: "Ring 1" }, { id: 8, name: "Ring 1\uFE0F" }];
      expect(edit({ lanes: both }, { laneNames: ["Ring 1", "Ring 1\uFE0F"] })).toMatchObject({ draft: { lanes: both } });
      expect(edit({ lanes: both }, { laneNames: ["Ring 1"] })).toEqual({ fields: { "lanes.1.name": expect.stringContaining("invisible") } });
      // A look-alike that is new is refused as a duplicate of the stored name.
      expect(edit({ lanes: [{ id: 7, name: "Ring 1" }, { id: 8, name: "RING 1" }] }, { laneNames: ["Ring 1"] })).toEqual({ fields: { "lanes.1.name": "Two lanes can't have the same name." } });
    });
  });
});

describe("insertEventWithBreaks", () => {
  let t: TestEnv;
  beforeAll(async () => { t = await createTestEnv(); });
  afterAll(async () => { await t.dispose(); });

  it("stores the event and every break", async () => {
    const d = draftOf({ breaks: [{ start: "10:00", end: "10:15" }, { start: "11:00", end: "11:15" }] });
    const slug = generateSlug();
    await insertEventWithBreaks(t.env.DB, slug, d, "insert-key-aaaaaaaaaaaaaa");
    const row = await t.env.DB.prepare("SELECT * FROM events WHERE slug = ?").bind(slug).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      name: "Saturday trial day", start_utc: "2026-10-24T08:00:00Z", end_utc: "2026-10-24T11:00:00Z",
      session_minutes: 15, gap_minutes: 0, cost_pence: 1500, venue_postcode: "AB1 2CD", details: "Bring water", archived: 0,
      idempotency_key: "insert-key-aaaaaaaaaaaaaa",
    });
    const { results } = await t.env.DB.prepare("SELECT start_utc, end_utc FROM breaks WHERE event_id = ? ORDER BY start_utc").bind(row!.id).all();
    expect(results).toEqual([
      { start_utc: "2026-10-24T09:00:00Z", end_utc: "2026-10-24T09:15:00Z" },
      { start_utc: "2026-10-24T10:00:00Z", end_utc: "2026-10-24T10:15:00Z" },
    ]);
  });

  it("stores each break's label, and loadEventBySlug returns them with the times, in start order", async () => {
    const d = draftOf({ breaks: [{ start: "11:00", end: "11:15" }, { start: "10:00", end: "10:15", label: "Lunch 🍽" }] });
    const slug = generateSlug();
    await insertEventWithBreaks(t.env.DB, slug, d, "insert-key-cccccccccccccc");
    const event = await loadEventBySlug(t.env.DB, slug);
    expect(event?.breaks).toEqual([
      { start: "2026-10-24T09:00:00Z", end: "2026-10-24T09:15:00Z", label: "Lunch 🍽" },
      { start: "2026-10-24T10:00:00Z", end: "2026-10-24T10:15:00Z", label: "" },
    ]);
  });

  it("stores the share message, or an empty one when the draft has none, and loadEventBySlug returns it", async () => {
    const withMessage = generateSlug();
    await insertEventWithBreaks(t.env.DB, withMessage, draftOf({ shareMessage: "Join {event}" }), "insert-key-dddddddddddddd");
    const without = generateSlug();
    await insertEventWithBreaks(t.env.DB, without, draftOf(), "insert-key-eeeeeeeeeeeeee");
    expect((await loadEventBySlug(t.env.DB, withMessage))?.shareMessage).toBe("Join {event}");
    expect((await loadEventBySlug(t.env.DB, without))?.shareMessage).toBe("");
  });

  it("is atomic: a break the database refuses after the event insert leaves no event and no breaks", async () => {
    const d = draftOf({ breaks: [{ start: "10:00", end: "10:15" }, { start: "11:00", end: "11:15" }] });
    // Bypass validation: a malformed instant fails the breaks table's CHECK on the second break.
    const bad: EventDraft = { ...d, breaks: [d.breaks[0], { ...d.breaks[1], startUtc: "not a time" }] };
    const events = await countRows(t.env.DB, "events");
    const breaks = await countRows(t.env.DB, "breaks");
    const slug = generateSlug();
    await expect(insertEventWithBreaks(t.env.DB, slug, bad, "insert-key-bbbbbbbbbbbbbb")).rejects.toThrow();
    expect(await countRows(t.env.DB, "events")).toBe(events);
    expect(await countRows(t.env.DB, "breaks")).toBe(breaks);
    expect(await t.env.DB.prepare("SELECT 1 FROM events WHERE slug = ?").bind(slug).first()).toBeNull();
  });
});

describe("event name, break name and details: format characters (Unicode category Cf)", () => {
  const cases: Array<[string, (value: string) => string | undefined]> = [
    ["event name", (value) => fieldsOf({ name: value }).name],
    ["break name", (value) => fieldsOf({ breaks: [{ start: "10:00", end: "10:30", label: value }] })["breaks.0.label"]],
    ["details", (value) => fieldsOf({ details: value }).details],
  ];

  it.each(cases)("rejects every Cf character in the %s", (_label, errorOf) => {
    const wrong: string[] = [];
    for (const cp of FORMAT_CODE_POINTS) {
      if (!errorOf(`a${String.fromCodePoint(cp)}b`)?.includes("invisible")) wrong.push(hex(cp));
    }
    expect(wrong).toEqual([]);
  });

  it.each(cases)("rejects each known format character (hand-listed, and in the scan) in the %s", (_label, errorOf) => {
    for (const cp of ANCHOR_CODE_POINTS) {
      expect(FORMAT_CODE_POINTS, hex(cp)).toContain(cp);
      expect(errorOf(`a${String.fromCodePoint(cp)}b`), hex(cp)).toContain("invisible");
    }
  });

  it.each(cases)("rejects U+061C ARABIC LETTER MARK in the %s by name", (_label, errorOf) => {
    expect(errorOf("a\u061Cb")).toMatch(/can't contain invisible or direction-changing characters/);
  });

  it("still accepts ordinary text", () => {
    for (const text of ORDINARY_NAMES) {
      expect(draftOf({ name: text, details: text, breaks: [{ start: "10:00", end: "10:30", label: text }] })).toMatchObject({ name: text, details: text });
    }
  });
});

describe("creating an event with lanes and places", () => {
  let t: TestEnv;
  beforeAll(async () => { t = await createTestEnv(); });
  afterAll(async () => { await t.dispose(); });

  const lanes = (...names: string[]) => names.map((name) => ({ name }));
  const layoutOf = async (slug: string) => {
    const event = (await loadEventBySlug(t.env.DB, slug))!;
    return { lanes: event.lanes.map((l) => [l.position, l.name]), capacity: event.capacity, identityLimit: event.identityLimit, configRev: event.configRev };
  };

  it("stores one unnamed lane and capacity 1 for a draft that says nothing, and the lanes and capacity it does say, in order", async () => {
    const plain = await createEvent(t.env.DB, draftOf(), "create-key-aaaaaaaaaaaaaa");
    expect(await layoutOf(plain.saved.slug)).toEqual({ lanes: [[1, ""]], capacity: 1, identityLimit: 1, configRev: 0 });
    expect(plain.saved.lanes).toEqual([{ id: expect.any(Number), name: "" }]);
    const made = await createEvent(t.env.DB, draftOf({ lanes: lanes("Ring 2", "Ring 1", "Ring 3"), capacity: 4 }), "create-key-bbbbbbbbbbbbbb");
    expect(made.kind).toBe("created");
    expect(await layoutOf(made.saved.slug)).toEqual({ lanes: [[1, "Ring 2"], [2, "Ring 1"], [3, "Ring 3"]], capacity: 4, identityLimit: 1, configRev: 0 });
    const event = (await loadEventBySlug(t.env.DB, made.saved.slug))!;
    expect(made.saved.lanes).toEqual(event.lanes.map((l) => ({ id: l.id, name: l.name })));
    expect(createdBody(made.saved).event).toMatchObject({ lanes: made.saved.lanes, capacity: 4 });
  });

  it("answers a retry with the same lanes and capacity as a replay, whatever the lane ids are", async () => {
    const d = draftOf({ lanes: lanes("Ring 1", "Ring 2"), capacity: 2 });
    const first = await createEvent(t.env.DB, d, "create-key-cccccccccccccc");
    const again = await createEvent(t.env.DB, d, "create-key-cccccccccccccc");
    expect(again.kind).toBe("replayed");
    expect(createdBody(again.saved)).toEqual(createdBody(first.saved));
    expect(again.saved.lanes).toEqual(first.saved.lanes);
    expect((await findEventByKey(t.env.DB, "create-key-cccccccccccccc", d))?.kind).toBe("replayed");
  });

  it.each([
    ["other lanes", { lanes: lanes("Ring 1", "Ring 3"), capacity: 2 }],
    ["lanes in another order", { lanes: lanes("Ring 2", "Ring 1"), capacity: 2 }],
    ["another case", { lanes: lanes("ring 1", "Ring 2"), capacity: 2 }],
    ["another lane count", { lanes: lanes("Ring 1"), capacity: 2 }],
    ["another capacity", { lanes: lanes("Ring 1", "Ring 2"), capacity: 3 }],
    ["no lanes or capacity", {}],
  ])("reports the key as reused when the retry has %s, carrying the event as stored", async (name, over) => {
    const key = `reuse-key-${name.replace(/\W/g, "-")}`;
    const first = await createEvent(t.env.DB, draftOf({ lanes: lanes("Ring 1", "Ring 2"), capacity: 2 }), key);
    const again = await createEvent(t.env.DB, draftOf(over), key);
    expect(again.kind).toBe("idempotency_key_reuse");
    expect(again.saved.lanes.map((l) => l.name)).toEqual(["Ring 1", "Ring 2"]);
    expect(again.saved.capacity).toBe(2);
    expect(again.saved.slug).toBe(first.saved.slug);
  });

  it("treats a draft with no lanes or capacity as the same as one unnamed lane and capacity 1", async () => {
    const first = await createEvent(t.env.DB, draftOf(), "create-key-dddddddddddddd");
    expect((await createEvent(t.env.DB, draftOf({ lanes: lanes(""), capacity: 1 }), "create-key-dddddddddddddd")).kind).toBe("replayed");
    expect(first.kind).toBe("created");
  });

  it("is atomic: a lane the database refuses leaves no event, no layout and no lanes", async () => {
    const bad: EventDraft = { ...draftOf(), lanes: lanes("Same", "same") }; // validation would refuse this; the unique index must too
    const before = [await countRows(t.env.DB, "events"), await countRows(t.env.DB, "event_layout"), await countRows(t.env.DB, "event_lanes")];
    await expect(insertEventWithBreaks(t.env.DB, generateSlug(), bad, "create-key-eeeeeeeeeeeeee")).rejects.toThrow(/UNIQUE/);
    expect([await countRows(t.env.DB, "events"), await countRows(t.env.DB, "event_layout"), await countRows(t.env.DB, "event_lanes")]).toEqual(before);
  });
});

describe("listAdminEvents: lanes and places", () => {
  let t: TestEnv;
  beforeAll(async () => { t = await createTestEnv(); });
  afterAll(async () => { await t.dispose(); });

  it("names each upcoming event's lanes, in lane order and without their ids", async () => {
    const { insertEvent } = await import("../test/db");
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-25T08:00:00Z", endUtc: "2026-10-25T08:30:00Z", lanes: ["Ring 1", "Ring 2"] });
    const listed = (await listAdminEvents(t.env.DB, NOW, 0)).events.find((x) => x.slug === e.slug)!;
    expect(listed.lanes).toEqual([{ name: "Ring 1" }, { name: "Ring 2" }]);
  });

  it("adds laneCount, capacity and placeCount, and is full only when every place is booked", async () => {
    const { insertBooking, insertEvent } = await import("../test/db");
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T08:30:00Z", capacity: 2, lanes: ["A", "B"] });
    const list = async () => (await listAdminEvents(t.env.DB, NOW, 0)).events.find((x) => x.slug === e.slug)!;
    expect(await list()).toMatchObject({ slotCount: 2, bookedCount: 0, laneCount: 2, capacity: 2, placeCount: 8, full: false });
    for (const [i, lane] of [e.laneIds[0], e.laneIds[0], e.laneIds[1], e.laneIds[1]].entries()) {
      await insertBooking(t.env.DB, e.id, i < 2 ? "2026-10-24T08:00:00Z" : "2026-10-24T08:15:00Z", `D${i}`, "H", { laneId: lane });
    }
    expect(await list()).toMatchObject({ bookedCount: 4, placeCount: 8, full: false });
    for (const [i, lane] of [e.laneIds[1], e.laneIds[1], e.laneIds[0], e.laneIds[0]].entries()) {
      await insertBooking(t.env.DB, e.id, i < 2 ? "2026-10-24T08:00:00Z" : "2026-10-24T08:15:00Z", `E${i}`, "H", { laneId: lane });
    }
    expect(await list()).toMatchObject({ bookedCount: 8, full: true });
  });
});

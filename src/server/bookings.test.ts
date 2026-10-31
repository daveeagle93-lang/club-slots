import { describe, expect, it } from "vitest";
import { ANCHOR_CODE_POINTS, FORMAT_CODE_POINTS, hex, ORDINARY_NAMES } from "../test/format-chars";
import { checkFieldValue, checkFieldValues, readJsonObject, validateBookingInput } from "./bookings";
import type { EventField } from "./events";

const request = (body: string): Request =>
  new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body });

/** A JSON object whose serialised form is exactly `bytes` bytes. */
const objectOfSize = (bytes: number): string => {
  const base = JSON.stringify({ p: "" });
  return JSON.stringify({ p: "x".repeat(bytes - base.length) });
};

describe("readJsonObject body cap", () => {
  it("defaults to 4096 bytes", async () => {
    expect(await readJsonObject(request(objectOfSize(4096)))).toEqual({ p: expect.any(String) });
    const over = await readJsonObject(request(objectOfSize(4097)));
    expect(over).toBeInstanceOf(Response);
    expect((over as Response).status).toBe(413);
  });

  it("takes a larger cap, and still enforces it", async () => {
    expect(await readJsonObject(request(objectOfSize(32768)), 32768)).toEqual({ p: expect.any(String) });
    const over = await readJsonObject(request(objectOfSize(32769)), 32768);
    expect(over).toBeInstanceOf(Response);
    expect((over as Response).status).toBe(413);
  });
});

const DOG_HANDLER: EventField[] = [
  { position: 1, label: "Dog", required: true, maxLength: 80, identity: true },
  { position: 2, label: "Handler", required: true, maxLength: 80, identity: true },
];
const ONE_LANE = { lanes: [{ id: 1, position: 1, name: "" }], fields: DOG_HANDLER };

describe("validateBookingInput: values", () => {
  const input = (over: Record<string, unknown>) =>
    validateBookingInput({ slot: "2026-10-24T09:00:00.000Z", field1: "Fly", field2: "Pat", idempotencyKey: "k".repeat(16), ...over }, ONE_LANE);
  const fieldsOf = (over: Record<string, unknown>) => {
    const r = input(over);
    return "fields" in r ? r.fields : null;
  };
  const valuesOf = (over: Record<string, unknown>) => {
    const r = input(over);
    return "values" in r ? r.values : null;
  };
  const KEYS = ["field1", "field2"];

  it("finds format characters to test", () => {
    expect(FORMAT_CODE_POINTS.length).toBeGreaterThan(100);
    expect(FORMAT_CODE_POINTS).toContain(0x061c);
  });

  it.each(ANCHOR_CODE_POINTS)("lists the known format character %#, and a Dog or Handler value containing it is refused", (cp) => {
    expect(FORMAT_CODE_POINTS, hex(cp)).toContain(cp);
    for (const key of KEYS) {
      expect(fieldsOf({ [key]: `a${String.fromCodePoint(cp)}b` })?.[key], `${hex(cp)} in ${key}`).toContain("invisible");
    }
  });

  it("rejects every Unicode format character (Cf) in a Dog value and a Handler value", () => {
    const accepted: string[] = [];
    for (const cp of FORMAT_CODE_POINTS) {
      const ch = String.fromCodePoint(cp);
      for (const key of KEYS) {
        for (const value of [`a${ch}b`, `${ch}ab`, `ab${ch}`]) {
          if (!fieldsOf({ [key]: value })?.[key]?.includes("invisible")) accepted.push(`${hex(cp)} in ${key}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  });

  it("rejects U+061C ARABIC LETTER MARK by name", () => {
    expect(fieldsOf({ field1: "Fl\u061Cy" })?.field1).toBe("Dog can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.");
    expect(fieldsOf({ field2: "P\u061Cat" })?.field2).toBe("Handler can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.");
  });

  it.each(["\u200C", "\u200D"])("rejects the joiner %j, which is Cf", (ch) => {
    expect(fieldsOf({ field1: `a${ch}b` })).toHaveProperty("field1");
  });

  // The shared list also holds a plain emoji ("🐕"), which event and club names accept but a booking value does not.
  it.each(ORDINARY_NAMES.filter((n) => /[\p{L}\p{N}]/u.test(n)))("still accepts %s", (name) => {
    expect(valuesOf({ field1: name, field2: name })).toEqual([name, name]);
  });

  it.each([
    ["Hangul filler U+3164", "\u3164"],
    ["halfwidth Hangul filler U+FFA0", "\uFFA0"],
    ["braille blank U+2800", "\u2800"],
    ["variation selector-16", "\uFE0F"],
    ["a variation selector and a tag-range selector", "\uFE0F\u{E0100}"],
    ["combining grapheme joiner", "\u034F"],
    ["a plain emoji", "\u{1F436}"],
    ["an emoji and spaces", " \u{1F436} \u2764\uFE0F "],
    ["punctuation only", "-'.!"],
  ])("refuses a Dog and a Handler value with no letter or number in it: %s", (_what, name) => {
    for (const [key, label] of [["field1", "Dog"], ["field2", "Handler"]]) {
      expect(fieldsOf({ [key]: name })?.[key], key).toBe(`${label} must contain at least one letter or number.`);
    }
  });

  const PRIVATE_USE_MESSAGE = (label: string) => `${label} can't contain private-use or blank-looking characters. Try plain text.`;

  it.each([
    ["private use, BMP start U+E000", "\uE000"],
    ["private use, BMP end U+F8FF", "\uF8FF"],
    ["private use, plane 15 U+F0000", "\u{F0000}"],
    ["private use, plane 16 U+10FFFD", "\u{10FFFD}"],
    ["braille blank U+2800", "\u2800"],
  ])("refuses %s beside a real letter, inside, at the start and at the end of a Dog and a Handler value", (_what, ch) => {
    expect(/^[\p{Co}\u2800]$/u.test(ch)).toBe(true);
    for (const make of [(n: string) => `${n}${ch}${n}`, (n: string) => `${ch}${n}`, (n: string) => `${n}${ch}`]) {
      expect(fieldsOf({ field1: make("Rex"), field2: make("Sam") }), JSON.stringify(make("Rex")))
        .toEqual({ field1: PRIVATE_USE_MESSAGE("Dog"), field2: PRIVATE_USE_MESSAGE("Handler") });
    }
  });

  it("does not refuse unassigned code points (Cn): a character a newer runtime has assigned (a new emoji) must not break values", () => {
    const unassigned = "\uFFFF"; // a noncharacter: category Cn, never to be assigned
    expect(/^\p{Cn}$/u.test(unassigned)).toBe(true);
    expect(valuesOf({ field1: `Rex${unassigned}`, field2: `${unassigned}Sam` })).toEqual([`Rex${unassigned}`, `${unassigned}Sam`]);
  });

  it("says the label is required for a missing, empty, all-whitespace or non-text value", () => {
    expect(fieldsOf({ field1: "   " })?.field1).toBe("Dog is required.");
    expect(fieldsOf({ field2: "" })?.field2).toBe("Handler is required.");
    expect(fieldsOf({ field1: undefined })?.field1).toBe("Dog is required.");
    expect(fieldsOf({ field2: 7 })?.field2).toBe("Handler is required.");
    expect(fieldsOf({ field2: null })?.field2).toBe("Handler is required.");
  });

  it.each(["Rex \u2764\uFE0F", "Zo\u00EB", "7", "\uFF21\uFF4E\uFF4E", "Rex\uFE0F"])("accepts %j, which has a letter or number", (name) => {
    expect(valuesOf({ field1: name, field2: name })).toEqual([name.trim(), name.trim()]);
  });

  it("returns the trimmed values in the form's order, with the lane and slot", () => {
    expect(input({ field1: "  Rex ", field2: " Sam  Jones" })).toEqual({
      slot: "2026-10-24T09:00:00.000Z", laneId: 1, values: ["Rex", "Sam  Jones"], idempotencyKey: "k".repeat(16),
    });
  });

  it("keys every error by the field's number, next to the slot, lane and key errors", () => {
    expect(fieldsOf({ slot: 1, field1: "", field2: "\u200B", idempotencyKey: "x", laneId: 99 })).toEqual({
      field1: "Dog is required.", field2: expect.stringContaining("invisible"), slot: "Choose a slot.", laneId: "Choose a lane.", idempotencyKey: "Reload the page and try again.",
    });
  });

  it("no longer reads dogName and handlerName", () => {
    expect(fieldsOf({ field1: undefined, field2: undefined, dogName: "Rex", handlerName: "Sam" })).toEqual({ field1: "Dog is required.", field2: "Handler is required." });
  });
});

describe("checkFieldValue: every limit and message", () => {
  const field = (over: Partial<Pick<EventField, "label" | "required" | "maxLength">> = {}) => ({ label: "Pony", required: true, maxLength: 10, ...over });
  const message = (value: unknown, over = {}) => {
    const r = checkFieldValue(value, field(over));
    return "message" in r ? r.message : null;
  };
  const valueOf = (value: unknown, over = {}) => {
    const r = checkFieldValue(value, field(over));
    return "value" in r ? r.value : null;
  };

  it("names the field by its bare label in every message", () => {
    expect(message(undefined)).toBe("Pony is required.");
    expect(message("  ")).toBe("Pony is required.");
    expect(message("x".repeat(11))).toBe("Pony must be at most 10 characters.");
    expect(message("a\u200Bb")).toBe("Pony can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.");
    expect(message("a\u2028b")).toBe("Pony can't contain line or paragraph separators.");
    expect(message("a\u2029b")).toBe("Pony can't contain line or paragraph separators.");
    expect(message("a\u0007b")).toBe("Pony can't contain control characters.");
    expect(message("a\nb")).toBe("Pony can't contain control characters.");
    expect(message("a\ud800b")).toBe("Pony can't contain unpaired surrogate characters.");
    expect(message("🐴")).toBe("Pony must contain at least one letter or number.");
    expect(message("a\uE000")).toBe("Pony can't contain private-use or blank-looking characters. Try plain text.");
  });

  it("counts the longest value in code points of the trimmed text, per field", () => {
    expect(valueOf("é".repeat(10))).toBe("é".repeat(10));
    expect(valueOf("🐴".repeat(5) + "a".repeat(5))).toBe("🐴".repeat(5) + "a".repeat(5));
    expect(message("🐴".repeat(5) + "a".repeat(6))).toBe("Pony must be at most 10 characters.");
    expect(valueOf(`  ${"a".repeat(10)}  `)).toBe("a".repeat(10));
    expect(message("a", { maxLength: 1 })).toBeNull();
    expect(message("ab", { maxLength: 1 })).toBe("Pony must be at most 1 characters.");
    expect(valueOf("a".repeat(80), { maxLength: 80 })).toBe("a".repeat(80));
    expect(message("a".repeat(81), { maxLength: 80 })).toBe("Pony must be at most 80 characters.");
  });

  it("uses the label exactly as configured, whatever it is", () => {
    expect(message("", { label: "Car reg" })).toBe("Car reg is required.");
    expect(message("x".repeat(11), { label: "Phone (mobile)" })).toBe("Phone (mobile) must be at most 10 characters.");
  });

  it("lets an optional field be missing, null, empty or blank (its value is then \"\"), and still applies every other rule to what is typed", () => {
    for (const blank of [undefined, null, "", "   "]) expect(valueOf(blank, { required: false })).toBe("");
    expect(valueOf(" Nervous ", { required: false })).toBe("Nervous");
    expect(message("🐴", { required: false })).toBe("Pony must contain at least one letter or number.");
    expect(message("a\u200Bb", { required: false })).toContain("invisible");
    expect(message("x".repeat(11), { required: false })).toBe("Pony must be at most 10 characters.");
    expect(message(7, { required: false })).toBe("Pony must be text.");
    expect(message("\u200B", { required: false })).toContain("invisible"); // blank-looking is not blank
  });

  it("never lets a required field be blank", () => {
    for (const blank of [undefined, null, "", "   ", 7, {}, []]) expect(message(blank), JSON.stringify(blank)).toBe("Pony is required.");
  });
});

describe("checkFieldValues: a form of any shape", () => {
  const form = (...rest: Partial<EventField>[]): EventField[] =>
    rest.map((f, i) => ({ position: i + 1, label: `F${i + 1}`, required: true, maxLength: 80, identity: i === 0, ...f }));

  it("reads field1 to field4 in the form's order and ignores keys past the form", () => {
    expect(checkFieldValues({ field1: "a", field2: "b", field3: "c", field4: "d", field5: "x" }, form({}, {}, {}, {}))).toEqual({ values: ["a", "b", "c", "d"] });
    expect(checkFieldValues({ field1: "a", field2: "ignored", dogName: "ignored" }, form({}))).toEqual({ values: ["a"] });
  });

  it("gives \"\" for an optional field left out, in its place", () => {
    expect(checkFieldValues({ field1: "Ann", field3: "Biscuit" }, form({ label: "Rider" }, { label: "Phone", required: false }, { label: "Pony" }))).toEqual({ values: ["Ann", "", "Biscuit"] });
  });

  it("reports every field that fails, keyed by number, with its own label and longest value", () => {
    expect(checkFieldValues({ field1: "", field2: "toolong", field3: "fine", field4: "🐴" }, form({ label: "Rider" }, { label: "Pony", maxLength: 3 }, {}, { label: "Notes", required: false }))).toEqual({
      errors: { field1: "Rider is required.", field2: "Pony must be at most 3 characters.", field4: "Notes must contain at least one letter or number." },
    });
  });
});

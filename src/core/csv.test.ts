import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("csvCell", () => {
  it("wraps every field in double quotes", () => {
    expect(csvCell("Rex")).toBe('"Rex"');
    expect(csvCell("")).toBe('""');
  });

  it("doubles internal double quotes", () => {
    expect(csvCell('Rex "the dog"')).toBe('"Rex ""the dog"""');
  });

  it("keeps commas and line breaks inside the quotes", () => {
    expect(csvCell("Smith, Sam")).toBe('"Smith, Sam"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
    expect(csvCell("a\rb")).toBe('"a\rb"');
  });

  it("keeps unicode as it is", () => {
    expect(csvCell("Zoë Ñandú 犬 🐕")).toBe('"Zoë Ñandú 犬 🐕"');
  });

  it.each(["=", "+", "-", "@", "\t", "\r"])("prefixes a single quote when the text starts with %j", (c) => {
    expect(csvCell(`${c}1+1`)).toBe(`"'${c}1+1"`);
  });

  it("protects names that are only a trigger or start with one", () => {
    expect(csvCell("-")).toBe(`"'-"`);
    expect(csvCell("@home")).toBe(`"'@home"`);
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });

  it("leaves text unchanged when the trigger is not the first character", () => {
    expect(csvCell("a=b")).toBe('"a=b"');
    expect(csvCell("Sam-Jo")).toBe('"Sam-Jo"');
    expect(csvCell("x@home")).toBe('"x@home"');
    expect(csvCell(" =1")).toBe('" =1"');
    expect(csvCell("a\t")).toBe('"a\t"');
  });

  it.each([["＝", "U+FF1D"], ["＋", "U+FF0B"], ["－", "U+FF0D"], ["＠", "U+FF20"]])(
    "prefixes a single quote when the text starts with the fullwidth %s (%s), which a spreadsheet may read as the ASCII one",
    (c) => {
      expect(csvCell(`${c}1`)).toBe(`"'${c}1"`);
      expect(csvCell(c)).toBe(`"'${c}"`);
    },
  );

  it("adds the prefix to the original text, changing nothing else, and leaves letters alone even if normalising changes them", () => {
    expect(csvCell("＝SUM(A1)")).toBe(`"'＝SUM(A1)"`);
    expect(csvCell("Rex")).toBe('"Rex"');
    expect(csvCell("ﬁdo")).toBe('"ﬁdo"'); // NFKC turns the ligature into "fi", still a letter
    expect(csvCell("Ｚoë")).toBe('"Ｚoë"');
    expect(csvCell("a＝b")).toBe('"a＝b"');
  });

  it("leaves a date and time unchanged", () => {
    expect(csvCell("2026-06-13 09:00")).toBe('"2026-06-13 09:00"');
  });
});

describe("toCsv", () => {
  const BOM = "\uFEFF";

  it("starts with a UTF-8 byte order mark and ends every row with CRLF", () => {
    const out = toCsv([["Time", "Dog", "Handler", "Booked at"], ["2026-06-13 09:00", "Rex", "Sam", "2026-06-01 10:00"]]);
    expect(out).toBe(
      `${BOM}"Time","Dog","Handler","Booked at"\r\n"2026-06-13 09:00","Rex","Sam","2026-06-01 10:00"\r\n`,
    );
    expect(new TextEncoder().encode(out).slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
  });

  it("is only the byte order mark when there are no rows", () => {
    expect(toCsv([])).toBe(BOM);
  });

  it("protects every cell, including those after the first, and quotes embedded breaks", () => {
    expect(toCsv([["t", "-", "@home"], ["t", 'a"b', "x\r\ny"]])).toBe(`${BOM}"t","'-","'@home"\r\n"t","a""b","x\r\ny"\r\n`);
  });

  it("writes an empty row as one empty quoted field per column given", () => {
    expect(toCsv([[""]])).toBe(`${BOM}""\r\n`);
  });
});

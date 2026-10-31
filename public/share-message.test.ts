import { describe, expect, it } from "vitest";
import { BUILT_IN_SHARE_TEMPLATE, MAX_SHARE_MESSAGE_LENGTH, PLACEHOLDERS, buildShareMessage, pickShareTemplate, renderShareTemplate } from "./share-message.js";

const EVENT = {
  name: "Trial Day", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T15:00:00Z", costPence: 1200,
  venuePostcode: "SW1A 1AA", details: "Bring water",
};
const LINK = "https://club.example/e/abc123";
const build = (template: string, extra: Record<string, unknown> = {}, event: Record<string, unknown> = {}) =>
  buildShareMessage({ event: { ...EVENT, ...event }, clubName: "Hillside Dog Club", link: LINK, template, ...extra } as never);

describe("the template pieces", () => {
  it("pins the placeholders, in order", () => {
    expect(PLACEHOLDERS.map((p) => p.token)).toEqual(
      ["{event}", "{date}", "{start}", "{end}", "{cost}", "{postcode}", "{details}", "{lanes}", "{club}", "{link}"],
    );
    for (const p of PLACEHOLDERS) expect(p.meaning).toMatch(/\S/);
  });

  it("pins the built-in template", () => {
    expect(BUILT_IN_SHARE_TEMPLATE).toBe("{club}\n{event}\n{date}, {start}–{end}\nVenue: {postcode}\nCost: {cost}\nBook your slot:\n{link}");
  });

  it("picks the event's own message, then the default template's, then the built-in one", () => {
    expect(pickShareTemplate({ shareMessage: "Own" }, "Default")).toBe("Own");
    expect(pickShareTemplate({ shareMessage: "" }, "Default")).toBe("Default");
    expect(pickShareTemplate({}, "Default")).toBe("Default");
    expect(pickShareTemplate({ shareMessage: "" }, "")).toBe(BUILT_IN_SHARE_TEMPLATE);
    expect(pickShareTemplate({ shareMessage: "" }, undefined)).toBe(BUILT_IN_SHARE_TEMPLATE);
  });
});

describe("buildShareMessage", () => {
  it("fills every placeholder", () => {
    expect(build("{event}|{date}|{start}|{end}|{cost}|{postcode}|{details}|{club}|{link}")).toBe(
      `Trial Day|Saturday 13 June 2026|09:00|16:00|£12.00|SW1A 1AA|Bring water|Hillside Dog Club|${LINK}`,
    );
  });

  it("says Free for a free event, and shows London times in winter too", () => {
    expect(build("{cost}\n{link}", {}, { costPence: 0 })).toBe(`Free\n${LINK}`);
    expect(build("{date} {start}-{end}\n{link}", {}, { startUtc: "2026-01-17T09:00:00Z", endUtc: "2026-01-17T16:00:00Z" }))
      .toBe(`Saturday 17 January 2026 09:00-16:00\n${LINK}`);
  });

  it("builds the built-in message for a sample event", () => {
    expect(build(BUILT_IN_SHARE_TEMPLATE)).toBe(
      `Hillside Dog Club\nTrial Day\nSaturday 13 June 2026, 09:00–16:00\nVenue: SW1A 1AA\nCost: £12.00\nBook your slot:\n${LINK}`,
    );
  });

  it("fills a token every time it appears", () => {
    expect(build("{event} / {event} / {link} / {link}")).toBe(`Trial Day / Trial Day / ${LINK} / ${LINK}`);
  });

  it("leaves unknown placeholders exactly as typed, including case variants", () => {
    expect(build("{foo} {Event} {EVENT} {event } { event} {link} {}")).toBe(`{foo} {Event} {EVENT} {event } { event} ${LINK} {}`);
    expect(build("Hi {foo}\n{link}")).toBe(`Hi {foo}\n${LINK}`);
  });

  it("inserts values literally in a single pass", () => {
    const details = "{link} {club} $& $1 $$ $` $'";
    expect(build("{details}\n{link}", {}, { details })).toBe(`${details}\n${LINK}`);
    expect(build("{event}\n{link}", { clubName: "{event}" }, { name: "{club}" })).toBe(`{club}\n${LINK}`);
    expect(build("{club}\n{link}", { clubName: "{link}" })).toBe(`{link}\n${LINK}`);
  });

  it("does not alter HTML-looking text", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    expect(build("{event}\n{details}\n{link}", {}, { name: hostile, details: `<b>${hostile}</b>` }))
      .toBe(`${hostile}\n<b>${hostile}</b>\n${LINK}`);
  });

  it("drops a line whose known placeholders render to nothing, and no other", () => {
    expect(build("{club}\n{event}\n{link}", { clubName: "" })).toBe(`Trial Day\n${LINK}`);
    expect(build("{club}\n{event}\n{link}", { clubName: "   " })).toBe(`Trial Day\n${LINK}`);
    expect(build("{event}\n{details}\n{link}", {}, { details: "" })).toBe(`Trial Day\n${LINK}`);
    expect(build("{club} {details}\n{event}\n{link}", { clubName: "" }, { details: "" })).toBe(`Trial Day\n${LINK}`);
    expect(build("Hello\n\n{event}\n\n{link}")).toBe(`Hello\n\nTrial Day\n\n${LINK}`);
    expect(build("{foo}\n   \n{event}\n{link}")).toBe(`{foo}\n   \nTrial Day\n${LINK}`);
  });

  it("works with no club name at all", () => {
    expect(buildShareMessage({ event: EVENT, link: LINK, template: BUILT_IN_SHARE_TEMPLATE })).toBe(
      `Trial Day\nSaturday 13 June 2026, 09:00–16:00\nVenue: SW1A 1AA\nCost: £12.00\nBook your slot:\n${LINK}`,
    );
  });

  it("appends the link on its own final line when the template has no {link}", () => {
    expect(build("{event}")).toBe(`Trial Day\n${LINK}`);
    expect(build("{event}\nSee you there\n\n\n")).toBe(`Trial Day\nSee you there\n${LINK}`);
    expect(build("")).toBe(LINK);
    expect(build("{club}", { clubName: "" })).toBe(LINK);
  });

  it("does not repeat the link when the template has one, wherever it is", () => {
    for (const template of ["{link}", "Book: {link} now", "{link}\nThen come along"]) {
      expect(build(template).split(LINK)).toHaveLength(2);
    }
    expect(build("{link}\nThen come along")).toBe(`${LINK}\nThen come along`);
  });

  it("does not count a link in a value, or a case variant, as the template's {link}", () => {
    expect(build("{details}", {}, { details: "{link}" })).toBe(`{link}\n${LINK}`);
    expect(build("{Link}")).toBe(`{Link}\n${LINK}`);
  });

  it("treats \\r\\n as \\n", () => {
    expect(build("{event}\r\n{club}\r\n\r\n{link}\r\n")).toBe(`Trial Day\nHillside Dog Club\n\n${LINK}`);
    expect(build("{event}\r\n{details}\r\n{link}", {}, { details: "" })).toBe(`Trial Day\n${LINK}`);
  });

  it("trims trailing whitespace and newlines", () => {
    expect(build("{event}\n{link}\n\n  \n")).toBe(`Trial Day\n${LINK}`);
    expect(build("{event}  \n{details}", {}, { details: "Last line   \n\n" })).toBe(`Trial Day  \nLast line\n${LINK}`);
  });

  it("keeps line breaks inside a value", () => {
    expect(build("{details}\n{link}", {}, { details: "one\ntwo" })).toBe(`one\ntwo\n${LINK}`);
  });
});

describe("cleaning the values", () => {
  it("removes invisible and bidirectional-control characters from every value, but not from the template", () => {
    const dirty = "a\u202Eb\u200Bc\u2028d\u2029e\u2066f\uFEFFg";
    expect(build("{event}|{details}|{club}|{postcode}", { clubName: dirty }, { name: dirty, details: dirty, venuePostcode: dirty })).toBe(
      `abcdefg|abcdefg|abcdefg|abcdefg\n${LINK}`,
    );
    expect(build("keep\u202E{event}")).toBe(`keep\u202ETrial Day\n${LINK}`);
  });

  it("removes control characters, keeping \\n in details and turning it into a space in the single-line values", () => {
    const dirty = "a\u0000b\u0007c\td\u0085e\rf\ng";
    expect(build("{details}", {}, { details: dirty })).toBe(`abcdef\ng\n${LINK}`);
    expect(build("{event}|{club}|{postcode}", { clubName: dirty }, { name: dirty, venuePostcode: dirty })).toBe(`abcdef g|abcdef g|abcdef g\n${LINK}`);
  });

  it("strips control characters, and so any line break, from the link", () => {
    expect(build("{link}", { link: "https://club.example/e/a\nbc\u0000" })).toBe("https://club.example/e/abc");
  });

  it("leaves an emoji name alone (a joined family sequence is shown as separate emoji: its joiners are invisible characters)", () => {
    expect(build("{event}", {}, { name: "Dog 🐕 Day 🎉 ❤️" })).toBe(`Dog 🐕 Day 🎉 ❤️\n${LINK}`);
    expect(build("{event}", {}, { name: "👨\u200D👩" })).toBe(`👨👩\n${LINK}`);
  });

  it("treats missing values as empty", () => {
    expect(build("{event}|{details}|{club}", { clubName: undefined }, { name: undefined, details: undefined })).toBe(`||\n${LINK}`);
  });
});

describe("the {lanes} placeholder", () => {
  const lanes = (...names: string[]) => ({ lanes: names.map((name, i) => ({ id: i + 1, name })) });

  it("is the lane names joined with a comma and a space, in lane order", () => {
    expect(build("Rings: {lanes}\n{link}", {}, lanes("Ring 1", "Ring 2", "Ring 3"))).toBe(`Rings: Ring 1, Ring 2, Ring 3\n${LINK}`);
    expect(build("{lanes}\n{link}", {}, lanes("Only ring"))).toBe(`Only ring\n${LINK}`);
  });

  it("is blank for one unnamed lane, for no lanes and for an event without the key, so a line holding only it is dropped", () => {
    for (const event of [lanes(""), { lanes: [] }, {}]) {
      expect(build("{event}\n{lanes}\n{link}", {}, event)).toBe(`Trial Day\n${LINK}`);
      expect(build("Rings: {lanes}\n{link}", {}, event)).toBe(`Rings: \n${LINK}`);
    }
  });

  it("is cleaned like other user text: line breaks, controls and invisible direction marks", () => {
    expect(build("{lanes}\n{link}", {}, lanes("Ring\n1\u202e", "A\u0007B\u200d"))).toBe(`Ring 1, AB\n${LINK}`);
  });

  it("is inserted literally and never expanded again; other values are never expanded by it", () => {
    expect(build("{lanes}\n{link}", {}, lanes("{event}", "$& {link}"))).toBe(`{event}, $& {link}\n${LINK}`);
    expect(build("{event}|{club}\n{link}", { clubName: "{lanes}" }, { name: "{lanes}", ...lanes("Ring 1") })).toBe(`{lanes}|{lanes}\n${LINK}`);
  });

  it("keeps accents, emoji and markup characters as stored", () => {
    expect(build("{lanes}\n{link}", {}, lanes("Ring Ñ 🐕", "*Big* _ring_ <b>"))).toBe(`Ring Ñ 🐕, *Big* _ring_ <b>\n${LINK}`);
  });

  it("leaves the built-in message byte-identical whatever the lanes", () => {
    const plain = build(BUILT_IN_SHARE_TEMPLATE);
    expect(build(BUILT_IN_SHARE_TEMPLATE, {}, lanes(""))).toBe(plain);
    expect(build(BUILT_IN_SHARE_TEMPLATE, {}, lanes("Ring 1", "Ring 2"))).toBe(plain);
  });

  it("still cuts at the cap with long lane names", () => {
    const names = Array.from({ length: 10 }, (_, i) => `${i}${"L".repeat(39)}`);
    const message = build(Array(20).fill("{lanes}").join(""), {}, lanes(...names));
    expect(message.length).toBe(MAX_SHARE_MESSAGE_LENGTH);
    expect(message.endsWith(`…\n${LINK}`)).toBe(true);
  });
});

describe("the length cap", () => {
  const details = "x".repeat(2000);
  const many = Array(111).fill("{details}").join("");

  it("exports the cap", () => {
    expect(MAX_SHARE_MESSAGE_LENGTH).toBe(4000);
  });

  it("cuts the body, adds an ellipsis and keeps the link as the last line", () => {
    const message = build(many, {}, { details });
    expect(message.length).toBeLessThanOrEqual(MAX_SHARE_MESSAGE_LENGTH);
    expect(message.endsWith(`…\n${LINK}`)).toBe(true);
    expect(message.length).toBe(MAX_SHARE_MESSAGE_LENGTH);
    expect(message.split("\n")).toHaveLength(2);
  });

  it("does not touch a message at or under the cap", () => {
    const exact = build("{details}", {}, { details: "y".repeat(MAX_SHARE_MESSAGE_LENGTH - LINK.length - 1) });
    expect(exact.length).toBe(MAX_SHARE_MESSAGE_LENGTH);
    expect(exact).not.toContain("…");
  });

  it("never splits a surrogate pair, at either cut point", () => {
    // Body room is 4000 - link - 2; put an emoji across it, with one more character either side to shift the cut by one.
    const room = MAX_SHARE_MESSAGE_LENGTH - LINK.length - 2;
    for (const pad of [room - 1, room - 2]) {
      const message = build("{details}", {}, { details: `${"a".repeat(pad)}😀${"b".repeat(50)}` });
      expect(message.length).toBeLessThanOrEqual(MAX_SHARE_MESSAGE_LENGTH);
      expect(message.endsWith(`…\n${LINK}`)).toBe(true);
      expect(encodeURIComponent(message)).toBeTypeOf("string"); // throws URIError on a lone surrogate
    }
    const whole = build("{details}\n{link}", {}, { details: `${"a".repeat(MAX_SHARE_MESSAGE_LENGTH - 2)}😀${"b".repeat(50)}` });
    expect(whole.length).toBeLessThanOrEqual(MAX_SHARE_MESSAGE_LENGTH);
    expect(() => encodeURIComponent(whole)).not.toThrow();
  });

  it("with {link} in the template cuts the whole text at the cap and adds an ellipsis", () => {
    const long = build(`{link}\n${many}`, {}, { details });
    expect(long.length).toBeLessThanOrEqual(MAX_SHARE_MESSAGE_LENGTH);
    expect(long.endsWith("…")).toBe(true);
    expect(long.startsWith(LINK)).toBe(true);
    expect(build("{details}\n{link}\nafter", {}, { details })).toBe(`${details}\n${LINK}\nafter`); // short enough: untouched
  });

  it("bounds the encoded WhatsApp text too", () => {
    const message = build(many, {}, { details: "é".repeat(2000) });
    expect(message.length).toBeLessThanOrEqual(MAX_SHARE_MESSAGE_LENGTH);
    expect(encodeURIComponent(message).length).toBeLessThanOrEqual(MAX_SHARE_MESSAGE_LENGTH * 9);
  });
});

describe("renderShareTemplate", () => {
  it("uses only the values it is given", () => {
    expect(renderShareTemplate("{a} {b} {toString} {constructor}", { a: "1" })).toBe("1 {b} {toString} {constructor}");
  });

  it("treats a missing value as empty", () => {
    expect(renderShareTemplate("x{a}y\n{a}\nz", { a: undefined })).toBe("xy\nz");
  });
});

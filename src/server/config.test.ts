import { afterEach, describe, expect, it, vi } from "vitest";
import { bookingCutoffOffsetMinutes, defaultPrivacyNotice, privacyNotice } from "./config";

const DOG_HANDLER = ["Dog", "Handler"];

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => warn.mockClear());

describe("bookingCutoffOffsetMinutes", () => {
  it.each([
    ["0", 0], ["30", 30], ["-30", -30], ["+45", 45], [" 15 ", 15], ["007", 7],
    ["10080", 10080], ["-10080", -10080],
  ])("accepts %j as %d without warning", (raw, expected) => {
    expect(bookingCutoffOffsetMinutes(raw)).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it("defaults to 0, silently, when unset", () => {
    expect(bookingCutoffOffsetMinutes(undefined)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "abc", "1.5", "30m", "1e2", "0x10", "--5", "10081", "-10081", "99999999999999999999", "NaN", "Infinity"])(
    "falls back to 0 and warns once, naming the variable, for %j",
    (raw) => {
      expect(bookingCutoffOffsetMinutes(raw)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("BOOKING_CUTOFF_OFFSET_MINUTES");
    },
  );
});

describe("privacyNotice", () => {
  const REST = "The club's organisers can see these details; other people using this page only see which slots are taken. "
    + "The organisers may share the running order, with names, with other participants (for example in a group chat). "
    + "The details are kept until an organiser deletes the event; nothing is deleted automatically.";

  it("has a British English default that names the labels of the booking form, and says what this build really does: names can be shared as a running order, and details are kept until an organiser deletes the event", () => {
    expect(defaultPrivacyNotice(DOG_HANDLER)).toBe(`We store the details you enter on this form (Dog, Handler) and the slot you choose so the club can run the event. ${REST}`);
    expect(defaultPrivacyNotice(DOG_HANDLER)).not.toMatch(/deletes booking details after/i);
  });

  it("lists one label, or four, in the order of the form", () => {
    expect(defaultPrivacyNotice(["Name"])).toBe(`We store the details you enter on this form (Name) and the slot you choose so the club can run the event. ${REST}`);
    expect(defaultPrivacyNotice(["Rider", "Pony", "Phone", "Notes"])).toContain("(Rider, Pony, Phone, Notes)");
  });

  it.each([undefined, "", "   ", "\n\n \t\n"])("uses the default for %j", (raw) => {
    expect(privacyNotice(raw, DOG_HANDLER)).toBe(defaultPrivacyNotice(DOG_HANDLER));
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses a custom notice, trimmed, keeping blank lines between paragraphs, whatever the labels", () => {
    expect(privacyNotice("  First paragraph.\n\nSecond paragraph.\n ", DOG_HANDLER)).toBe("First paragraph.\n\nSecond paragraph.");
    expect(privacyNotice("  First paragraph.  ", ["Name"])).toBe("First paragraph.");
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a notice of exactly 1000 code points", () => {
    const exact = "é".repeat(1000);
    expect(privacyNotice(exact, DOG_HANDLER)).toBe(exact);
    expect(warn).not.toHaveBeenCalled();
  });

  it("truncates to 1000 code points, not UTF-16 units, and warns once", () => {
    const long = "🐕".repeat(1001);
    const result = privacyNotice(long, DOG_HANDLER);
    expect([...result]).toHaveLength(1000);
    expect(result.isWellFormed()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("PRIVACY_NOTICE");
  });
});

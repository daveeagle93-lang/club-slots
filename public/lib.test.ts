import { describe, expect, it } from "vitest";
import { formatPounds as serverFormatPounds } from "../src/core/format";
import {
  copyText, formatDate, formatPounds, formatTime, formatTimeRange, isBookingPath, mapsUrl, newIdempotencyKey,
  penceFromPounds, placesLeftText, privacyParagraphs, slotsLeftText, slugFromPathname,
} from "./lib.js";

describe("London formatting", () => {
  it("formats times in London across BST and GMT", () => {
    expect(formatTime("2026-06-13T08:00:00Z")).toBe("09:00"); // BST
    expect(formatTime("2026-01-17T09:00:00Z")).toBe("09:00"); // GMT
    expect(formatTime("2026-06-12T23:05:00Z")).toBe("00:05"); // midnight is 00, not 24
  });

  it("formats dates in London, not UTC", () => {
    expect(formatDate("2026-06-13T08:00:00Z")).toBe("Saturday 13 June 2026");
    expect(formatDate("2026-01-17T09:00:00Z")).toBe("Saturday 17 January 2026");
    expect(formatDate("2026-06-12T23:30:00Z")).toBe("Saturday 13 June 2026");
  });

  it("formats time ranges with an en dash", () => {
    expect(formatTimeRange("2026-06-13T08:00:00Z", "2026-06-13T15:00:00Z")).toBe("09:00–16:00");
    expect(formatTimeRange("2026-01-17T09:00:00Z", "2026-01-17T16:00:00Z")).toBe("09:00–16:00");
  });
});

describe("formatPounds", () => {
  const values = [0, 1, 5, 99, 100, 1200, 1250, 1500, 99999, 100000, 123456789];

  it("formats prices", () => {
    expect(formatPounds(0)).toBe("Free");
    expect(formatPounds(1500)).toBe("£15.00");
    expect(formatPounds(1250)).toBe("£12.50");
    expect(formatPounds(5)).toBe("£0.05");
    expect(formatPounds(100000)).toBe("£1,000.00");
  });

  it.each(values)("agrees with the server implementation for %s", (pence) => {
    expect(formatPounds(pence)).toBe(serverFormatPounds(pence));
  });
});

describe("slugFromPathname", () => {
  it("extracts the slug", () => {
    expect(slugFromPathname("/e/abc_DEF-123456789012")).toBe("abc_DEF-123456789012");
    expect(slugFromPathname("/e/abc_DEF-123456789012/")).toBe("abc_DEF-123456789012");
  });

  it.each(["/", "/e", "/e/", "/x/abc", "/e/a/b", "/e/has space", "/e/%3Cscript%3E"])("rejects %s", (p) => {
    expect(slugFromPathname(p)).toBeNull();
  });
});

describe("mapsUrl", () => {
  it("encodes the postcode", () => {
    expect(mapsUrl("SW1A 1AA")).toBe("https://www.google.com/maps/search/?api=1&query=SW1A%201AA");
    expect(mapsUrl("A&B=1")).toBe("https://www.google.com/maps/search/?api=1&query=A%26B%3D1");
  });
});

describe("slotsLeftText", () => {
  it("handles none, one and many", () => {
    expect(slotsLeftText(0)).toBe("Fully booked");
    expect(slotsLeftText(1)).toBe("1 slot left");
    expect(slotsLeftText(12)).toBe("12 slots left");
  });
});

describe("placesLeftText", () => {
  it("handles none, one and many, with places not slots", () => {
    expect(placesLeftText(0)).toBe("Fully booked");
    expect(placesLeftText(1)).toBe("1 place left");
    expect(placesLeftText(6)).toBe("6 places left");
  });
});

describe("copyText", () => {
  const event = {
    name: "Trial Day", costPence: 1500, venuePostcode: "SW1A 1AA", details: "Bring water.\nBe kind.",
  };
  const booking = {
    slot: { start: "2026-06-13T08:20:00Z", end: "2026-06-13T08:35:00Z" },
    fields: [{ label: "Dog", value: "Biscuit" }, { label: "Handler", value: "Ann Lee" }],
  };

  it("builds the plain-text summary", () => {
    expect(copyText(event, booking)).toBe(
      "Trial Day\nSaturday 13 June 2026, 09:20–09:35\nDog: Biscuit\nHandler: Ann Lee\nVenue: SW1A 1AA\nCost: £15.00\nBring water.\nBe kind.",
    );
  });

  it("puts the lane after the values, before the venue, when the lane has a name (as the confirmation shows it)", () => {
    expect(copyText(event, { ...booking, lane: { id: 7, name: "Ring 1" } })).toBe(
      "Trial Day\nSaturday 13 June 2026, 09:20–09:35\nDog: Biscuit\nHandler: Ann Lee\nLane: Ring 1\nVenue: SW1A 1AA\nCost: £15.00\nBring water.\nBe kind.",
    );
  });

  it("is unchanged for an unnamed lane", () => {
    expect(copyText(event, { ...booking, lane: { id: 7, name: "" } })).toBe(copyText(event, booking));
  });

  it("has a `Label: value` line for each value the booking has, in the form's order, whatever the labels", () => {
    const fields = [{ label: "Rider", value: "Ann Lee" }, { label: "Pony", value: "Biscuit" }, { label: "Phone", value: "07700 900123" }];
    expect(copyText(event, { ...booking, fields })).toBe(
      "Trial Day\nSaturday 13 June 2026, 09:20–09:35\nRider: Ann Lee\nPony: Biscuit\nPhone: 07700 900123\nVenue: SW1A 1AA\nCost: £15.00\nBring water.\nBe kind.",
    );
    expect(copyText(event, { ...booking, fields: [{ label: "Car reg", value: "AB12 CDE" }] })).toContain("\nCar reg: AB12 CDE\nVenue:");
  });

  it("omits empty details", () => {
    expect(copyText({ ...event, details: "", costPence: 0 }, booking)).toBe(
      "Trial Day\nSaturday 13 June 2026, 09:20–09:35\nDog: Biscuit\nHandler: Ann Lee\nVenue: SW1A 1AA\nCost: Free",
    );
  });
});

describe("newIdempotencyKey", () => {
  it("is 22 base64url characters, which the server's key pattern accepts", () => {
    for (let i = 0; i < 50; i++) expect(newIdempotencyKey()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newIdempotencyKey()).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("does not repeat", () => {
    expect(new Set(Array.from({ length: 1000 }, newIdempotencyKey)).size).toBe(1000);
  });
});

describe("privacyParagraphs", () => {
  it("splits on blank lines and drops empty paragraphs", () => {
    expect(privacyParagraphs("One.\n\nTwo.\r\n \r\nThree.\n\n\n")).toEqual(["One.", "Two.", "Three."]);
  });

  it("keeps single line breaks inside a paragraph", () => {
    expect(privacyParagraphs("Line one\nline two")).toEqual(["Line one\nline two"]);
  });
});

describe("penceFromPounds", () => {
  it.each([
    ["12", 1200], ["12.5", 1250], ["12.50", 1250], ["12.05", 1205], ["0", 0], ["0.00", 0], ["0.5", 50], ["00012", 1200],
    ["£12", 1200], ["£ 12.50", 1250], ["  7  ", 700], ["1000", 100000], ["19.99", 1999],
  ])("converts %j to %j pence", (text, pence) => {
    expect(penceFromPounds(text)).toEqual({ pence });
  });

  it.each([
    "", "   ", "£", "abc", "-1", "+1", "1e3", "12.505", "12.", ".5", "1,000", "12 50", "£-1", "12p", "1.2.3", "0x10", "٣",
    "1000.01", "99999999999999999999",
  ])("rejects %j with a message", (text) => {
    const r = penceFromPounds(text);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/^[A-Z].*\.$/);
  });

  it("gives specific messages", () => {
    expect(penceFromPounds("")).toEqual({ error: "Enter the cost in pounds, or 0 if it's free." });
    expect(penceFromPounds("12.505")).toEqual({ error: "Use two decimal places at most, for example 12.50." });
    expect(penceFromPounds("1000.01")).toEqual({ error: "The cost can be at most £1,000." });
  });
});

describe("isBookingPath", () => {
  it("accepts only /e/<slug>", () => {
    expect(isBookingPath("/e/abc_DEF-123")).toBe(true);
    for (const p of ["/e/", "/e/a/b", "/e/abc/", "//evil.example/e/abc", "https://x/e/abc", "/x/abc", "", null, undefined, 5]) {
      expect(isBookingPath(p)).toBe(false);
    }
  });
});

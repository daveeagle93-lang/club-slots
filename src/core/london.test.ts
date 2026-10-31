import { describe, expect, it } from "vitest";
import { LondonTimeError, londonToUtc, utcToLondon } from "./london";

// vitest pins TZ to Pacific/Auckland, so none of these can pass by using the host's time zone.
describe("londonToUtc", () => {
  it("is correct in GMT and BST", () => {
    expect(londonToUtc("2026-06-13", "09:00")).toBe("2026-06-13T08:00:00Z");
    expect(londonToUtc("2026-12-12", "09:00")).toBe("2026-12-12T09:00:00Z");
    expect(londonToUtc("2026-06-13", "00:00")).toBe("2026-06-12T23:00:00Z");
    expect(londonToUtc("2026-06-13", "23:59")).toBe("2026-06-13T22:59:00Z");
  });

  it("around the spring-forward gap (2026-03-29, 01:00-01:59 does not exist)", () => {
    expect(londonToUtc("2026-03-29", "00:59")).toBe("2026-03-29T00:59:00Z");
    expect(londonToUtc("2026-03-29", "02:00")).toBe("2026-03-29T01:00:00Z");
    expect(londonToUtc("2026-03-29", "02:30")).toBe("2026-03-29T01:30:00Z");
    for (const time of ["01:00", "01:30", "01:59"]) {
      expect(() => londonToUtc("2026-03-29", time), time).toThrow(RangeError);
      expect(() => londonToUtc("2026-03-29", time), time).toThrow(/does not exist/);
    }
  });

  it("around the autumn overlap (2026-10-25, 01:00-01:59 happens twice)", () => {
    expect(londonToUtc("2026-10-25", "00:59")).toBe("2026-10-24T23:59:00Z");
    expect(londonToUtc("2026-10-25", "02:00")).toBe("2026-10-25T02:00:00Z");
    for (const time of ["01:00", "01:30", "01:59"]) {
      expect(() => londonToUtc("2026-10-25", time), time).toThrow(RangeError);
      expect(() => londonToUtc("2026-10-25", time), time).toThrow(/happens twice/);
    }
  });

  it("reports the problem as a kind the validator can map to a field error", () => {
    const kind = (date: string, time: string): unknown => {
      try { londonToUtc(date, time); } catch (e) { return e instanceof LondonTimeError ? e.kind : "other"; }
      return "none";
    };
    expect(kind("2026-03-29", "01:30")).toBe("nonexistent");
    expect(kind("2026-10-25", "01:30")).toBe("ambiguous");
    expect(kind("2026-02-30", "09:00")).toBe("invalid");
    expect(kind("2026-06-13", "24:00")).toBe("invalid");
    expect(kind("2026-06-13", "09:00")).toBe("none");
  });

  it("rejects impossible dates and times, and any other format", () => {
    for (const date of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-6-13", "26-06-13", "2026/06/13", " 2026-06-13", "2026-06-13T00:00", ""]) {
      expect(() => londonToUtc(date, "09:00"), date).toThrow(RangeError);
    }
    expect(londonToUtc("2028-02-29", "09:00")).toBe("2028-02-29T09:00:00Z");
    expect(() => londonToUtc("2027-02-29", "09:00")).toThrow(RangeError);
    for (const time of ["24:00", "09:60", "9:00", "09:0", "0900", "09:00:00", "09:00 ", "-1:00", ""]) {
      expect(() => londonToUtc("2026-06-13", time), time).toThrow(RangeError);
    }
  });

  it("round-trips every 15 minutes of ordinary and transition dates; only the transition hour throws", () => {
    for (const date of ["2026-01-15", "2026-06-13", "2026-03-28", "2026-03-29", "2026-03-30", "2026-10-24", "2026-10-25", "2026-10-26"]) {
      const transition = date === "2026-03-29" || date === "2026-10-25";
      for (let m = 0; m < 24 * 60; m += 15) {
        const time = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        const inTransitionHour = time >= "01:00" && time < "02:00";
        if (transition && inTransitionHour) {
          expect(() => londonToUtc(date, time), `${date} ${time}`).toThrow(RangeError);
        } else {
          expect(utcToLondon(londonToUtc(date, time)), `${date} ${time}`).toEqual({ date, time });
        }
      }
    }
  });
});

describe("utcToLondon", () => {
  it("converts to London date and time", () => {
    expect(utcToLondon("2026-06-13T08:00:00Z")).toEqual({ date: "2026-06-13", time: "09:00" });
    expect(utcToLondon("2026-12-12T09:00:00Z")).toEqual({ date: "2026-12-12", time: "09:00" });
    expect(utcToLondon("2026-06-12T23:30:00Z")).toEqual({ date: "2026-06-13", time: "00:30" });
    expect(utcToLondon("2026-10-25T00:30:00Z")).toEqual({ date: "2026-10-25", time: "01:30" });
    expect(utcToLondon("2026-10-25T01:30:00Z")).toEqual({ date: "2026-10-25", time: "01:30" });
  });
});

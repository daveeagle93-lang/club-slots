import { describe, expect, it } from "vitest";
import { formatPounds } from "./format";

describe("formatPounds", () => {
  it("renders zero as Free", () => {
    expect(formatPounds(0)).toBe("Free");
  });

  it("always shows two decimals", () => {
    expect(formatPounds(1250)).toBe("£12.50");
    expect(formatPounds(1200)).toBe("£12.00");
    expect(formatPounds(5)).toBe("£0.05");
    expect(formatPounds(99)).toBe("£0.99");
  });

  it("separates thousands", () => {
    expect(formatPounds(100000)).toBe("£1,000.00");
    expect(formatPounds(123456789)).toBe("£1,234,567.89");
  });

  it.each([1.5, -1, -100, NaN, Infinity])("rejects %s", (pence) => {
    expect(() => formatPounds(pence)).toThrow(RangeError);
  });
});

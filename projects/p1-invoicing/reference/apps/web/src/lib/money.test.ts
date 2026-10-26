import { describe, expect, it } from "vitest";

import { bpsToInput, formatCents, parseHundredths } from "./money.ts";

describe("money", () => {
  it("parses decimals exactly", () => {
    expect(parseHundredths("19.99")).toBe(1999);
    expect(parseHundredths("0.29")).toBe(29);
    expect(parseHundredths("5")).toBe(500);
    expect(parseHundredths("0.5")).toBe(50);
    expect(parseHundredths("10.005")).toBeNull();
    expect(parseHundredths("-1")).toBeNull();
  });

  it("formats cents as dollars", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(bpsToInput(825)).toBe("8.25");
    expect(bpsToInput(1600)).toBe("16");
    expect(bpsToInput(1650)).toBe("16.5");
  });
});

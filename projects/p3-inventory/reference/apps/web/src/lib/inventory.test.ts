import { describe, expect, it } from "vitest";

import { formatDateTime, parseCents, signed } from "./inventory.ts";

describe("formatting helpers", () => {
  it("parses decimal amounts into cents", () => {
    expect(parseCents("2.5")).toBe(250);
    expect(parseCents("2.50")).toBe(250);
    expect(parseCents("12")).toBe(1200);
    expect(parseCents("0.07")).toBe(7);
    expect(parseCents("2.505")).toBeNull();
    expect(parseCents("-1")).toBeNull();
    expect(parseCents("")).toBeNull();
  });

  it("signs quantities and formats UTC timestamps", () => {
    expect(signed(5)).toBe("+5");
    expect(signed(-3)).toBe("-3");
    expect(formatDateTime("2030-01-07T08:05:00.000Z")).toBe("2030-01-07 08:05");
  });
});

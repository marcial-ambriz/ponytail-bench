import { describe, expect, it } from "vitest";

import { csvCell, parseCsv } from "./csv.js";

describe("csv", () => {
  it("parses quoted fields, CRLF, BOM and blank lines with line numbers", () => {
    const rows = parseCsv('﻿name,email\r\n"Doe, ""J""",j@x.test\r\n\r\n"multi\nline",m@x.test\n');
    expect(rows.map((r) => r.line)).toEqual([1, 2, 4]);
    expect(rows[1]?.fields).toEqual(['Doe, "J"', "j@x.test"]);
    expect(rows[2]?.fields[0]).toBe("multi\nline");
  });

  it("neutralizes formulas and quotes special characters", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});

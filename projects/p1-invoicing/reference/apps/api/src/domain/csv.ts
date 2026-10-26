export interface CsvRecord {
  /** 1-based line number of the record's first line in the file (the header is line 1). */
  line: number;
  fields: string[];
}

/**
 * RFC 4180 parser: quoted fields may hold commas, line breaks and doubled quotes; lines end in
 * LF or CRLF; a leading BOM is ignored; blank lines are skipped. Throws on an unterminated quote.
 */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let line = 1;
  let recordLine = 1;
  let quoted = false;
  let fieldStarted = false;

  const endRecord = () => {
    fields.push(field);
    const blank = fields.length === 1 && fields[0] === "" && !fieldStarted;
    if (!blank) records.push({ line: recordLine, fields });
    fields = [];
    field = "";
    fieldStarted = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      fieldStarted = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      fieldStarted = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) throw new Error("Unterminated quoted field");
  if (field !== "" || fields.length > 0 || fieldStarted) endRecord();
  return records;
}

const FORMULA_START = /^[=+\-@]/;

/** One CSV cell: formula-like text gets a leading quote; special characters force quoting. */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvRow(values: string[]): string {
  return values.map(csvCell).join(",");
}

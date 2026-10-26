import { randomUUID } from "node:crypto";

import { Hono, type Context } from "hono";
import { z } from "zod";

import { appendAudit } from "../audit.js";
import { parseCsv, type CsvRecord } from "../domain/csv.js";
import { isDate } from "../domain/dates.js";
import {
  MAX_QUANTITY,
  MAX_TAX_RATE_BPS,
  MAX_UNIT_PRICE_CENTS,
  parseHundredths,
  type LineInput,
} from "../domain/money.js";
import { unprocessable } from "../http.js";
import { insertDraft } from "../invoices.js";
import type { Services } from "../services.js";
import { canWrite, type AppEnv } from "../session.js";
import { customerFields, emailTaken, insertCustomer } from "./customers.js";

export const MAX_IMPORT_ROWS = 1000;

interface RowError {
  row: number;
  errors: string[];
}

interface Table {
  rows: Array<{ line: number; get: (column: string) => string }>;
}

/** Parses the CSV body and checks its header against the expected columns (422 on any file-level problem). */
async function readTable(c: Context, columns: readonly string[]): Promise<Table> {
  const text = await c.req.text();
  let records: CsvRecord[];
  try {
    records = parseCsv(text);
  } catch (err) {
    throw unprocessable(
      `The file is not valid CSV: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const [header, ...data] = records;
  if (!header) throw unprocessable("The file is empty");
  const names = header.fields.map((f) => f.trim());
  const missing = columns.filter((col) => !names.includes(col));
  const unknown = names.filter((n) => !columns.includes(n));
  if (missing.length) throw unprocessable(`Missing column(s): ${missing.join(", ")}`);
  if (unknown.length) throw unprocessable(`Unknown column(s): ${unknown.join(", ")}`);
  if (data.length === 0) throw unprocessable("The file has no data rows");
  if (data.length > MAX_IMPORT_ROWS)
    throw unprocessable(`At most ${MAX_IMPORT_ROWS} rows can be imported at once`);
  const index = new Map(names.map((n, i) => [n, i]));
  return {
    rows: data.map((r) => ({
      line: r.line,
      get: (col: string) => (r.fields[index.get(col)!] ?? "").trim(),
    })),
  };
}

function reject(errors: RowError[]): never {
  throw unprocessable("Nothing was imported: the file has invalid rows", {
    rows: errors.toSorted((a, b) => a.row - b.row),
  });
}

const customerRow = z.object(customerFields);

function zodMessages(result: { success: boolean; error?: z.ZodError }): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((i) => i.message);
}

export function importRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();
  app.use("*", canWrite);

  app.post("/customers", async (c) => {
    const { orgId } = c.get("membership");
    const table = await readTable(c, ["name", "email"]);
    const user = c.get("user");
    const count = db.transaction(() => {
      const errors: RowError[] = [];
      const seen = new Map<string, number[]>();
      const valid: Array<{ name: string; email: string }> = [];
      for (const row of table.rows) {
        const parsed = customerRow.safeParse({ name: row.get("name"), email: row.get("email") });
        const messages = zodMessages(parsed);
        if (parsed.success) {
          const key = parsed.data.email.toLowerCase();
          seen.set(key, [...(seen.get(key) ?? []), row.line]);
          if (emailTaken(db, orgId, parsed.data.email))
            messages.push("A customer with this email already exists");
          else valid.push(parsed.data);
        }
        if (messages.length) errors.push({ row: row.line, errors: messages });
      }
      for (const lines of seen.values()) {
        if (lines.length < 2) continue;
        for (const line of lines) {
          const existing = errors.find((e) => e.row === line);
          const message = "This email appears more than once in the file";
          if (existing) existing.errors.push(message);
          else errors.push({ row: line, errors: [message] });
        }
      }
      if (errors.length) reject(errors);
      const now = services.now();
      for (const customer of valid) insertCustomer(db, orgId, customer, now);
      appendAudit(
        db,
        {
          orgId,
          actor: user,
          action: "import.customers",
          entityType: "import",
          entityId: randomUUID(),
        },
        now,
      );
      return valid.length;
    })();
    return c.json({ imported: count }, 201);
  });

  app.post("/invoices", async (c) => {
    const { orgId } = c.get("membership");
    const columns = [
      "invoice_ref",
      "customer_email",
      "due_date",
      "description",
      "quantity",
      "unit_price",
      "tax_rate",
    ];
    const table = await readTable(c, columns);
    const user = c.get("user");
    const count = db.transaction(() => {
      const errors = new Map<number, string[]>();
      const add = (line: number, message: string) =>
        errors.set(line, [...(errors.get(line) ?? []), message]);
      const groups = new Map<
        string,
        Array<{ line: number; email: string; dueDate: string; item: LineInput }>
      >();
      const customerByEmail = db.prepare<[string, string], { id: string }>(
        "SELECT id FROM customer WHERE org_id = ? AND email = ?",
      );

      for (const row of table.rows) {
        const ref = row.get("invoice_ref");
        const email = row.get("customer_email");
        const dueDate = row.get("due_date");
        const description = row.get("description");
        if (!ref) add(row.line, "invoice_ref is required");
        if (!email) add(row.line, "customer_email is required");
        else if (!customerByEmail.get(orgId, email))
          add(row.line, `No customer with email ${email}`);
        if (!isDate(dueDate)) add(row.line, "due_date must be a YYYY-MM-DD date");
        if (!description) add(row.line, "description is required");
        else if (description.length > 200)
          add(row.line, "description must be at most 200 characters");
        const quantity = /^\d+$/.test(row.get("quantity")) ? Number(row.get("quantity")) : null;
        if (quantity === null || quantity < 1 || quantity > MAX_QUANTITY) {
          add(row.line, `quantity must be an integer from 1 to ${MAX_QUANTITY}`);
        }
        const unitPriceCents = parseHundredths(row.get("unit_price"));
        if (unitPriceCents === null || unitPriceCents > MAX_UNIT_PRICE_CENTS) {
          add(
            row.line,
            "unit_price must be a decimal amount with at most 2 decimals, up to 1000000.00",
          );
        }
        const taxRateBps = parseHundredths(row.get("tax_rate"));
        if (taxRateBps === null || taxRateBps > MAX_TAX_RATE_BPS) {
          add(row.line, "tax_rate must be a percentage from 0 to 100 with at most 2 decimals");
        }
        if (ref) {
          groups.set(ref, [
            ...(groups.get(ref) ?? []),
            {
              line: row.line,
              email: email.toLowerCase(),
              dueDate,
              item: {
                description,
                quantity: quantity ?? 0,
                unitPriceCents: unitPriceCents ?? 0,
                taxRateBps: taxRateBps ?? 0,
              },
            },
          ]);
        }
      }
      for (const [ref, rows] of groups) {
        const first = rows[0];
        if (rows.some((r) => r.email !== first.email || r.dueDate !== first.dueDate)) {
          for (const r of rows)
            add(
              r.line,
              `All rows of invoice ${ref} must have the same customer_email and due_date`,
            );
        }
        if (rows.length > 100)
          for (const r of rows) add(r.line, `Invoice ${ref} has more than 100 lines`);
      }
      if (errors.size) reject([...errors].map(([row, list]) => ({ row, errors: list })));

      const now = services.now();
      for (const rows of groups.values()) {
        const first = rows[0];
        const customer = customerByEmail.get(orgId, first.email)!;
        insertDraft(
          db,
          orgId,
          { customerId: customer.id, dueDate: first.dueDate, lines: rows.map((r) => r.item) },
          null,
          now,
        );
      }
      appendAudit(
        db,
        {
          orgId,
          actor: user,
          action: "import.invoices",
          entityType: "import",
          entityId: randomUUID(),
        },
        now,
      );
      return groups.size;
    })();
    return c.json({ imported: count }, 201);
  });

  return app;
}

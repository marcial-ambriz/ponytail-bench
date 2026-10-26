import { randomUUID } from "node:crypto";

import { z } from "zod";

import { appendAudit, type Actor } from "./audit.js";
import type { DB } from "./db.js";
import { isDate } from "./domain/dates.js";
import {
  invoiceAmounts,
  lineAmounts,
  MAX_QUANTITY,
  MAX_TAX_RATE_BPS,
  MAX_UNIT_PRICE_CENTS,
  type LineInput,
} from "./domain/money.js";
import { notFound, unprocessable } from "./http.js";

export type InvoiceStatus = "draft" | "issued" | "paid" | "void";

const intIn = (label: string, min: number, max: number) =>
  z
    .number({ error: `${label} must be an integer` })
    .int(`${label} must be an integer`)
    .min(min, `${label} must be between ${min} and ${max}`)
    .max(max, `${label} must be between ${min} and ${max}`);

export const lineSchema = z.object({
  description: z
    .string({ error: "Description is required" })
    .trim()
    .min(1, "Description is required")
    .max(200, "Description must be at most 200 characters"),
  quantity: intIn("Quantity", 1, MAX_QUANTITY),
  unitPriceCents: intIn("Unit price", 0, MAX_UNIT_PRICE_CENTS),
  taxRateBps: intIn("Tax rate", 0, MAX_TAX_RATE_BPS),
});

export const dateSchema = (label: string) =>
  z
    .string({ error: `${label} must be a YYYY-MM-DD date` })
    .refine(isDate, `${label} must be a YYYY-MM-DD date`);

export const invoiceFields = {
  customerId: z.string({ error: "Customer is required" }).min(1, "Customer is required"),
  dueDate: dateSchema("Due date"),
  notes: z.string().max(1000, "Notes must be at most 1000 characters").nullable().optional(),
  lines: z
    .array(lineSchema, { error: "Lines are required" })
    .min(1, "An invoice needs at least one line")
    .max(100, "An invoice can have at most 100 lines"),
};

export const createInvoiceSchema = z.object(invoiceFields);
export const updateInvoiceSchema = z.object({
  customerId: invoiceFields.customerId.optional(),
  dueDate: invoiceFields.dueDate.optional(),
  notes: invoiceFields.notes,
  lines: invoiceFields.lines.optional(),
});

interface InvoiceRow {
  id: string;
  orgId: string;
  number: number | null;
  status: InvoiceStatus;
  customerId: string;
  customerName: string;
  issueDate: string | null;
  dueDate: string;
  notes: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateBps: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export interface Invoice extends Omit<InvoiceRow, "number" | "orgId"> {
  number: string | null;
  balanceCents: number;
  lines?: InvoiceLine[];
}

export const formatNumber = (n: number | null) =>
  n === null ? null : `INV-${String(n).padStart(4, "0")}`;

const INVOICE_SELECT = `
  SELECT i.id, i.org_id AS orgId, i.number, i.status, i.customer_id AS customerId, c.name AS customerName,
         i.issue_date AS issueDate, i.due_date AS dueDate, i.notes,
         i.subtotal_cents AS subtotalCents, i.tax_cents AS taxCents, i.total_cents AS totalCents,
         COALESCE((SELECT SUM(p.amount_cents) FROM payment p WHERE p.invoice_id = i.id AND p.refunded = 0), 0)
           AS paidCents
    FROM invoice i JOIN customer c ON c.id = i.customer_id`;

function toInvoice(row: InvoiceRow, lines?: InvoiceLine[]): Invoice {
  const { orgId: _orgId, ...rest } = row;
  return {
    ...rest,
    number: formatNumber(row.number),
    balanceCents: row.totalCents - row.paidCents,
    ...(lines ? { lines } : {}),
  };
}

export function findInvoiceRow(db: DB, orgId: string, id: string): InvoiceRow | undefined {
  return db
    .prepare<[string, string], InvoiceRow>(`${INVOICE_SELECT} WHERE i.org_id = ? AND i.id = ?`)
    .get(orgId, id);
}

export function getInvoice(db: DB, orgId: string, id: string): Invoice {
  const row = findInvoiceRow(db, orgId, id);
  if (!row) throw notFound("Invoice not found");
  const lines = db
    .prepare<[string], InvoiceLine>(
      `SELECT description, quantity, unit_price_cents AS unitPriceCents, tax_rate_bps AS taxRateBps,
              subtotal_cents AS subtotalCents, tax_cents AS taxCents, total_cents AS totalCents
         FROM invoice_line WHERE invoice_id = ? ORDER BY position`,
    )
    .all(id);
  return toInvoice(row, lines);
}

export function listInvoices(
  db: DB,
  orgId: string,
  filters: { status?: string; customerId?: string } = {},
): Invoice[] {
  const where = ["i.org_id = ?"];
  const params: string[] = [orgId];
  if (filters.status) {
    where.push("i.status = ?");
    params.push(filters.status);
  }
  if (filters.customerId) {
    where.push("i.customer_id = ?");
    params.push(filters.customerId);
  }
  return db
    .prepare<string[], InvoiceRow>(
      `${INVOICE_SELECT} WHERE ${where.join(" AND ")} ORDER BY i.rowid DESC`,
    )
    .all(...params)
    .map((row) => toInvoice(row));
}

export function assertCustomerInOrg(db: DB, orgId: string, customerId: string): void {
  const found = db
    .prepare<[string, string], { id: string }>(
      "SELECT id FROM customer WHERE org_id = ? AND id = ?",
    )
    .get(orgId, customerId);
  if (!found) throw unprocessable("Customer not found in this organization");
}

/** Replaces an invoice's lines and stored totals (call inside a transaction). */
export function writeLines(db: DB, invoiceId: string, lines: LineInput[]): void {
  db.prepare("DELETE FROM invoice_line WHERE invoice_id = ?").run(invoiceId);
  const insert = db.prepare(
    `INSERT INTO invoice_line (invoice_id, position, description, quantity, unit_price_cents, tax_rate_bps,
                               subtotal_cents, tax_cents, total_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const amounts = lines.map((line, i) => {
    const a = lineAmounts(line);
    insert.run(
      invoiceId,
      i + 1,
      line.description,
      line.quantity,
      line.unitPriceCents,
      line.taxRateBps,
      a.subtotalCents,
      a.taxCents,
      a.totalCents,
    );
    return a;
  });
  const totals = invoiceAmounts(amounts);
  db.prepare(
    "UPDATE invoice SET subtotal_cents = ?, tax_cents = ?, total_cents = ? WHERE id = ?",
  ).run(totals.subtotalCents, totals.taxCents, totals.totalCents, invoiceId);
}

export interface NewInvoice {
  customerId: string;
  dueDate: string;
  notes?: string | null;
  lines: LineInput[];
}

/**
 * Creates a draft invoice (call inside a transaction). With an actor it also appends the
 * `invoice.created` audit entry; imports pass null and log one entry for the whole file.
 */
export function insertDraft(
  db: DB,
  orgId: string,
  input: NewInvoice,
  actor: Actor | null,
  now: Date,
): string {
  assertCustomerInOrg(db, orgId, input.customerId);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO invoice (id, org_id, customer_id, status, due_date, notes, subtotal_cents, tax_cents,
                          total_cents, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?, 0, 0, 0, ?)`,
  ).run(id, orgId, input.customerId, input.dueDate, input.notes ?? null, now.toISOString());
  writeLines(db, id, input.lines);
  if (actor)
    appendAudit(
      db,
      { orgId, actor, action: "invoice.created", entityType: "invoice", entityId: id },
      now,
    );
  return id;
}

/** Status after a change in paid amount: issued <-> paid. */
export function syncPaidStatus(db: DB, orgId: string, invoiceId: string): void {
  const row = findInvoiceRow(db, orgId, invoiceId);
  if (!row || (row.status !== "issued" && row.status !== "paid")) return;
  const status = row.totalCents - row.paidCents === 0 ? "paid" : "issued";
  if (status !== row.status)
    db.prepare("UPDATE invoice SET status = ? WHERE id = ?").run(status, invoiceId);
}

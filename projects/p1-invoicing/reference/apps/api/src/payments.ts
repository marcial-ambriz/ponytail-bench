import { randomUUID } from "node:crypto";

import { appendAudit, type Actor } from "./audit.js";
import type { DB } from "./db.js";
import { unprocessable } from "./http.js";
import { findInvoiceRow, syncPaidStatus } from "./invoices.js";

export const PAYMENT_METHODS = ["bank_transfer", "cash", "card", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface PaymentInput {
  orgId: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  paidAt: string;
  reference: string | null;
  source: "manual" | "payflow";
  providerPaymentId: string | null;
  /** A refund for this provider payment arrived before its success event. */
  alreadyRefunded?: boolean;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  paidAt: string;
  reference: string | null;
  source: "manual" | "payflow";
  providerPaymentId: string | null;
  refunded: boolean;
}

export const PAYMENT_SELECT = `
  SELECT id, invoice_id AS invoiceId, amount_cents AS amountCents, method, paid_at AS paidAt, reference,
         source, provider_payment_id AS providerPaymentId, refunded
    FROM payment`;

export const toPayment = (row: Omit<Payment, "refunded"> & { refunded: number }): Payment => ({
  ...row,
  refunded: row.refunded === 1,
});

/**
 * Records a payment after checking the invoice rules (issued, positive balance, amount within balance).
 * Must run inside a transaction so the balance check and the insert see the same state.
 */
export function recordPayment(db: DB, input: PaymentInput, actor: Actor | null, now: Date): string {
  const invoice = findInvoiceRow(db, input.orgId, input.invoiceId);
  if (!invoice) throw unprocessable("Invoice not found in this organization");
  const balance = invoice.totalCents - invoice.paidCents;
  if (!input.alreadyRefunded) {
    if (invoice.status !== "issued" || balance <= 0) {
      throw unprocessable("Payments can only be recorded on issued invoices with a balance due");
    }
    if (input.amountCents > balance) throw unprocessable("Amount exceeds the invoice balance");
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO payment (id, org_id, invoice_id, amount_cents, method, paid_at, reference, source,
                          provider_payment_id, refunded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.orgId,
    input.invoiceId,
    input.amountCents,
    input.method,
    input.paidAt,
    input.reference,
    input.source,
    input.providerPaymentId,
    input.alreadyRefunded ? 1 : 0,
    now.toISOString(),
  );
  syncPaidStatus(db, input.orgId, input.invoiceId);
  appendAudit(
    db,
    { orgId: input.orgId, actor, action: "payment.recorded", entityType: "payment", entityId: id },
    now,
  );
  return id;
}

/** Marks a provider payment refunded; returns false when it is unknown or already refunded. */
export function refundProviderPayment(
  db: DB,
  orgId: string,
  providerPaymentId: string,
  now: Date,
): boolean {
  const row = db
    .prepare<[string, string], { id: string; invoiceId: string; refunded: number }>(
      "SELECT id, invoice_id AS invoiceId, refunded FROM payment WHERE org_id = ? AND provider_payment_id = ?",
    )
    .get(orgId, providerPaymentId);
  if (!row || row.refunded === 1) return false;
  db.prepare("UPDATE payment SET refunded = 1 WHERE id = ?").run(row.id);
  syncPaidStatus(db, orgId, row.invoiceId);
  appendAudit(
    db,
    { orgId, actor: null, action: "payment.refunded", entityType: "payment", entityId: row.id },
    now,
  );
  return true;
}

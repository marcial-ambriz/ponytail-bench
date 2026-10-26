import { Hono } from "hono";
import { z } from "zod";

import { appendAudit } from "../audit.js";
import { formatDate } from "../domain/dates.js";
import { notFound, parse, readJson, unprocessable } from "../http.js";
import {
  assertCustomerInOrg,
  createInvoiceSchema,
  findInvoiceRow,
  getInvoice,
  insertDraft,
  listInvoices,
  updateInvoiceSchema,
  writeLines,
} from "../invoices.js";
import { dateSchema } from "../invoices.js";
import {
  PAYMENT_METHODS,
  PAYMENT_SELECT,
  recordPayment,
  toPayment,
  type Payment,
} from "../payments.js";
import type { Services } from "../services.js";
import { canWrite, type AppEnv } from "../session.js";

const listQuery = z.object({
  status: z.enum(["draft", "issued", "paid", "void"], { error: "Unknown status" }).optional(),
  customerId: z.string().optional(),
});

const paymentSchema = z.object({
  amountCents: z
    .number({ error: "Amount must be an integer number of cents" })
    .int("Amount must be an integer number of cents")
    .min(1, "Amount must be at least 1 cent"),
  method: z.enum(PAYMENT_METHODS, { error: "Method must be bank_transfer, cash, card or other" }),
  paidAt: dateSchema("Date").optional(),
  reference: z.string().max(100, "Reference must be at most 100 characters").nullable().optional(),
});

export function invoiceRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();

  const requireDraft = (orgId: string, id: string) => {
    const row = findInvoiceRow(db, orgId, id);
    if (!row) throw notFound("Invoice not found");
    if (row.status !== "draft") throw unprocessable("Only draft invoices can be changed");
    return row;
  };

  app.get("/", (c) => {
    const query = parse(listQuery, c.req.query());
    return c.json(listInvoices(db, c.get("membership").orgId, query));
  });

  app.get("/:id", (c) => c.json(getInvoice(db, c.get("membership").orgId, c.req.param("id"))));

  app.post("/", canWrite, async (c) => {
    const { orgId } = c.get("membership");
    const input = await readJson(c, createInvoiceSchema);
    const id = db.transaction(() => insertDraft(db, orgId, input, c.get("user"), services.now()))();
    return c.json(getInvoice(db, orgId, id), 201);
  });

  app.patch("/:id", canWrite, async (c) => {
    const { orgId } = c.get("membership");
    const id = c.req.param("id");
    if (!findInvoiceRow(db, orgId, id)) throw notFound("Invoice not found");
    const input = await readJson(c, updateInvoiceSchema);
    db.transaction(() => {
      requireDraft(orgId, id);
      if (input.customerId !== undefined) {
        assertCustomerInOrg(db, orgId, input.customerId);
        db.prepare("UPDATE invoice SET customer_id = ? WHERE id = ?").run(input.customerId, id);
      }
      if (input.dueDate !== undefined)
        db.prepare("UPDATE invoice SET due_date = ? WHERE id = ?").run(input.dueDate, id);
      if (input.notes !== undefined)
        db.prepare("UPDATE invoice SET notes = ? WHERE id = ?").run(input.notes, id);
      if (input.lines !== undefined) writeLines(db, id, input.lines);
      appendAudit(
        db,
        {
          orgId,
          actor: c.get("user"),
          action: "invoice.updated",
          entityType: "invoice",
          entityId: id,
        },
        services.now(),
      );
    })();
    return c.json(getInvoice(db, orgId, id));
  });

  app.delete("/:id", canWrite, (c) => {
    const { orgId } = c.get("membership");
    const id = c.req.param("id");
    db.transaction(() => {
      requireDraft(orgId, id);
      db.prepare("DELETE FROM invoice WHERE id = ?").run(id);
      appendAudit(
        db,
        {
          orgId,
          actor: c.get("user"),
          action: "invoice.deleted",
          entityType: "invoice",
          entityId: id,
        },
        services.now(),
      );
    })();
    return c.json({ ok: true });
  });

  app.post("/:id/issue", canWrite, (c) => {
    const { orgId } = c.get("membership");
    const id = c.req.param("id");
    db.transaction(() => {
      const row = findInvoiceRow(db, orgId, id);
      if (!row) throw notFound("Invoice not found");
      if (row.status !== "draft") throw unprocessable("Only draft invoices can be issued");
      if (row.totalCents <= 0) throw unprocessable("An invoice with a total of 0 cannot be issued");
      const { seq } = db
        .prepare<[string], { seq: number }>(
          "UPDATE organization SET invoice_seq = invoice_seq + 1 WHERE id = ? RETURNING invoice_seq AS seq",
        )
        .get(orgId)!;
      db.prepare(
        "UPDATE invoice SET status = 'issued', number = ?, issue_date = ? WHERE id = ?",
      ).run(seq, formatDate(services.now()), id);
      appendAudit(
        db,
        {
          orgId,
          actor: c.get("user"),
          action: "invoice.issued",
          entityType: "invoice",
          entityId: id,
        },
        services.now(),
      );
    })();
    return c.json(getInvoice(db, orgId, id));
  });

  app.post("/:id/void", canWrite, (c) => {
    const { orgId } = c.get("membership");
    const id = c.req.param("id");
    db.transaction(() => {
      const row = findInvoiceRow(db, orgId, id);
      if (!row) throw notFound("Invoice not found");
      if (row.status !== "issued") throw unprocessable("Only issued invoices can be voided");
      if (row.paidCents > 0) throw unprocessable("An invoice with payments cannot be voided");
      db.prepare("UPDATE invoice SET status = 'void' WHERE id = ?").run(id);
      appendAudit(
        db,
        {
          orgId,
          actor: c.get("user"),
          action: "invoice.voided",
          entityType: "invoice",
          entityId: id,
        },
        services.now(),
      );
    })();
    return c.json(getInvoice(db, orgId, id));
  });

  app.get("/:id/payments", (c) => {
    const { orgId } = c.get("membership");
    const id = c.req.param("id");
    if (!findInvoiceRow(db, orgId, id)) throw notFound("Invoice not found");
    const rows = db
      .prepare<[string, string], Omit<Payment, "refunded"> & { refunded: number }>(
        `${PAYMENT_SELECT} WHERE org_id = ? AND invoice_id = ? ORDER BY rowid`,
      )
      .all(orgId, id);
    return c.json(rows.map(toPayment));
  });

  app.post("/:id/payments", canWrite, async (c) => {
    const { orgId } = c.get("membership");
    const id = c.req.param("id");
    if (!findInvoiceRow(db, orgId, id)) throw notFound("Invoice not found");
    const input = await readJson(c, paymentSchema);
    const now = services.now();
    const paymentId = db.transaction(() =>
      recordPayment(
        db,
        {
          orgId,
          invoiceId: id,
          amountCents: input.amountCents,
          method: input.method,
          paidAt: input.paidAt ?? formatDate(now),
          reference: input.reference ?? null,
          source: "manual",
          providerPaymentId: null,
        },
        c.get("user"),
        now,
      ),
    )();
    const row = db
      .prepare<[string], Omit<Payment, "refunded"> & { refunded: number }>(
        `${PAYMENT_SELECT} WHERE id = ?`,
      )
      .get(paymentId)!;
    return c.json(toPayment(row), 201);
  });

  return app;
}

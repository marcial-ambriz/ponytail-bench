import { Hono } from "hono";
import { z } from "zod";

import { csvRow } from "../domain/csv.js";
import { daysBetween, formatDate, isDate } from "../domain/dates.js";
import { centsToDecimal } from "../domain/money.js";
import { parse } from "../http.js";
import { formatNumber } from "../invoices.js";
import type { Services } from "../services.js";
import type { AppEnv } from "../session.js";

const optionalDate = (label: string) =>
  z.string().refine(isDate, `${label} must be a YYYY-MM-DD date`).optional();

const AGING_BUCKETS = [
  "currentCents",
  "days1to30Cents",
  "days31to60Cents",
  "days61to90Cents",
  "over90Cents",
] as const;

export function bucketFor(daysPastDue: number): (typeof AGING_BUCKETS)[number] {
  if (daysPastDue <= 0) return "currentCents";
  if (daysPastDue <= 30) return "days1to30Cents";
  if (daysPastDue <= 60) return "days31to60Cents";
  if (daysPastDue <= 90) return "days61to90Cents";
  return "over90Cents";
}

const PAID_SUBQUERY =
  "COALESCE((SELECT SUM(p.amount_cents) FROM payment p WHERE p.invoice_id = i.id AND p.refunded = 0), 0)";

export function reportRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();

  app.get("/dashboard", (c) => {
    const { orgId } = c.get("membership");
    const { asOf: requested } = parse(z.object({ asOf: optionalDate("asOf") }), c.req.query());
    const asOf = requested ?? formatDate(services.now());
    const open = db
      .prepare<[string], { dueDate: string; balance: number }>(
        `SELECT i.due_date AS dueDate, i.total_cents - ${PAID_SUBQUERY} AS balance
           FROM invoice i WHERE i.org_id = ? AND i.status = 'issued'`,
      )
      .all(orgId)
      .filter((r) => r.balance > 0);
    const aging: Record<(typeof AGING_BUCKETS)[number], number> = {
      currentCents: 0,
      days1to30Cents: 0,
      days31to60Cents: 0,
      days61to90Cents: 0,
      over90Cents: 0,
    };
    for (const r of open) aging[bucketFor(daysBetween(r.dueDate, asOf))] += r.balance;
    const receivableCents = open.reduce((sum, r) => sum + r.balance, 0);
    const month = asOf.slice(0, 7);
    const collected = db
      .prepare<[string, string], { total: number }>(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payment
          WHERE org_id = ? AND refunded = 0 AND substr(paid_at, 1, 7) = ?`,
      )
      .get(orgId, month);
    return c.json({
      asOf,
      receivableCents,
      overdueCents: receivableCents - aging.currentCents,
      collectedCents: collected?.total ?? 0,
      aging,
    });
  });

  app.get("/exports/invoices.csv", (c) => {
    const { orgId } = c.get("membership");
    const { from, to } = parse(
      z.object({ from: optionalDate("from"), to: optionalDate("to") }),
      c.req.query(),
    );
    const where = ["i.org_id = ?", "i.status <> 'draft'"];
    const params = [orgId];
    if (from) {
      where.push("i.issue_date >= ?");
      params.push(from);
    }
    if (to) {
      where.push("i.issue_date <= ?");
      params.push(to);
    }
    const rows = db
      .prepare<
        string[],
        {
          number: number;
          customer: string;
          status: string;
          issueDate: string;
          dueDate: string;
          subtotal: number;
          tax: number;
          total: number;
          paid: number;
        }
      >(
        `SELECT i.number, c.name AS customer, i.status, i.issue_date AS issueDate, i.due_date AS dueDate,
                i.subtotal_cents AS subtotal, i.tax_cents AS tax, i.total_cents AS total, ${PAID_SUBQUERY} AS paid
           FROM invoice i JOIN customer c ON c.id = i.customer_id
          WHERE ${where.join(" AND ")} ORDER BY i.number`,
      )
      .all(...params);
    const lines = [
      "number,customer,status,issue_date,due_date,subtotal,tax,total,paid,balance",
      ...rows.map((r) =>
        csvRow([
          formatNumber(r.number) ?? "",
          r.customer,
          r.status,
          r.issueDate,
          r.dueDate,
          centsToDecimal(r.subtotal),
          centsToDecimal(r.tax),
          centsToDecimal(r.total),
          centsToDecimal(r.paid),
          centsToDecimal(r.total - r.paid),
        ]),
      ),
    ];
    return c.body(`${lines.join("\r\n")}\r\n`, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="invoices.csv"',
    });
  });

  return app;
}

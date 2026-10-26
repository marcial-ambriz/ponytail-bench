import { Hono, type Context } from "hono";

import { findWarehouse } from "../domain/inventory.js";
import { money, movementReport, toCsv, valuationReport } from "../domain/reports.js";
import { badRequest } from "../http.js";
import type { Services } from "../services.js";
import { requireAdmin, type AppEnv } from "../session.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string | undefined, label: string): string {
  if (!value || !DATE.test(value)) throw badRequest(`${label} must be a date (YYYY-MM-DD)`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw badRequest(`${label} must be a valid date`);
  }
  return value;
}

const period = (c: Context<AppEnv>) => {
  const from = validDate(c.req.query("from"), "From");
  const to = validDate(c.req.query("to"), "To");
  if (from > to) throw badRequest("From must not be after To");
  return { from, to };
};

const csv = (c: Context<AppEnv>, name: string, body: string) =>
  c.body(body, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`,
  });

export function reportRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();
  app.use("*", requireAdmin);

  const warehouseParam = (c: Context<AppEnv>) => {
    const id = c.req.query("warehouseId");
    if (!id) return undefined;
    if (!findWarehouse(db, id)) throw badRequest(`Unknown warehouse ${id}`);
    return id;
  };

  app.get("/valuation", (c) => c.json(valuationReport(db, warehouseParam(c))));

  app.get("/valuation.csv", (c) => {
    const report = valuationReport(db, warehouseParam(c));
    return csv(
      c,
      "valuation.csv",
      toCsv(
        ["SKU", "Product", "Variant", "On hand", "Average cost", "Value"],
        report.rows.map((r) => [
          r.sku,
          r.productName,
          r.variantName,
          r.onHand,
          money(r.averageCostCents),
          money(r.valueCents),
        ]),
      ),
    );
  });

  app.get("/movements", (c) => {
    const { from, to } = period(c);
    return c.json(movementReport(db, from, to, warehouseParam(c)));
  });

  app.get("/movements.csv", (c) => {
    const { from, to } = period(c);
    const report = movementReport(db, from, to, warehouseParam(c));
    return csv(
      c,
      `movements-${from}-${to}.csv`,
      toCsv(
        [
          "SKU",
          "Product",
          "Variant",
          "Opening",
          "Received",
          "Shipped",
          "Adjusted",
          "Transferred",
          "Closing",
        ],
        report.rows.map((r) => [
          r.sku,
          r.productName,
          r.variantName,
          r.opening,
          r.received,
          r.shipped,
          r.adjusted,
          r.transferred,
          r.closing,
        ]),
      ),
    );
  });

  return app;
}

import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { z } from "zod";

import type { DB } from "../db.js";
import {
  applyMovement,
  findVariant,
  firstVariant,
  release,
  reserve,
  warehouseFromBody,
} from "../domain/inventory.js";
import { idSchema, quantitySchema } from "../domain/validation.js";
import { badRequest, conflict, notFound, readJson } from "../http.js";
import type { Services } from "../services.js";
import type { AppEnv } from "../session.js";

type OrderStatus = "reserved" | "shipped" | "cancelled";

const orderSchema = z.object({
  customer: z
    .string({ error: "Customer is required" })
    .trim()
    .min(2, "Customer must be 2-80 characters")
    .max(80, "Customer must be 2-80 characters"),
  warehouseId: idSchema.optional(),
  lines: z
    .array(
      z.object({
        productId: idSchema.optional(),
        variantId: idSchema.optional(),
        quantity: quantitySchema,
      }),
      { error: "Lines are required" },
    )
    .min(1, "An order needs at least one line")
    .max(20, "An order can have at most 20 lines"),
});

interface OrderRow {
  id: string;
  customer: string;
  status: OrderStatus;
  warehouse_id: string;
  created_at: string;
  created_by_name: string;
}

interface LineRow {
  product_id: string;
  variant_id: string;
  sku: string;
  quantity: number;
}

const ORDER_SELECT = `
  SELECT o.id, o.customer, o.status, o.warehouse_id, o.created_at, u.name AS created_by_name
  FROM sales_order o JOIN user u ON u.id = o.created_by`;

function orderLines(db: DB, orderId: string): LineRow[] {
  return db
    .prepare<[string], LineRow>(
      `SELECT l.product_id, l.variant_id, v.sku, l.quantity FROM order_line l JOIN variant v ON v.id = l.variant_id
       WHERE l.order_id = ? ORDER BY l.line_no`,
    )
    .all(orderId);
}

export function loadOrder(db: DB, id: string) {
  const row = db.prepare<[string], OrderRow>(`${ORDER_SELECT} WHERE o.id = ?`).get(id);
  if (!row) throw notFound("Order not found");
  return {
    id: row.id,
    customer: row.customer,
    status: row.status,
    warehouseId: row.warehouse_id,
    lines: orderLines(db, row.id).map((l) => ({
      productId: l.product_id,
      variantId: l.variant_id,
      sku: l.sku,
      quantity: l.quantity,
    })),
    createdAt: row.created_at,
    createdBy: row.created_by_name,
  };
}

export function orderRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();

  const stateOf = (id: string) => {
    const row = db
      .prepare<[string], { status: OrderStatus; warehouse_id: string }>(
        "SELECT status, warehouse_id FROM sales_order WHERE id = ?",
      )
      .get(id);
    if (!row) throw notFound("Order not found");
    return row;
  };
  const setStatus = (id: string, status: OrderStatus) =>
    db
      .prepare("UPDATE sales_order SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, services.now().toISOString(), id);

  app.get("/", (c) => {
    const status = c.req.query("status");
    const ids = status
      ? db
          .prepare<[string], { id: string }>(
            "SELECT id FROM sales_order WHERE status = ? ORDER BY created_at DESC, rowid DESC",
          )
          .all(status)
      : db
          .prepare<[], { id: string }>(
            "SELECT id FROM sales_order ORDER BY created_at DESC, rowid DESC",
          )
          .all();
    return c.json(ids.map(({ id }) => loadOrder(db, id)));
  });

  app.get("/:id", (c) => c.json(loadOrder(db, c.req.param("id"))));

  app.post("/", async (c) => {
    const body = await readJson(c, orderSchema);
    const warehouse = warehouseFromBody(db, body.warehouseId);
    const lines = body.lines.map((line) => {
      if ((line.productId === undefined) === (line.variantId === undefined)) {
        throw badRequest("Each line needs either productId or variantId");
      }
      if (line.variantId !== undefined) {
        const variant = findVariant(db, line.variantId);
        if (!variant) throw badRequest(`Unknown variant ${line.variantId}`);
        return { variantId: variant.id, productId: variant.product_id, quantity: line.quantity };
      }
      const productId = line.productId ?? "";
      if (!db.prepare("SELECT 1 FROM product WHERE id = ?").get(productId)) {
        throw badRequest(`Unknown product ${productId}`);
      }
      return { variantId: firstVariant(db, productId).id, productId, quantity: line.quantity };
    });
    if (new Set(lines.map((l) => l.variantId)).size !== lines.length) {
      throw badRequest("Each product variant may appear only once per order");
    }
    const id = randomUUID();
    const at = services.now().toISOString();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO sales_order (id, customer, status, warehouse_id, created_by, created_at, updated_at) VALUES (?, ?, 'reserved', ?, ?, ?, ?)",
      ).run(id, body.customer, warehouse.id, c.get("user").id, at, at);
      lines.forEach((line, index) => {
        reserve(db, line.variantId, warehouse.id, line.quantity);
        db.prepare(
          "INSERT INTO order_line (order_id, line_no, product_id, variant_id, quantity) VALUES (?, ?, ?, ?, ?)",
        ).run(id, index + 1, line.productId, line.variantId, line.quantity);
      });
    }).immediate();
    return c.json(loadOrder(db, id), 201);
  });

  app.post("/:id/ship", (c) => {
    const id = c.req.param("id");
    const userId = c.get("user").id;
    db.transaction(() => {
      const { status, warehouse_id } = stateOf(id);
      if (status !== "reserved") {
        throw conflict(`Only reserved orders can be shipped (this one is ${status})`);
      }
      const at = services.now().toISOString();
      for (const line of orderLines(db, id)) {
        applyMovement(db, {
          variantId: line.variant_id,
          warehouseId: warehouse_id,
          type: "shipment",
          quantity: -line.quantity,
          unitCostCents: null,
          reason: null,
          orderId: id,
          transferId: null,
          userId,
          at,
        });
      }
      setStatus(id, "shipped");
    }).immediate();
    return c.json(loadOrder(db, id));
  });

  app.post("/:id/cancel", (c) => {
    const id = c.req.param("id");
    db.transaction(() => {
      const { status, warehouse_id } = stateOf(id);
      if (status === "cancelled") return;
      if (status !== "reserved") throw conflict("Shipped orders cannot be cancelled");
      for (const line of orderLines(db, id))
        release(db, line.variant_id, warehouse_id, line.quantity);
      setStatus(id, "cancelled");
    }).immediate();
    return c.json(loadOrder(db, id));
  });

  return app;
}

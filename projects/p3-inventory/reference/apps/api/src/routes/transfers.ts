import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { z } from "zod";

import type { DB } from "../db.js";
import { applyMovement, findVariant, findWarehouse } from "../domain/inventory.js";
import { idSchema, quantitySchema } from "../domain/validation.js";
import { badRequest, notFound, readJson } from "../http.js";
import type { Services } from "../services.js";
import type { AppEnv } from "../session.js";

const transferSchema = z.object({
  variantId: idSchema,
  fromWarehouseId: idSchema,
  toWarehouseId: idSchema,
  quantity: quantitySchema,
});

interface TransferRow {
  id: string;
  variant_id: string;
  sku: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  quantity: number;
  created_at: string;
  created_by_name: string;
}

const TRANSFER_SELECT = `
  SELECT t.id, t.variant_id, v.sku, t.from_warehouse_id, t.to_warehouse_id, t.quantity, t.created_at,
         u.name AS created_by_name
  FROM transfer t JOIN variant v ON v.id = t.variant_id JOIN user u ON u.id = t.created_by`;

const toTransfer = (r: TransferRow) => ({
  id: r.id,
  variantId: r.variant_id,
  sku: r.sku,
  fromWarehouseId: r.from_warehouse_id,
  toWarehouseId: r.to_warehouse_id,
  quantity: r.quantity,
  createdAt: r.created_at,
  createdBy: r.created_by_name,
});

function loadTransfer(db: DB, id: string) {
  const row = db.prepare<[string], TransferRow>(`${TRANSFER_SELECT} WHERE t.id = ?`).get(id);
  if (!row) throw notFound("Transfer not found");
  return toTransfer(row);
}

export function transferRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();

  app.get("/", (c) =>
    c.json(
      db
        .prepare<[], TransferRow>(`${TRANSFER_SELECT} ORDER BY t.created_at DESC, t.rowid DESC`)
        .all()
        .map(toTransfer),
    ),
  );

  app.post("/", async (c) => {
    const body = await readJson(c, transferSchema);
    if (body.fromWarehouseId === body.toWarehouseId) {
      throw badRequest("Source and destination must be different warehouses");
    }
    if (!findVariant(db, body.variantId)) throw badRequest(`Unknown variant ${body.variantId}`);
    for (const id of [body.fromWarehouseId, body.toWarehouseId]) {
      if (!findWarehouse(db, id)) throw badRequest(`Unknown warehouse ${id}`);
    }
    const id = randomUUID();
    const userId = c.get("user").id;
    const at = services.now().toISOString();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO transfer (id, variant_id, from_warehouse_id, to_warehouse_id, quantity, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        body.variantId,
        body.fromWarehouseId,
        body.toWarehouseId,
        body.quantity,
        userId,
        at,
      );
      const common = {
        variantId: body.variantId,
        unitCostCents: null,
        reason: null,
        orderId: null,
        transferId: id,
        userId,
        at,
      };
      applyMovement(db, {
        ...common,
        warehouseId: body.fromWarehouseId,
        type: "transfer_out",
        quantity: -body.quantity,
      });
      applyMovement(db, {
        ...common,
        warehouseId: body.toWarehouseId,
        type: "transfer_in",
        quantity: body.quantity,
      });
    }).immediate();
    return c.json(loadTransfer(db, id), 201);
  });

  return app;
}

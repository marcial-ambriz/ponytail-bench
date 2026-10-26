import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { z } from "zod";

import { findWarehouse, type WarehouseRow } from "../domain/inventory.js";
import { warehouseCodeSchema, warehouseNameSchema } from "../domain/validation.js";
import { badRequest, conflict, notFound, readJson } from "../http.js";
import type { Services } from "../services.js";
import { requireAdmin, type AppEnv } from "../session.js";

const createSchema = z.object({ code: warehouseCodeSchema, name: warehouseNameSchema });
const patchSchema = z.object({
  code: warehouseCodeSchema.optional(),
  name: warehouseNameSchema.optional(),
});

export function warehouseRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();

  app.get("/", (c) =>
    c.json(
      db.prepare<[], WarehouseRow>("SELECT id, code, name FROM warehouse ORDER BY code").all(),
    ),
  );

  app.post("/", requireAdmin, async (c) => {
    const body = await readJson(c, createSchema);
    const id = randomUUID();
    db.transaction(() => {
      if (db.prepare("SELECT 1 FROM warehouse WHERE code = ?").get(body.code)) {
        throw conflict(`Warehouse ${body.code} already exists`);
      }
      db.prepare("INSERT INTO warehouse (id, code, name, created_at) VALUES (?, ?, ?, ?)").run(
        id,
        body.code,
        body.name,
        services.now().toISOString(),
      );
    }).immediate();
    return c.json(findWarehouse(db, id), 201);
  });

  app.patch("/:id", requireAdmin, async (c) => {
    const warehouse = findWarehouse(db, c.req.param("id"));
    if (!warehouse) throw notFound("Warehouse not found");
    const body = await readJson(c, patchSchema);
    if (body.code !== undefined && body.code !== warehouse.code)
      throw badRequest("Code cannot be changed");
    db.prepare("UPDATE warehouse SET name = ? WHERE id = ?").run(
      body.name ?? warehouse.name,
      warehouse.id,
    );
    return c.json(findWarehouse(db, warehouse.id));
  });

  return app;
}

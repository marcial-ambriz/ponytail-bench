import { Hono } from "hono";
import { z } from "zod";

import { findVariant, variantView } from "../domain/inventory.js";
import { reorderPointSchema, skuSchema, variantNameSchema } from "../domain/validation.js";
import { badRequest, notFound, readJson } from "../http.js";
import type { Services } from "../services.js";
import { requireAdmin, type AppEnv } from "../session.js";

const patchSchema = z.object({
  sku: skuSchema.optional(),
  name: variantNameSchema.optional(),
  reorderPoint: reorderPointSchema.optional(),
});

export function variantRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();

  app.get("/:id", (c) => c.json(variantView(db, c.req.param("id"))));

  app.patch("/:id", requireAdmin, async (c) => {
    const variant = findVariant(db, c.req.param("id"));
    if (!variant) throw notFound("Variant not found");
    const body = await readJson(c, patchSchema);
    if (body.sku !== undefined && body.sku !== variant.sku)
      throw badRequest("SKU cannot be changed");
    db.prepare("UPDATE variant SET name = ?, reorder_point = ? WHERE id = ?").run(
      body.name ?? variant.name,
      body.reorderPoint ?? variant.reorder_point,
      variant.id,
    );
    return c.json(variantView(db, variant.id));
  });

  return app;
}

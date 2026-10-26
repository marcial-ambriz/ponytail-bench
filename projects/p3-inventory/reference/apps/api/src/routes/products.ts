import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { z } from "zod";

import {
  applyMovement,
  findVariant,
  firstVariant,
  insertVariant,
  listMovements,
  loadMovement,
  loadProductRow,
  productView,
  skuTaken,
  variantView,
  warehouseFromBody,
} from "../domain/inventory.js";
import {
  descriptionSchema,
  idSchema,
  productNameSchema,
  quantitySchema,
  reorderPointSchema,
  signedQuantitySchema,
  skuSchema,
  unitCostSchema,
  variantNameSchema,
} from "../domain/validation.js";
import { badRequest, conflict, forbidden, readJson } from "../http.js";
import type { Services } from "../services.js";
import { requireAdmin, type AppEnv } from "../session.js";

const createSchema = z.object({
  sku: skuSchema,
  name: productNameSchema,
  description: descriptionSchema,
  reorderPoint: reorderPointSchema.optional(),
});

const patchSchema = z.object({
  sku: skuSchema.optional(),
  name: productNameSchema.optional(),
  description: descriptionSchema,
  reorderPoint: reorderPointSchema.optional(),
});

const variantSchema = z.object({
  sku: skuSchema,
  name: variantNameSchema,
  reorderPoint: reorderPointSchema.optional(),
});

const reasonSchema = z
  .string({ error: "Reason must be text" })
  .trim()
  .max(200, "Reason must be at most 200 characters");

const target = {
  variantId: idSchema.optional(),
  warehouseId: idSchema.optional(),
};

const movementSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("receipt"),
      quantity: quantitySchema,
      unitCostCents: unitCostSchema,
      ...target,
    }),
    z.object({
      type: z.literal("issue"),
      quantity: quantitySchema,
      reason: reasonSchema.nullable().optional(),
      ...target,
    }),
    z.object({
      type: z.literal("adjustment"),
      quantity: signedQuantitySchema,
      reason: z
        .string({ error: "Reason is required for adjustments" })
        .trim()
        .min(3, "Reason must be 3-200 characters")
        .max(200, "Reason must be 3-200 characters"),
      ...target,
    }),
  ],
  { error: "Type must be receipt, issue or adjustment" },
);

const emptyToNull = (value: string | null | undefined) =>
  value === undefined || value === null || value.trim() === "" ? null : value.trim();

export function productRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const q = c.req.query("q")?.trim();
    const ids = q
      ? db
          .prepare<[string, string], { id: string }>(
            `SELECT p.id FROM product p JOIN variant v ON v.product_id = p.id AND v.position = 0
             WHERE instr(lower(p.name), lower(?)) > 0
                OR EXISTS (SELECT 1 FROM variant x WHERE x.product_id = p.id AND instr(lower(x.sku), lower(?)) > 0)
             ORDER BY v.sku`,
          )
          .all(q, q)
      : db
          .prepare<[], { id: string }>(
            "SELECT p.id FROM product p JOIN variant v ON v.product_id = p.id AND v.position = 0 ORDER BY v.sku",
          )
          .all();
    return c.json(ids.map(({ id }) => productView(db, id)));
  });

  app.get("/:id", (c) => c.json(productView(db, c.req.param("id"))));

  app.post("/", requireAdmin, async (c) => {
    const body = await readJson(c, createSchema);
    const id = randomUUID();
    const at = services.now().toISOString();
    db.transaction(() => {
      if (skuTaken(db, body.sku)) throw conflict(`SKU ${body.sku} already exists`);
      db.prepare("INSERT INTO product (id, name, description, created_at) VALUES (?, ?, ?, ?)").run(
        id,
        body.name,
        emptyToNull(body.description),
        at,
      );
      insertVariant(db, {
        productId: id,
        sku: body.sku,
        name: "Default",
        reorderPoint: body.reorderPoint ?? 0,
        at,
      });
    }).immediate();
    return c.json(productView(db, id), 201);
  });

  app.patch("/:id", requireAdmin, async (c) => {
    const product = loadProductRow(db, c.req.param("id"));
    const body = await readJson(c, patchSchema);
    const first = firstVariant(db, product.id);
    if (body.sku !== undefined && body.sku !== first.sku) throw badRequest("SKU cannot be changed");
    db.transaction(() => {
      db.prepare("UPDATE product SET name = ?, description = ? WHERE id = ?").run(
        body.name ?? product.name,
        body.description === undefined ? product.description : emptyToNull(body.description),
        product.id,
      );
      if (body.reorderPoint !== undefined) {
        db.prepare("UPDATE variant SET reorder_point = ? WHERE id = ?").run(
          body.reorderPoint,
          first.id,
        );
      }
    })();
    return c.json(productView(db, product.id));
  });

  app.delete("/:id", requireAdmin, (c) => {
    const product = loadProductRow(db, c.req.param("id"));
    db.transaction(() => {
      const used = db
        .prepare<[string, string], { n: number }>(
          "SELECT (SELECT COUNT(*) FROM movement WHERE product_id = ?) + (SELECT COUNT(*) FROM order_line WHERE product_id = ?) AS n",
        )
        .get(product.id, product.id);
      if (used && used.n > 0) {
        throw conflict("This product has stock movements or orders and cannot be deleted");
      }
      db.prepare(
        "DELETE FROM stock WHERE variant_id IN (SELECT id FROM variant WHERE product_id = ?)",
      ).run(product.id);
      db.prepare("DELETE FROM variant WHERE product_id = ?").run(product.id);
      db.prepare("DELETE FROM product WHERE id = ?").run(product.id);
    }).immediate();
    return c.json({ ok: true });
  });

  app.post("/:id/variants", requireAdmin, async (c) => {
    const product = loadProductRow(db, c.req.param("id"));
    const body = await readJson(c, variantSchema);
    const id = db
      .transaction(() => {
        if (skuTaken(db, body.sku)) throw conflict(`SKU ${body.sku} already exists`);
        return insertVariant(db, {
          productId: product.id,
          sku: body.sku,
          name: body.name,
          reorderPoint: body.reorderPoint ?? 0,
          at: services.now().toISOString(),
        });
      })
      .immediate();
    return c.json(variantView(db, id), 201);
  });

  app.get("/:id/movements", (c) => {
    const product = loadProductRow(db, c.req.param("id"));
    return c.json(
      listMovements(db, product.id, {
        variantId: c.req.query("variantId") || undefined,
        warehouseId: c.req.query("warehouseId") || undefined,
      }),
    );
  });

  app.post("/:id/movements", async (c) => {
    const product = loadProductRow(db, c.req.param("id"));
    const body = await readJson(c, movementSchema);
    const user = c.get("user");
    if (body.type === "adjustment" && user.role !== "admin") {
      throw forbidden("Only admins can record adjustments");
    }
    let variantId = firstVariant(db, product.id).id;
    if (body.variantId !== undefined) {
      const variant = findVariant(db, body.variantId);
      if (!variant || variant.product_id !== product.id) {
        throw badRequest("The variant does not belong to this product");
      }
      variantId = variant.id;
    }
    const warehouse = warehouseFromBody(db, body.warehouseId);
    const quantity = body.type === "issue" ? -body.quantity : body.quantity;
    const id = db
      .transaction(() =>
        applyMovement(db, {
          variantId,
          warehouseId: warehouse.id,
          type: body.type,
          quantity,
          unitCostCents: body.type === "receipt" ? body.unitCostCents : null,
          reason: body.type === "receipt" ? null : emptyToNull(body.reason),
          orderId: null,
          transferId: null,
          userId: user.id,
          at: services.now().toISOString(),
        }),
      )
      .immediate();
    return c.json(loadMovement(db, id), 201);
  });

  return app;
}

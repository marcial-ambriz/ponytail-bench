import { Hono } from "hono";

import type { Services } from "../services.js";
import type { AppEnv } from "../session.js";

export function alertRoutes(services: Services) {
  const { db } = services;
  return new Hono<AppEnv>().get("/low-stock", (c) => {
    const rows = db
      .prepare<
        [],
        {
          product_id: string;
          variant_id: string;
          sku: string;
          name: string;
          variant_name: string;
          available: number;
          reorder_point: number;
        }
      >(
        `SELECT v.product_id, v.id AS variant_id, v.sku, p.name, v.name AS variant_name, v.reorder_point,
                COALESCE(SUM(s.on_hand - s.reserved), 0) AS available
         FROM variant v JOIN product p ON p.id = v.product_id LEFT JOIN stock s ON s.variant_id = v.id
         WHERE v.reorder_point > 0
         GROUP BY v.id
         HAVING available <= v.reorder_point
         ORDER BY v.sku`,
      )
      .all();
    return c.json(
      rows.map((r) => ({
        productId: r.product_id,
        variantId: r.variant_id,
        sku: r.sku,
        name: r.name,
        variantName: r.variant_name,
        available: r.available,
        reorderPoint: r.reorder_point,
      })),
    );
  });
}

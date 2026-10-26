import { Hono } from "hono";
import { z } from "zod";

import { parse } from "../http.js";
import type { Services } from "../services.js";
import { canWrite, type AppEnv } from "../session.js";

const query = z.object({ entityType: z.string().optional(), entityId: z.string().optional() });

/** Read-only view of the append-only audit log: there are deliberately no write routes. */
export function auditRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();

  app.get("/", canWrite, (c) => {
    const { entityType, entityId } = parse(query, c.req.query());
    const where = ["org_id = ?"];
    const params = [c.get("membership").orgId];
    if (entityType) {
      where.push("entity_type = ?");
      params.push(entityType);
    }
    if (entityId) {
      where.push("entity_id = ?");
      params.push(entityId);
    }
    const rows = db
      .prepare(
        `SELECT id, at, actor_id AS actorId, actor_name AS actorName, action, entity_type AS entityType,
                entity_id AS entityId
           FROM audit_entry WHERE ${where.join(" AND ")} ORDER BY seq DESC`,
      )
      .all(...params);
    return c.json(rows);
  });

  return app;
}

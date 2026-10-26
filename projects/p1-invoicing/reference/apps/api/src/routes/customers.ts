import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { z } from "zod";

import { appendAudit } from "../audit.js";
import type { DB } from "../db.js";
import { conflict, notFound, readJson } from "../http.js";
import type { Services } from "../services.js";
import { canWrite, type AppEnv } from "../session.js";

export const customerFields = {
  name: z
    .string({ error: "Name is required" })
    .trim()
    .min(1, "Name is required")
    .max(120, "Name must be at most 120 characters"),
  email: z.email({ error: "A valid email is required" }),
};

const createSchema = z.object(customerFields);
const updateSchema = z.object({
  name: customerFields.name.optional(),
  email: customerFields.email.optional(),
});

export interface Customer {
  id: string;
  name: string;
  email: string;
}

export function emailTaken(db: DB, orgId: string, email: string, exceptId = ""): boolean {
  return !!db
    .prepare<[string, string, string], { id: string }>(
      "SELECT id FROM customer WHERE org_id = ? AND email = ? AND id <> ?",
    )
    .get(orgId, email, exceptId);
}

export function insertCustomer(
  db: DB,
  orgId: string,
  input: Omit<Customer, "id">,
  now: Date,
): Customer {
  const customer = { id: randomUUID(), ...input };
  db.prepare(
    "INSERT INTO customer (id, org_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(customer.id, orgId, customer.name, customer.email, now.toISOString());
  return customer;
}

export function customerRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();
  const select = db.prepare<[string, string], Customer>(
    "SELECT id, name, email FROM customer WHERE org_id = ? AND id = ?",
  );
  const find = (orgId: string, id: string) => {
    const customer = select.get(orgId, id);
    if (!customer) throw notFound("Customer not found");
    return customer;
  };

  app.get("/", (c) => {
    const rows = db
      .prepare<[string], Customer>(
        "SELECT id, name, email FROM customer WHERE org_id = ? ORDER BY name COLLATE NOCASE, email",
      )
      .all(c.get("membership").orgId);
    return c.json(rows);
  });

  app.get("/:id", (c) => c.json(find(c.get("membership").orgId, c.req.param("id"))));

  app.post("/", canWrite, async (c) => {
    const { orgId } = c.get("membership");
    const input = await readJson(c, createSchema);
    const user = c.get("user");
    const customer = db.transaction(() => {
      if (emailTaken(db, orgId, input.email))
        throw conflict("A customer with this email already exists");
      const created = insertCustomer(db, orgId, input, services.now());
      appendAudit(
        db,
        {
          orgId,
          actor: user,
          action: "customer.created",
          entityType: "customer",
          entityId: created.id,
        },
        services.now(),
      );
      return created;
    })();
    return c.json(customer, 201);
  });

  app.patch("/:id", canWrite, async (c) => {
    const { orgId } = c.get("membership");
    const id = c.req.param("id");
    find(orgId, id);
    const input = await readJson(c, updateSchema);
    const user = c.get("user");
    const customer = db.transaction(() => {
      const current = find(orgId, id);
      const next = { ...current, ...input };
      if (input.email && emailTaken(db, orgId, input.email, id)) {
        throw conflict("A customer with this email already exists");
      }
      db.prepare("UPDATE customer SET name = ?, email = ? WHERE id = ?").run(
        next.name,
        next.email,
        id,
      );
      appendAudit(
        db,
        { orgId, actor: user, action: "customer.updated", entityType: "customer", entityId: id },
        services.now(),
      );
      return next;
    })();
    return c.json(customer);
  });

  app.delete("/:id", canWrite, (c) => {
    const { orgId } = c.get("membership");
    const id = c.req.param("id");
    const user = c.get("user");
    db.transaction(() => {
      find(orgId, id);
      const invoices = db
        .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM invoice WHERE customer_id = ?")
        .get(id);
      if (invoices && invoices.n > 0)
        throw conflict("This customer has invoices and cannot be deleted");
      db.prepare("DELETE FROM customer WHERE id = ?").run(id);
      appendAudit(
        db,
        { orgId, actor: user, action: "customer.deleted", entityType: "customer", entityId: id },
        services.now(),
      );
    })();
    return c.json({ ok: true });
  });

  return app;
}

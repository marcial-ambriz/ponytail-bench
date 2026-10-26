import { randomBytes, randomUUID } from "node:crypto";

import { Hono } from "hono";
import { z } from "zod";

import { appendAudit } from "../audit.js";
import { conflict, notFound, readJson, unprocessable } from "../http.js";
import type { Services } from "../services.js";
import { ownerOnly, ROLES, type AppEnv, type Role } from "../session.js";

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString("hex")}`;

const orgSchema = z.object({
  name: z
    .string({ error: "Name is required" })
    .trim()
    .min(2, "Name must be 2-80 characters")
    .max(80, "Name must be 2-80 characters"),
});

const roleSchema = z.enum(ROLES, { error: "Role must be owner, accountant or viewer" });

const invitationSchema = z.object({
  email: z.email({ error: "A valid email is required" }),
  role: roleSchema,
});

interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: Role;
}

/** `/api/orgs` (not scoped to one organization). */
export function orgListRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();

  app.get("/", (c) => {
    const rows = db
      .prepare<[string], { id: string; name: string; role: Role }>(
        `SELECT o.id, o.name, m.role FROM membership m JOIN organization o ON o.id = m.org_id
          WHERE m.user_id = ? ORDER BY o.name COLLATE NOCASE, o.created_at`,
      )
      .all(c.get("user").id);
    return c.json(rows);
  });

  app.post("/", async (c) => {
    const { name } = await readJson(c, orgSchema);
    const id = randomUUID();
    const now = services.now().toISOString();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO organization (id, name, webhook_secret, created_at) VALUES (?, ?, ?, ?)",
      ).run(id, name, newWebhookSecret(), now);
      db.prepare(
        "INSERT INTO membership (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      ).run(id, c.get("user").id, now);
    })();
    return c.json({ id, name, role: "owner" }, 201);
  });

  return app;
}

const actorOf = (c: { get(key: "user"): { id: string; name: string } }) => {
  const u = c.get("user");
  return { id: u.id, name: u.name };
};

/** Organization detail, members and invitations; mounted under `/api/orgs/:orgId`. */
export function orgRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();

  const selectMember = db.prepare<[string, string], MemberRow>(
    `SELECT u.id AS userId, u.name, u.email, m.role FROM membership m JOIN user u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.user_id = ?`,
  );
  const countOwners = db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM membership WHERE org_id = ? AND role = 'owner'",
  );

  app.get("/", (c) => {
    const m = c.get("membership");
    return c.json({ id: m.orgId, name: m.orgName, role: m.role });
  });

  app.get("/members", (c) => {
    const rows = db
      .prepare<[string], MemberRow>(
        `SELECT u.id AS userId, u.name, u.email, m.role FROM membership m JOIN user u ON u.id = m.user_id
          WHERE m.org_id = ? ORDER BY u.name COLLATE NOCASE, u.email`,
      )
      .all(c.get("membership").orgId);
    return c.json(rows);
  });

  app.patch("/members/:userId", ownerOnly, async (c) => {
    const { orgId } = c.get("membership");
    const userId = c.req.param("userId");
    const { role } = await readJson(c, z.object({ role: roleSchema }));
    const updated = db.transaction(() => {
      const member = selectMember.get(orgId, userId);
      if (!member) throw notFound("Member not found");
      if (member.role === role) return member;
      if (member.role === "owner" && (countOwners.get(orgId)?.n ?? 0) <= 1) {
        throw unprocessable("The organization must keep at least one owner");
      }
      db.prepare("UPDATE membership SET role = ? WHERE org_id = ? AND user_id = ?").run(
        role,
        orgId,
        userId,
      );
      appendAudit(
        db,
        {
          orgId,
          actor: actorOf(c),
          action: "member.role_changed",
          entityType: "member",
          entityId: userId,
        },
        services.now(),
      );
      return selectMember.get(orgId, userId);
    })();
    return c.json(updated);
  });

  app.delete("/members/:userId", ownerOnly, (c) => {
    const { orgId } = c.get("membership");
    const userId = c.req.param("userId");
    db.transaction(() => {
      const member = selectMember.get(orgId, userId);
      if (!member) throw notFound("Member not found");
      if (member.role === "owner" && (countOwners.get(orgId)?.n ?? 0) <= 1) {
        throw unprocessable("The organization must keep at least one owner");
      }
      db.prepare("DELETE FROM membership WHERE org_id = ? AND user_id = ?").run(orgId, userId);
      appendAudit(
        db,
        {
          orgId,
          actor: actorOf(c),
          action: "member.removed",
          entityType: "member",
          entityId: userId,
        },
        services.now(),
      );
    })();
    return c.json({ ok: true });
  });

  app.get("/invitations", ownerOnly, (c) => {
    const rows = db
      .prepare<[string], { id: string; email: string; role: Role; token: string }>(
        `SELECT id, email, role, token FROM invitation WHERE org_id = ? AND status = 'pending'
          ORDER BY created_at, rowid`,
      )
      .all(c.get("membership").orgId);
    return c.json(rows);
  });

  app.post("/invitations", ownerOnly, async (c) => {
    const { orgId } = c.get("membership");
    const { email, role } = await readJson(c, invitationSchema);
    const invitation = { id: randomUUID(), email, role, token: randomBytes(24).toString("hex") };
    db.transaction(() => {
      const member = db
        .prepare<[string, string], { n: number }>(
          `SELECT COUNT(*) AS n FROM membership m JOIN user u ON u.id = m.user_id
            WHERE m.org_id = ? AND lower(u.email) = lower(?)`,
        )
        .get(orgId, email);
      if (member && member.n > 0) throw conflict("This email already belongs to a member");
      const pending = db
        .prepare<[string, string], { n: number }>(
          "SELECT COUNT(*) AS n FROM invitation WHERE org_id = ? AND email = ? AND status = 'pending'",
        )
        .get(orgId, email);
      if (pending && pending.n > 0) throw conflict("This email already has a pending invitation");
      db.prepare(
        "INSERT INTO invitation (id, org_id, email, role, token, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(invitation.id, orgId, email, role, invitation.token, services.now().toISOString());
      appendAudit(
        db,
        {
          orgId,
          actor: actorOf(c),
          action: "invitation.created",
          entityType: "invitation",
          entityId: invitation.id,
        },
        services.now(),
      );
    })();
    return c.json(invitation, 201);
  });

  return app;
}

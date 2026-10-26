import { Hono } from "hono";

import { appendAudit } from "../audit.js";
import { conflict, forbidden, notFound } from "../http.js";
import type { Services } from "../services.js";
import type { AppEnv, Role } from "../session.js";

interface InvitationRow {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  role: Role;
  status: "pending" | "accepted";
}

/** `/api/invitations/:token` for the invited user. */
export function invitationRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();
  const select = db.prepare<[string], InvitationRow>(
    `SELECT i.id, i.org_id AS orgId, o.name AS orgName, i.email, i.role, i.status
       FROM invitation i JOIN organization o ON o.id = i.org_id WHERE i.token = ?`,
  );

  app.get("/:token", (c) => {
    const inv = select.get(c.req.param("token"));
    if (!inv) throw notFound("Invitation not found");
    return c.json({ orgName: inv.orgName, email: inv.email, role: inv.role, status: inv.status });
  });

  app.post("/:token/accept", (c) => {
    const user = c.get("user");
    const result = db.transaction(() => {
      const inv = select.get(c.req.param("token"));
      if (!inv) throw notFound("Invitation not found");
      if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
        throw forbidden("This invitation was sent to a different email");
      }
      if (inv.status !== "pending") throw conflict("This invitation was already accepted");
      const existing = db
        .prepare<[string, string], { n: number }>(
          "SELECT COUNT(*) AS n FROM membership WHERE org_id = ? AND user_id = ?",
        )
        .get(inv.orgId, user.id);
      if (existing && existing.n > 0)
        throw conflict("You are already a member of this organization");
      db.prepare("UPDATE invitation SET status = 'accepted' WHERE id = ?").run(inv.id);
      db.prepare(
        "INSERT INTO membership (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
      ).run(inv.orgId, user.id, inv.role, services.now().toISOString());
      appendAudit(
        db,
        {
          orgId: inv.orgId,
          actor: { id: user.id, name: user.name },
          action: "invitation.accepted",
          entityType: "invitation",
          entityId: inv.id,
        },
        services.now(),
      );
      return { orgId: inv.orgId, role: inv.role };
    })();
    return c.json(result);
  });

  return app;
}

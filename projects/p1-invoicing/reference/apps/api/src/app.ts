import { Hono } from "hono";

import { HttpError } from "./http.js";
import { auditRoutes } from "./routes/audit.js";
import { customerRoutes } from "./routes/customers.js";
import { importRoutes } from "./routes/imports.js";
import { invitationRoutes } from "./routes/invitations.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { orgListRoutes, orgRoutes } from "./routes/orgs.js";
import { reportRoutes } from "./routes/reports.js";
import { settingsRoutes } from "./routes/settings.js";
import { webhookRoutes } from "./routes/webhooks.js";
import type { Services } from "./services.js";
import { requireMembership, requireSession, type AppEnv } from "./session.js";

export function createApp(services: Services) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, ...err.extra }, err.status);
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => services.auth.handler(c.req.raw));
  app.route("/api/webhooks", webhookRoutes(services));

  const api = new Hono<AppEnv>();
  api.use("*", requireSession(services));
  api.get("/me", (c) => c.json(c.get("user")));
  api.route("/invitations", invitationRoutes(services));
  api.route("/orgs", orgListRoutes(services));

  const org = new Hono<AppEnv>();
  org.use("*", requireMembership(services));
  org.route("/", orgRoutes(services));
  org.route("/customers", customerRoutes(services));
  org.route("/invoices", invoiceRoutes(services));
  org.route("/settings", settingsRoutes(services));
  org.route("/imports", importRoutes(services));
  org.route("/audit", auditRoutes(services));
  org.route("/", reportRoutes(services));
  api.route("/orgs/:orgId", org);

  app.route("/api", api);
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}

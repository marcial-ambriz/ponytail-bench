import { Hono } from "hono";

import { appendAudit } from "../audit.js";
import type { Services } from "../services.js";
import { ownerOnly, type AppEnv } from "../session.js";
import { newWebhookSecret } from "./orgs.js";

export function settingsRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();
  app.use("*", ownerOnly);

  const view = (orgId: string) => {
    const row = db
      .prepare<[string], { secret: string }>(
        "SELECT webhook_secret AS secret FROM organization WHERE id = ?",
      )
      .get(orgId)!;
    return { secret: row.secret, url: `/api/webhooks/payflow/${orgId}` };
  };

  app.get("/webhook", (c) => c.json(view(c.get("membership").orgId)));

  app.post("/webhook/rotate", (c) => {
    const { orgId } = c.get("membership");
    db.transaction(() => {
      db.prepare("UPDATE organization SET webhook_secret = ? WHERE id = ?").run(
        newWebhookSecret(),
        orgId,
      );
      appendAudit(
        db,
        {
          orgId,
          actor: c.get("user"),
          action: "webhook.secret_rotated",
          entityType: "organization",
          entityId: orgId,
        },
        services.now(),
      );
    })();
    return c.json(view(orgId));
  });

  return app;
}

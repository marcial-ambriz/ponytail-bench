import { Hono } from "hono";

import { HttpError } from "./http.js";
import { alertRoutes } from "./routes/alerts.js";
import { meRoutes } from "./routes/me.js";
import { orderRoutes } from "./routes/orders.js";
import { productRoutes } from "./routes/products.js";
import { reportRoutes } from "./routes/reports.js";
import { transferRoutes } from "./routes/transfers.js";
import { userRoutes } from "./routes/users.js";
import { variantRoutes } from "./routes/variants.js";
import { warehouseRoutes } from "./routes/warehouses.js";
import type { Services } from "./services.js";
import { requireSession, type AppEnv } from "./session.js";

export function createApp(services: Services) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => services.auth.handler(c.req.raw));

  const api = new Hono<AppEnv>();
  api.use("*", requireSession(services));
  api.route("/me", meRoutes());
  api.route("/users", userRoutes(services));
  api.route("/products", productRoutes(services));
  api.route("/orders", orderRoutes(services));
  api.route("/alerts", alertRoutes(services));
  api.route("/variants", variantRoutes(services));
  api.route("/warehouses", warehouseRoutes(services));
  api.route("/transfers", transferRoutes(services));
  api.route("/reports", reportRoutes(services));
  app.route("/api", api);

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}

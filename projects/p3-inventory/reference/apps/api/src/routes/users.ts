import { Hono } from "hono";
import { z } from "zod";

import { badRequest, notFound, readJson } from "../http.js";
import type { Services } from "../services.js";
import { requireAdmin, type AppEnv, type CurrentUser } from "../session.js";

const roleSchema = z.object({
  role: z.enum(["admin", "clerk"], { error: "Role must be admin or clerk" }),
});

export function userRoutes(services: Services) {
  const { db } = services;
  const app = new Hono<AppEnv>();
  app.use("*", requireAdmin);

  const selectUser = db.prepare<[string], CurrentUser>(
    "SELECT id, name, email, role FROM user WHERE id = ?",
  );

  app.get("/", (c) =>
    c.json(
      db
        .prepare<[], CurrentUser>(
          "SELECT id, name, email, role FROM user ORDER BY name COLLATE NOCASE, email",
        )
        .all(),
    ),
  );

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const { role } = await readJson(c, roleSchema);
    if (!selectUser.get(id)) throw notFound("User not found");
    if (id === c.get("user").id) throw badRequest("You cannot change your own role");
    db.prepare("UPDATE user SET role = ? WHERE id = ?").run(role, id);
    return c.json(selectUser.get(id));
  });

  return app;
}

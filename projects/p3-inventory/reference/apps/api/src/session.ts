import { createMiddleware } from "hono/factory";

import { forbidden, unauthorized } from "./http.js";
import type { Services } from "./services.js";

export type Role = "clerk" | "admin";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface AppEnv {
  Variables: { user: CurrentUser };
}

/** Resolves the better-auth session and loads the user's current role from the database. */
export function requireSession(services: Services) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = await services.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw unauthorized();
    const user = services.db
      .prepare<[string], CurrentUser>("SELECT id, name, email, role FROM user WHERE id = ?")
      .get(session.user.id);
    if (!user) throw unauthorized();
    c.set("user", user);
    await next();
  });
}

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").role !== "admin") throw forbidden();
  await next();
});

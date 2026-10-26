import { createMiddleware } from "hono/factory";

import { forbidden, notFound, unauthorized } from "./http.js";
import type { Services } from "./services.js";

export const ROLES = ["owner", "accountant", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
}

export interface Membership {
  orgId: string;
  orgName: string;
  role: Role;
}

export interface AppEnv {
  Variables: { user: CurrentUser; membership: Membership };
}

/** Resolves the better-auth session into the current user (401 without one). */
export function requireSession(services: Services) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = await services.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw unauthorized();
    const user = services.db
      .prepare<[string], CurrentUser>("SELECT id, name, email FROM user WHERE id = ?")
      .get(session.user.id);
    if (!user) throw unauthorized();
    c.set("user", user);
    await next();
  });
}

/**
 * Loads the caller's membership of `:orgId` from the database on every request.
 * Non-members get the same 404 as for an organization that does not exist.
 */
export function requireMembership(services: Services) {
  const select = services.db.prepare<[string, string], Membership>(
    `SELECT o.id AS orgId, o.name AS orgName, m.role AS role
       FROM membership m JOIN organization o ON o.id = m.org_id
      WHERE m.org_id = ? AND m.user_id = ?`,
  );
  return createMiddleware<AppEnv>(async (c, next) => {
    const orgId = c.req.param("orgId") ?? "";
    const membership = select.get(orgId, c.get("user").id);
    if (!membership) throw notFound("Organization not found");
    c.set("membership", membership);
    await next();
  });
}

/** Allows the request only for the given roles (403 otherwise). */
export function allow(...roles: Role[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!roles.includes(c.get("membership").role)) throw forbidden();
    await next();
  });
}

/** Any role may read; writes need owner or accountant. */
export const canWrite = allow("owner", "accountant");
export const ownerOnly = allow("owner");

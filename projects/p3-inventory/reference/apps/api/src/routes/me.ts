import { Hono } from "hono";

import type { AppEnv } from "../session.js";

export function meRoutes() {
  return new Hono<AppEnv>().get("/", (c) => c.json(c.get("user")));
}

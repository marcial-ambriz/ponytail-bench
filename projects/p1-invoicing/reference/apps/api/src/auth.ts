import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

import type { DB } from "./db.js";

export const MIN_PASSWORD_LENGTH = 8;
export const PASSWORD_TOO_SHORT = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

export interface AuthOptions {
  db: DB;
  secret: string;
  webPort: number;
}

function stringField(body: unknown, key: string): string {
  if (body && typeof body === "object") {
    const value: unknown = Reflect.get(body, key);
    return typeof value === "string" ? value : "";
  }
  return "";
}

/** Server-side sign-up validation that better-auth does not express with our contract messages. */
export function signUpError(body: unknown): string | null {
  if (!stringField(body, "name").trim()) return "Name is required";
  if (!stringField(body, "email").trim()) return "Email is required";
  if (stringField(body, "password").length < MIN_PASSWORD_LENGTH) return PASSWORD_TOO_SHORT;
  return null;
}

export function buildAuthOptions({ db, secret, webPort }: AuthOptions) {
  return {
    database: db,
    secret,
    basePath: "/api/auth",
    baseURL: {
      allowedHosts: ["localhost", "localhost:*", "127.0.0.1", "127.0.0.1:*"],
      fallback: `http://localhost:${webPort}`,
      protocol: "http" as const,
    },
    telemetry: { enabled: false },
    rateLimit: { enabled: false },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    },
    hooks: {
      before: createAuthMiddleware((ctx) => {
        const message = ctx.path === "/sign-up/email" ? signUpError(ctx.body) : null;
        if (message) return Promise.reject(new APIError("UNPROCESSABLE_ENTITY", { message }));
        return Promise.resolve();
      }),
    },
  };
}

export function createAuth(options: AuthOptions) {
  return betterAuth(buildAuthOptions(options));
}

export type Auth = ReturnType<typeof createAuth>;

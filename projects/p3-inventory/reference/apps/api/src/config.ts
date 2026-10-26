import { z } from "zod";

const envSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_PORT: z.coerce.number().int().positive().default(5173),
  DB_PATH: z.string().min(1).default("./data/stockly.db"),
  BETTER_AUTH_SECRET: z.string().min(32).default("stockly-development-secret-change-me-0123456789"),
});

export type Config = z.infer<typeof envSchema>;

export const config: Config = envSchema.parse(process.env);

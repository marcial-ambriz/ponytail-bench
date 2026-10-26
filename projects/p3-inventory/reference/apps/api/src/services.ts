import { getMigrations } from "better-auth/db/migration";

import { buildAuthOptions, createAuth, type Auth } from "./auth.js";
import { migrateAppSchema, openDatabase, type DB } from "./db.js";

export const SEED_ADMIN = {
  email: "admin@stockly.test",
  password: "Admin1234!",
  name: "Admin",
} as const;

export interface Services {
  db: DB;
  auth: Auth;
  /** Current time; injectable so booking rules are testable. */
  now: () => Date;
}

export interface ServiceOptions {
  dbPath: string;
  secret: string;
  webPort: number;
  now?: () => Date;
}

/** Opens the database, creates/migrates the schema and seeds the admin user. */
export async function createServices(options: ServiceOptions): Promise<Services> {
  const db = openDatabase(options.dbPath);
  const authOptions = buildAuthOptions({ db, secret: options.secret, webPort: options.webPort });
  const { runMigrations } = await getMigrations(authOptions);
  await runMigrations();
  migrateAppSchema(db);

  const auth = createAuth({ db, secret: options.secret, webPort: options.webPort });
  await seedAdmin(db, auth);

  return { db, auth, now: options.now ?? (() => new Date()) };
}

async function seedAdmin(db: DB, auth: Auth): Promise<void> {
  const row = db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM user").get();
  if (row && row.count > 0) return;
  await auth.api.signUpEmail({ body: { ...SEED_ADMIN } });
  db.prepare("UPDATE user SET role = 'admin' WHERE email = ?").run(SEED_ADMIN.email);
}

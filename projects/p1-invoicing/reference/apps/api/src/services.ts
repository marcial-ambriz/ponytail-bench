import { getMigrations } from "better-auth/db/migration";

import { buildAuthOptions, createAuth, type Auth } from "./auth.js";
import { migrateAppSchema, openDatabase, type DB } from "./db.js";

export interface Services {
  db: DB;
  auth: Auth;
  /** Current time; injectable so date rules are testable. */
  now: () => Date;
}

export interface ServiceOptions {
  dbPath: string;
  secret: string;
  webPort: number;
  now?: () => Date;
}

/** Opens the database and creates/migrates the schema. */
export async function createServices(options: ServiceOptions): Promise<Services> {
  const db = openDatabase(options.dbPath);
  const authOptions = buildAuthOptions({ db, secret: options.secret, webPort: options.webPort });
  const { runMigrations } = await getMigrations(authOptions);
  await runMigrations();
  migrateAppSchema(db);

  const auth = createAuth({ db, secret: options.secret, webPort: options.webPort });
  return { db, auth, now: options.now ?? (() => new Date()) };
}

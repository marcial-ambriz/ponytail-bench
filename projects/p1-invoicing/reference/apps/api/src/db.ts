import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Creates the application tables (better-auth owns `user`, `session`, `account`, `verification`). */
export function migrateAppSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      webhook_secret TEXT NOT NULL,
      invoice_seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS membership (
      org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'accountant', 'viewer')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS invitation (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      email TEXT NOT NULL COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'accountant', 'viewer')),
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      created_at TEXT NOT NULL,
      UNIQUE (org_id, email)
    );

    CREATE TABLE IF NOT EXISTS invoice (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL REFERENCES customer(id),
      number INTEGER,
      status TEXT NOT NULL CHECK (status IN ('draft', 'issued', 'paid', 'void')),
      issue_date TEXT,
      due_date TEXT NOT NULL,
      notes TEXT,
      subtotal_cents INTEGER NOT NULL,
      tax_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (org_id, number)
    );

    CREATE TABLE IF NOT EXISTS invoice_line (
      invoice_id TEXT NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      tax_rate_bps INTEGER NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      tax_cents INTEGER NOT NULL,
      total_cents INTEGER NOT NULL,
      PRIMARY KEY (invoice_id, position)
    );

    CREATE TABLE IF NOT EXISTS payment (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      invoice_id TEXT NOT NULL REFERENCES invoice(id),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      method TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      reference TEXT,
      source TEXT NOT NULL CHECK (source IN ('manual', 'payflow')),
      provider_payment_id TEXT,
      refunded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (org_id, provider_payment_id)
    );

    CREATE TABLE IF NOT EXISTS webhook_event (
      org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      payment_id TEXT,
      received_at TEXT NOT NULL,
      PRIMARY KEY (org_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS audit_entry (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      org_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      actor_id TEXT,
      actor_name TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS invoice_org ON invoice (org_id);
    CREATE INDEX IF NOT EXISTS payment_invoice ON payment (invoice_id);
    CREATE INDEX IF NOT EXISTS audit_org ON audit_entry (org_id, seq);
    CREATE INDEX IF NOT EXISTS webhook_event_payment ON webhook_event (org_id, payment_id, type);

    CREATE TRIGGER IF NOT EXISTS audit_entry_no_update BEFORE UPDATE ON audit_entry
    BEGIN SELECT RAISE(ABORT, 'audit entries are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_entry_no_delete BEFORE DELETE ON audit_entry
    BEGIN SELECT RAISE(ABORT, 'audit entries are append-only'); END;
  `);
}

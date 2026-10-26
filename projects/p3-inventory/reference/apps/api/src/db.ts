import { randomUUID } from "node:crypto";
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

export const SCHEMA_V3 = `
  CREATE TABLE product (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    description TEXT,
    reorder_point INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
    on_hand INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
    created_at TEXT NOT NULL
  );

  CREATE TABLE movement (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    product_id TEXT NOT NULL REFERENCES product(id),
    type TEXT NOT NULL CHECK (type IN ('receipt', 'issue', 'adjustment', 'shipment')),
    quantity INTEGER NOT NULL CHECK (quantity <> 0),
    unit_cost_cents INTEGER,
    reason TEXT,
    order_id TEXT,
    balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
    user_id TEXT NOT NULL REFERENCES user(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX movement_product ON movement (product_id, seq);

  CREATE TABLE sales_order (
    id TEXT PRIMARY KEY,
    customer TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'shipped', 'cancelled')),
    created_by TEXT NOT NULL REFERENCES user(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE order_line (
    order_id TEXT NOT NULL REFERENCES sales_order(id),
    line_no INTEGER NOT NULL,
    product_id TEXT NOT NULL REFERENCES product(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (order_id, line_no)
  );
`;

/**
 * v3 -> v4 (checkpoint 4): warehouses and variants. Stock moves from `product` to `stock` (per variant and
 * warehouse). Every existing product gets a "Default" variant with its SKU and reorder point; all existing stock,
 * reservations, movements and orders move to that variant in the MAIN warehouse. Ids, timestamps, users,
 * balances and history order (`movement.seq`) are copied unchanged.
 */
function migrateV4(db: DB): void {
  const now = new Date().toISOString();
  db.exec(`
    CREATE TABLE warehouse (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE variant (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES product(id),
      sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      reorder_point INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (product_id, position)
    );

    CREATE TABLE stock (
      variant_id TEXT NOT NULL REFERENCES variant(id),
      warehouse_id TEXT NOT NULL REFERENCES warehouse(id),
      on_hand INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
      reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
      PRIMARY KEY (variant_id, warehouse_id)
    );

    CREATE TABLE transfer (
      id TEXT PRIMARY KEY,
      variant_id TEXT NOT NULL REFERENCES variant(id),
      from_warehouse_id TEXT NOT NULL REFERENCES warehouse(id),
      to_warehouse_id TEXT NOT NULL REFERENCES warehouse(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      created_by TEXT NOT NULL REFERENCES user(id),
      created_at TEXT NOT NULL
    );
  `);

  const main = randomUUID();
  db.prepare(
    "INSERT INTO warehouse (id, code, name, created_at) VALUES (?, 'MAIN', 'Main warehouse', ?)",
  ).run(main, now);
  const products = db
    .prepare<
      [],
      {
        id: string;
        sku: string;
        reorder_point: number;
        on_hand: number;
        reserved: number;
        created_at: string;
      }
    >("SELECT id, sku, reorder_point, on_hand, reserved, created_at FROM product")
    .all();
  const insertVariant = db.prepare(
    "INSERT INTO variant (id, product_id, sku, name, reorder_point, position, created_at) VALUES (?, ?, ?, 'Default', ?, 0, ?)",
  );
  const insertStock = db.prepare(
    "INSERT INTO stock (variant_id, warehouse_id, on_hand, reserved) VALUES (?, ?, ?, ?)",
  );
  for (const p of products) {
    const variantId = randomUUID();
    insertVariant.run(variantId, p.id, p.sku, p.reorder_point, p.created_at);
    insertStock.run(variantId, main, p.on_hand, p.reserved);
  }

  db.exec(`
    CREATE TABLE movement_v4 (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      product_id TEXT NOT NULL REFERENCES product(id),
      variant_id TEXT NOT NULL REFERENCES variant(id),
      warehouse_id TEXT NOT NULL REFERENCES warehouse(id),
      type TEXT NOT NULL CHECK (type IN ('receipt', 'issue', 'adjustment', 'shipment', 'transfer_in', 'transfer_out')),
      quantity INTEGER NOT NULL CHECK (quantity <> 0),
      unit_cost_cents INTEGER,
      reason TEXT,
      order_id TEXT,
      transfer_id TEXT,
      balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
      user_id TEXT NOT NULL REFERENCES user(id),
      created_at TEXT NOT NULL
    );
    INSERT INTO movement_v4 (seq, id, product_id, variant_id, warehouse_id, type, quantity, unit_cost_cents, reason,
                             order_id, transfer_id, balance_after, user_id, created_at)
      SELECT m.seq, m.id, m.product_id, v.id, '${main}', m.type, m.quantity, m.unit_cost_cents, m.reason,
             m.order_id, NULL, m.balance_after, m.user_id, m.created_at
      FROM movement m JOIN variant v ON v.product_id = m.product_id AND v.position = 0;
    DROP TABLE movement;
    ALTER TABLE movement_v4 RENAME TO movement;
    CREATE INDEX movement_product ON movement (product_id, seq);
    CREATE INDEX movement_variant ON movement (variant_id, warehouse_id, seq);
    CREATE INDEX movement_created ON movement (created_at);

    CREATE TABLE sales_order_v4 (
      id TEXT PRIMARY KEY,
      customer TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'shipped', 'cancelled')),
      warehouse_id TEXT NOT NULL REFERENCES warehouse(id),
      created_by TEXT NOT NULL REFERENCES user(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO sales_order_v4 (rowid, id, customer, status, warehouse_id, created_by, created_at, updated_at)
      SELECT rowid, id, customer, status, '${main}', created_by, created_at, updated_at FROM sales_order;
    DROP TABLE sales_order;
    ALTER TABLE sales_order_v4 RENAME TO sales_order;

    CREATE TABLE order_line_v4 (
      order_id TEXT NOT NULL REFERENCES sales_order(id),
      line_no INTEGER NOT NULL,
      product_id TEXT NOT NULL REFERENCES product(id),
      variant_id TEXT NOT NULL REFERENCES variant(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (order_id, line_no)
    );
    INSERT INTO order_line_v4 (order_id, line_no, product_id, variant_id, quantity)
      SELECT l.order_id, l.line_no, l.product_id, v.id, l.quantity
      FROM order_line l JOIN variant v ON v.product_id = l.product_id AND v.position = 0;
    DROP TABLE order_line;
    ALTER TABLE order_line_v4 RENAME TO order_line;

    CREATE TABLE product_v4 (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO product_v4 (rowid, id, name, description, created_at)
      SELECT rowid, id, name, description, created_at FROM product;
    DROP TABLE product;
    ALTER TABLE product_v4 RENAME TO product;
  `);
}

/**
 * Creates or upgrades the application tables (better-auth owns `user`, `session`, `account`, `verification`).
 * `PRAGMA user_version` records the schema version; each step runs once, inside one transaction, with foreign keys
 * checked at the end (table rebuilds need them off while tables are swapped).
 */
export function migrateAppSchema(db: DB): void {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version >= 4) return;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      if (version < 3) db.exec(SCHEMA_V3);
      migrateV4(db);
      const broken = db.pragma("foreign_key_check");
      if (Array.isArray(broken) && broken.length > 0) {
        throw new Error(`migration left ${broken.length} broken references`);
      }
      db.pragma("user_version = 4");
    }).immediate();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

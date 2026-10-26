import { describe, expect, it } from "vitest";

import { migrateAppSchema, openDatabase, SCHEMA_V3 } from "./db.js";

/** A checkpoint-3 database: the frozen v3 schema plus a little data. */
function v3Database() {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  db.exec(SCHEMA_V3);
  db.pragma("user_version = 3");
  db.exec(`
    INSERT INTO user VALUES ('u1', 'Ann');
    INSERT INTO product (id, sku, name, reorder_point, on_hand, reserved, created_at)
      VALUES ('p1', 'AB-1', 'Widget', 4, 7, 2, '2030-01-01T00:00:00.000Z'),
             ('p2', 'AB-2', 'Gadget', 0, 0, 0, '2030-01-02T00:00:00.000Z');
    INSERT INTO movement (id, product_id, type, quantity, unit_cost_cents, reason, order_id, balance_after, user_id, created_at)
      VALUES ('m1', 'p1', 'receipt', 10, 250, NULL, NULL, 10, 'u1', '2030-01-03T00:00:00.000Z'),
             ('m2', 'p1', 'shipment', -3, NULL, NULL, 'o1', 7, 'u1', '2030-01-04T00:00:00.000Z');
    INSERT INTO sales_order VALUES ('o1', 'ACME', 'shipped', 'u1', '2030-01-04T00:00:00.000Z', '2030-01-04T00:00:00.000Z'),
                                   ('o2', 'Globex', 'reserved', 'u1', '2030-01-05T00:00:00.000Z', '2030-01-05T00:00:00.000Z');
    INSERT INTO order_line VALUES ('o1', 1, 'p1', 3), ('o2', 1, 'p1', 2);
  `);
  return db;
}

describe("v3 -> v4 migration", () => {
  it("moves stock, movements and orders to a Default variant in MAIN without losing anything", () => {
    const db = v3Database();
    migrateAppSchema(db);
    expect(db.pragma("user_version", { simple: true })).toBe(4);

    const main = db
      .prepare<[], { id: string; name: string }>(
        "SELECT id, name FROM warehouse WHERE code = 'MAIN'",
      )
      .get();
    if (!main) throw new Error("MAIN missing");
    expect(main.name).toBe("Main warehouse");
    const variants = db
      .prepare("SELECT product_id, sku, name, reorder_point FROM variant ORDER BY sku")
      .all();
    expect(variants).toEqual([
      { product_id: "p1", sku: "AB-1", name: "Default", reorder_point: 4 },
      { product_id: "p2", sku: "AB-2", name: "Default", reorder_point: 0 },
    ]);
    const stock = db
      .prepare(
        "SELECT v.sku, s.warehouse_id, s.on_hand, s.reserved FROM stock s JOIN variant v ON v.id = s.variant_id ORDER BY v.sku",
      )
      .all();
    expect(stock).toEqual([
      { sku: "AB-1", warehouse_id: main.id, on_hand: 7, reserved: 2 },
      { sku: "AB-2", warehouse_id: main.id, on_hand: 0, reserved: 0 },
    ]);
    const movements = db
      .prepare(
        "SELECT seq, id, type, quantity, unit_cost_cents, order_id, balance_after, warehouse_id, created_at FROM movement ORDER BY seq",
      )
      .all();
    expect(movements).toEqual([
      {
        seq: 1,
        id: "m1",
        type: "receipt",
        quantity: 10,
        unit_cost_cents: 250,
        order_id: null,
        balance_after: 10,
        warehouse_id: main.id,
        created_at: "2030-01-03T00:00:00.000Z",
      },
      {
        seq: 2,
        id: "m2",
        type: "shipment",
        quantity: -3,
        unit_cost_cents: null,
        order_id: "o1",
        balance_after: 7,
        warehouse_id: main.id,
        created_at: "2030-01-04T00:00:00.000Z",
      },
    ]);
    const orders = db.prepare("SELECT id, status, warehouse_id FROM sales_order ORDER BY id").all();
    expect(orders).toEqual([
      { id: "o1", status: "shipped", warehouse_id: main.id },
      { id: "o2", status: "reserved", warehouse_id: main.id },
    ]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM order_line WHERE variant_id IS NOT NULL").get(),
    ).toEqual({ n: 2 });
  });

  it("runs once: a restart does not duplicate anything", () => {
    const db = v3Database();
    migrateAppSchema(db);
    migrateAppSchema(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM warehouse").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM variant").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM movement").get()).toEqual({ n: 2 });
  });
});

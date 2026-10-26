import { randomUUID } from "node:crypto";

import type { DB } from "../db.js";
import { badRequest, conflict, notFound } from "../http.js";

export type MovementType =
  | "receipt"
  | "issue"
  | "adjustment"
  | "shipment"
  | "transfer_in"
  | "transfer_out";

// ---------------------------------------------------------------- warehouses

export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
}

export function findWarehouse(db: DB, id: string): WarehouseRow | undefined {
  return db
    .prepare<[string], WarehouseRow>("SELECT id, code, name FROM warehouse WHERE id = ?")
    .get(id);
}

export function mainWarehouse(db: DB): WarehouseRow {
  const row = db
    .prepare<[], WarehouseRow>("SELECT id, code, name FROM warehouse WHERE code = 'MAIN'")
    .get();
  if (!row) throw new Error("MAIN warehouse is missing");
  return row;
}

/** The warehouse named in a request body (422 when unknown), or MAIN when absent. */
export function warehouseFromBody(db: DB, id: string | undefined): WarehouseRow {
  if (id === undefined) return mainWarehouse(db);
  const row = findWarehouse(db, id);
  if (!row) throw badRequest(`Unknown warehouse ${id}`);
  return row;
}

// ---------------------------------------------------------------- variants

export interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  name: string;
  reorder_point: number;
  position: number;
}

const VARIANT_COLUMNS = "id, product_id, sku, name, reorder_point, position";

export function findVariant(db: DB, id: string): VariantRow | undefined {
  return db
    .prepare<[string], VariantRow>(`SELECT ${VARIANT_COLUMNS} FROM variant WHERE id = ?`)
    .get(id);
}

export function firstVariant(db: DB, productId: string): VariantRow {
  const row = db
    .prepare<[string], VariantRow>(
      `SELECT ${VARIANT_COLUMNS} FROM variant WHERE product_id = ? ORDER BY position LIMIT 1`,
    )
    .get(productId);
  if (!row) throw notFound("Product not found");
  return row;
}

export function skuTaken(db: DB, sku: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM variant WHERE sku = ?").get(sku));
}

export function insertVariant(
  db: DB,
  input: { productId: string; sku: string; name: string; reorderPoint: number; at: string },
): string {
  const id = randomUUID();
  const next = db
    .prepare<[string], { n: number }>(
      "SELECT COALESCE(MAX(position) + 1, 0) AS n FROM variant WHERE product_id = ?",
    )
    .get(input.productId);
  db.prepare(
    "INSERT INTO variant (id, product_id, sku, name, reorder_point, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.productId, input.sku, input.name, input.reorderPoint, next?.n ?? 0, input.at);
  return id;
}

interface VariantTotalsRow extends VariantRow {
  on_hand: number;
  reserved: number;
}

function toVariant(row: VariantTotalsRow) {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    reorderPoint: row.reorder_point,
    onHand: row.on_hand,
    reserved: row.reserved,
    available: row.on_hand - row.reserved,
  };
}

const VARIANT_TOTALS = `
  SELECT v.id, v.product_id, v.sku, v.name, v.reorder_point, v.position,
         COALESCE(SUM(s.on_hand), 0) AS on_hand, COALESCE(SUM(s.reserved), 0) AS reserved
  FROM variant v LEFT JOIN stock s ON s.variant_id = v.id`;

export function variantView(db: DB, id: string) {
  const row = db
    .prepare<[string], VariantTotalsRow>(`${VARIANT_TOTALS} WHERE v.id = ? GROUP BY v.id`)
    .get(id);
  if (!row) throw notFound("Variant not found");
  return toVariant(row);
}

// ---------------------------------------------------------------- products

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export function loadProductRow(db: DB, id: string): ProductRow {
  const row = db
    .prepare<[string], ProductRow>(
      "SELECT id, name, description, created_at FROM product WHERE id = ?",
    )
    .get(id);
  if (!row) throw notFound("Product not found");
  return row;
}

export function productView(db: DB, id: string) {
  const product = loadProductRow(db, id);
  const variants = db
    .prepare<[string], VariantTotalsRow>(
      `${VARIANT_TOTALS} WHERE v.product_id = ? GROUP BY v.id ORDER BY v.position`,
    )
    .all(id)
    .map(toVariant);
  const stock = db
    .prepare<
      [string],
      {
        warehouse_id: string;
        code: string;
        variant_id: string;
        sku: string;
        on_hand: number;
        reserved: number;
      }
    >(
      `SELECT s.warehouse_id, w.code, s.variant_id, v.sku, s.on_hand, s.reserved
       FROM stock s JOIN variant v ON v.id = s.variant_id JOIN warehouse w ON w.id = s.warehouse_id
       WHERE v.product_id = ? AND (s.on_hand <> 0 OR s.reserved <> 0)
       ORDER BY v.position, w.code`,
    )
    .all(id)
    .map((s) => ({
      warehouseId: s.warehouse_id,
      warehouseCode: s.code,
      variantId: s.variant_id,
      sku: s.sku,
      onHand: s.on_hand,
      reserved: s.reserved,
      available: s.on_hand - s.reserved,
    }));
  const first = variants[0];
  const onHand = variants.reduce((n, v) => n + v.onHand, 0);
  const reserved = variants.reduce((n, v) => n + v.reserved, 0);
  return {
    id: product.id,
    sku: first?.sku ?? "",
    name: product.name,
    description: product.description,
    reorderPoint: first?.reorderPoint ?? 0,
    onHand,
    reserved,
    available: onHand - reserved,
    createdAt: product.created_at,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      reorderPoint: v.reorderPoint,
      onHand: v.onHand,
      reserved: v.reserved,
      available: v.available,
    })),
    stock,
  };
}

export type ProductView = ReturnType<typeof productView>;

// ---------------------------------------------------------------- stock

interface StockRow {
  on_hand: number;
  reserved: number;
}

function stockRow(db: DB, variantId: string, warehouseId: string): StockRow {
  return (
    db
      .prepare<[string, string], StockRow>(
        "SELECT on_hand, reserved FROM stock WHERE variant_id = ? AND warehouse_id = ?",
      )
      .get(variantId, warehouseId) ?? { on_hand: 0, reserved: 0 }
  );
}

function writeStock(db: DB, variantId: string, warehouseId: string, row: StockRow): void {
  db.prepare(
    `INSERT INTO stock (variant_id, warehouse_id, on_hand, reserved) VALUES (?, ?, ?, ?)
     ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET on_hand = excluded.on_hand, reserved = excluded.reserved`,
  ).run(variantId, warehouseId, row.on_hand, row.reserved);
}

// ---------------------------------------------------------------- movements

interface MovementRow {
  id: string;
  product_id: string;
  variant_id: string;
  sku: string;
  warehouse_id: string;
  warehouse_code: string;
  type: MovementType;
  quantity: number;
  unit_cost_cents: number | null;
  reason: string | null;
  order_id: string | null;
  transfer_id: string | null;
  balance_after: number;
  user_id: string;
  user_name: string;
  created_at: string;
}

export const MOVEMENT_SELECT = `
  SELECT m.id, m.product_id, m.variant_id, v.sku, m.warehouse_id, w.code AS warehouse_code, m.type, m.quantity,
         m.unit_cost_cents, m.reason, m.order_id, m.transfer_id, m.balance_after, m.user_id, u.name AS user_name,
         m.created_at
  FROM movement m
  JOIN user u ON u.id = m.user_id
  JOIN variant v ON v.id = m.variant_id
  JOIN warehouse w ON w.id = m.warehouse_id`;

export function toMovement(row: MovementRow) {
  return {
    id: row.id,
    productId: row.product_id,
    variantId: row.variant_id,
    sku: row.sku,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    type: row.type,
    quantity: row.quantity,
    unitCostCents: row.unit_cost_cents,
    reason: row.reason,
    orderId: row.order_id,
    transferId: row.transfer_id,
    balanceAfter: row.balance_after,
    userId: row.user_id,
    userName: row.user_name,
    createdAt: row.created_at,
  };
}

export function loadMovement(db: DB, id: string) {
  const row = db.prepare<[string], MovementRow>(`${MOVEMENT_SELECT} WHERE m.id = ?`).get(id);
  if (!row) throw notFound("Movement not found");
  return toMovement(row);
}

export function listMovements(
  db: DB,
  productId: string,
  filters: { variantId?: string; warehouseId?: string } = {},
) {
  const where = ["m.product_id = ?"];
  const params = [productId];
  if (filters.variantId) {
    where.push("m.variant_id = ?");
    params.push(filters.variantId);
  }
  if (filters.warehouseId) {
    where.push("m.warehouse_id = ?");
    params.push(filters.warehouseId);
  }
  return db
    .prepare<string[], MovementRow>(
      `${MOVEMENT_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.seq DESC`,
    )
    .all(...params)
    .map(toMovement);
}

export interface MovementInput {
  variantId: string;
  warehouseId: string;
  type: MovementType;
  /** Signed: positive adds stock, negative removes it. */
  quantity: number;
  unitCostCents: number | null;
  reason: string | null;
  orderId: string | null;
  transferId: string | null;
  userId: string;
  at: string;
}

/**
 * Records one movement and updates the stock row it affects. Must run inside a transaction.
 * Only available stock can leave, except for shipments, which consume their own reservation.
 */
export function applyMovement(db: DB, input: MovementInput): string {
  const variant = findVariant(db, input.variantId);
  if (!variant) throw notFound("Variant not found");
  const stock = stockRow(db, input.variantId, input.warehouseId);
  const available = stock.on_hand - stock.reserved;
  let reserved = stock.reserved;
  if (input.type === "shipment") {
    reserved += input.quantity;
  } else if (input.quantity < 0 && -input.quantity > available) {
    throw conflict(`Insufficient stock: only ${available} of ${variant.sku} available`);
  }
  const onHand = stock.on_hand + input.quantity;
  if (onHand < 0 || reserved < 0 || reserved > onHand) throw conflict("Insufficient stock");
  writeStock(db, input.variantId, input.warehouseId, { on_hand: onHand, reserved });
  const id = randomUUID();
  db.prepare(
    `INSERT INTO movement (id, product_id, variant_id, warehouse_id, type, quantity, unit_cost_cents, reason,
                           order_id, transfer_id, balance_after, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    variant.product_id,
    input.variantId,
    input.warehouseId,
    input.type,
    input.quantity,
    input.unitCostCents,
    input.reason,
    input.orderId,
    input.transferId,
    onHand,
    input.userId,
    input.at,
  );
  return id;
}

/** Holds units of a variant in a warehouse for an order. Must run inside a transaction. */
export function reserve(db: DB, variantId: string, warehouseId: string, quantity: number): void {
  const stock = stockRow(db, variantId, warehouseId);
  const available = stock.on_hand - stock.reserved;
  if (quantity > available) {
    const sku = findVariant(db, variantId)?.sku ?? variantId;
    throw conflict(`Insufficient stock for ${sku}: only ${available} available`);
  }
  writeStock(db, variantId, warehouseId, { ...stock, reserved: stock.reserved + quantity });
}

export function release(db: DB, variantId: string, warehouseId: string, quantity: number): void {
  db.prepare(
    "UPDATE stock SET reserved = reserved - ? WHERE variant_id = ? AND warehouse_id = ?",
  ).run(quantity, variantId, warehouseId);
}

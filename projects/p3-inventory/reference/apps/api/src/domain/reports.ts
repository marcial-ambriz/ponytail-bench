import type { DB } from "../db.js";
import type { MovementType } from "./inventory.js";

/** round(n / d) half up, for non-negative integers, exact (BigInt). */
export function divRound(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

interface ReplayRow {
  variant_id: string;
  warehouse_id: string;
  type: MovementType;
  quantity: number;
  unit_cost_cents: number | null;
}

export interface VariantValue {
  /** Units over all warehouses. */
  q: bigint;
  /** Value in cents over all warehouses. */
  v: bigint;
  /** Units per warehouse. */
  byWarehouse: Map<string, bigint>;
}

/** Applies one movement to a variant's moving-average state (spec cp5 R5.1). */
export function applyToValue(state: VariantValue, m: ReplayRow): void {
  const qty = BigInt(m.quantity);
  state.byWarehouse.set(m.warehouse_id, (state.byWarehouse.get(m.warehouse_id) ?? 0n) + qty);
  if (m.type === "transfer_in" || m.type === "transfer_out") return;
  if (m.type === "receipt") {
    state.q += qty;
    state.v += qty * BigInt(m.unit_cost_cents ?? 0);
  } else if (qty < 0n) {
    const out = -qty;
    state.v -= state.q > 0n ? divRound(state.v * out, state.q) : 0n;
    state.q -= out;
  } else {
    state.v += state.q > 0n ? divRound(state.v * qty, state.q) : 0n;
    state.q += qty;
  }
}

/** Replays every movement in recording order and returns the valuation state per variant. */
export function valueVariants(db: DB): Map<string, VariantValue> {
  const out = new Map<string, VariantValue>();
  const rows = db
    .prepare<[], ReplayRow>(
      "SELECT variant_id, warehouse_id, type, quantity, unit_cost_cents FROM movement ORDER BY seq",
    )
    .iterate();
  for (const m of rows) {
    let state = out.get(m.variant_id);
    if (!state) {
      state = { q: 0n, v: 0n, byWarehouse: new Map() };
      out.set(m.variant_id, state);
    }
    applyToValue(state, m);
  }
  return out;
}

interface VariantInfo {
  id: string;
  sku: string;
  product_name: string;
  variant_name: string;
}

function variantInfo(db: DB): VariantInfo[] {
  return db
    .prepare<[], VariantInfo>(
      `SELECT v.id, v.sku, p.name AS product_name, v.name AS variant_name
       FROM variant v JOIN product p ON p.id = v.product_id ORDER BY v.sku`,
    )
    .all();
}

export function valuationReport(db: DB, warehouseId?: string) {
  const values = valueVariants(db);
  const rows = [];
  let total = 0n;
  for (const info of variantInfo(db)) {
    const s = values.get(info.id);
    if (!s) continue;
    const onHand = warehouseId ? (s.byWarehouse.get(warehouseId) ?? 0n) : s.q;
    if (onHand <= 0n) continue;
    const value = warehouseId ? (s.q > 0n ? divRound(s.v * onHand, s.q) : 0n) : s.v;
    const average = s.q > 0n ? divRound(s.v, s.q) : 0n;
    total += value;
    rows.push({
      variantId: info.id,
      sku: info.sku,
      productName: info.product_name,
      variantName: info.variant_name,
      onHand: Number(onHand),
      averageCostCents: Number(average),
      valueCents: Number(value),
    });
  }
  return { totalValueCents: Number(total), rows };
}

interface PeriodRow {
  variant_id: string;
  type: MovementType;
  quantity: number;
  before: number;
}

export function movementReport(db: DB, from: string, to: string, warehouseId?: string) {
  const start = `${from}T00:00:00.000Z`;
  const endExclusive = new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString();
  const where = warehouseId ? "AND warehouse_id = ?" : "";
  const params = warehouseId ? [start, endExclusive, warehouseId] : [start, endExclusive];
  const rows = db
    .prepare<string[], PeriodRow>(
      `SELECT variant_id, type, quantity, CASE WHEN created_at < ? THEN 1 ELSE 0 END AS before
       FROM movement WHERE created_at < ? ${where} ORDER BY seq`,
    )
    .all(...params);
  const acc = new Map<
    string,
    {
      opening: number;
      received: number;
      shipped: number;
      adjusted: number;
      transferred: number;
      any: boolean;
    }
  >();
  for (const r of rows) {
    let a = acc.get(r.variant_id);
    if (!a) {
      a = { opening: 0, received: 0, shipped: 0, adjusted: 0, transferred: 0, any: false };
      acc.set(r.variant_id, a);
    }
    if (r.before) {
      a.opening += r.quantity;
      continue;
    }
    a.any = true;
    if (r.type === "receipt") a.received += r.quantity;
    else if (r.type === "issue" || r.type === "shipment") a.shipped -= r.quantity;
    else if (r.type === "transfer_in" || r.type === "transfer_out") a.transferred += r.quantity;
    else a.adjusted += r.quantity;
  }
  const out = [];
  for (const info of variantInfo(db)) {
    const a = acc.get(info.id);
    if (!a || (!a.any && a.opening === 0)) continue;
    out.push({
      variantId: info.id,
      sku: info.sku,
      productName: info.product_name,
      variantName: info.variant_name,
      opening: a.opening,
      received: a.received,
      shipped: a.shipped,
      adjusted: a.adjusted,
      transferred: a.transferred,
      closing: a.opening + a.received - a.shipped + a.adjusted + a.transferred,
    });
  }
  return { from, to, rows: out };
}

/** RFC 4180 field. */
export function csvField(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function toCsv(header: string[], rows: Array<Array<string | number>>): string {
  return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

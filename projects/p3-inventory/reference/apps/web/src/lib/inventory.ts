import { queryOptions } from "@tanstack/react-query";

import { api } from "./api.ts";
import type { Role, User } from "./auth.ts";

export interface Variant {
  id: string;
  sku: string;
  name: string;
  reorderPoint: number;
  onHand: number;
  reserved: number;
  available: number;
}

export interface StockLevel {
  warehouseId: string;
  warehouseCode: string;
  variantId: string;
  sku: string;
  onHand: number;
  reserved: number;
  available: number;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  reorderPoint: number;
  onHand: number;
  reserved: number;
  available: number;
  createdAt: string;
  variants: Variant[];
  stock: StockLevel[];
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
}

export interface Transfer {
  id: string;
  variantId: string;
  sku: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: number;
  createdAt: string;
  createdBy: string;
}

export type MovementType =
  | "receipt"
  | "issue"
  | "adjustment"
  | "shipment"
  | "transfer_in"
  | "transfer_out";

export interface Movement {
  id: string;
  productId: string;
  variantId: string;
  sku: string;
  warehouseId: string;
  warehouseCode: string;
  transferId: string | null;
  type: MovementType;
  quantity: number;
  unitCostCents: number | null;
  reason: string | null;
  orderId: string | null;
  balanceAfter: number;
  userName: string;
  createdAt: string;
}

export type OrderStatus = "reserved" | "shipped" | "cancelled";

export interface Order {
  id: string;
  customer: string;
  status: OrderStatus;
  warehouseId: string;
  lines: { productId: string; variantId: string; sku: string; quantity: number }[];
  createdAt: string;
  createdBy: string;
}

export interface LowStock {
  productId: string;
  variantId: string;
  sku: string;
  name: string;
  variantName: string;
  available: number;
  reorderPoint: number;
}

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  receipt: "Receipt",
  issue: "Issue",
  adjustment: "Adjustment",
  shipment: "Shipment",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
};

export const STATUS_LABELS: Record<OrderStatus, string> = {
  reserved: "Reserved",
  shipped: "Shipped",
  cancelled: "Cancelled",
};

export const productsQuery = (q = "") =>
  queryOptions({
    queryKey: ["products", q],
    queryFn: () => api<Product[]>(`/api/products${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  });

export const productQuery = (id: string) =>
  queryOptions({
    queryKey: ["products", "detail", id],
    queryFn: () => api<Product>(`/api/products/${encodeURIComponent(id)}`),
  });

export const movementsQuery = (productId: string) =>
  queryOptions({
    queryKey: ["products", "detail", productId, "movements"],
    queryFn: () => api<Movement[]>(`/api/products/${encodeURIComponent(productId)}/movements`),
  });

export const ordersQuery = queryOptions({
  queryKey: ["orders"],
  queryFn: () => api<Order[]>("/api/orders"),
});

export const orderQuery = (id: string) =>
  queryOptions({
    queryKey: ["orders", id],
    queryFn: () => api<Order>(`/api/orders/${encodeURIComponent(id)}`),
  });

export const lowStockQuery = queryOptions({
  queryKey: ["products", "alerts"],
  queryFn: () => api<LowStock[]>("/api/alerts/low-stock"),
});

export const warehousesQuery = queryOptions({
  queryKey: ["warehouses"],
  queryFn: () => api<Warehouse[]>("/api/warehouses"),
  staleTime: 30_000,
});

export const transfersQuery = queryOptions({
  queryKey: ["transfers"],
  queryFn: () => api<Transfer[]>("/api/transfers"),
});

/** Every variant of every product, labeled "SKU — Product (Variant)", for selects. */
export function variantOptions(products: Product[] | undefined) {
  return (products ?? []).flatMap((p) =>
    p.variants.map((v) => ({
      id: v.id,
      productId: p.id,
      sku: v.sku,
      available: v.available,
      label: `${v.sku} — ${p.name}${p.variants.length > 1 || v.name !== "Default" ? ` (${v.name})` : ""}`,
    })),
  );
}

export const usersQuery = queryOptions({
  queryKey: ["users"],
  queryFn: () => api<User[]>("/api/users"),
});

export const updateUserRole = (id: string, role: Role) =>
  api<User>(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body: { role } });

/** "2030-01-07T08:00:00.000Z" -> "2030-01-07 08:00" (UTC). */
export function formatDateTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** Parses a decimal amount such as "2.50" into cents; null when it is not a valid amount. */
export function parseCents(value: string): number | null {
  const match = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

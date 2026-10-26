/**
 * Domain setup helpers over the documented API (spec cp1-cp5). Each asserts the documented success status.
 */
import { expect } from '@playwright/test';

import { expectStatus, idOf, uniq, uniqSku, type Api, type Json } from './api';

export interface ProductInput {
  sku?: string;
  name?: string;
  description?: string;
  reorderPoint?: number;
}

export async function createProduct(admin: Api, input: ProductInput = {}): Promise<any> {
  const body: Json = { sku: input.sku ?? uniqSku(), name: input.name ?? uniq('Product') };
  if (input.description !== undefined) body.description = input.description;
  if (input.reorderPoint !== undefined) body.reorderPoint = input.reorderPoint;
  return expectStatus(await admin.post('/api/products', body), 201, 'POST /api/products');
}

export async function getProduct(api: Api, id: string): Promise<any> {
  return expectStatus(await api.get(`/api/products/${id}`), 200, `GET /api/products/${id}`);
}

export function postMovement(api: Api, productId: string, body: Json) {
  return api.post(`/api/products/${productId}/movements`, body);
}

export async function receive(api: Api, productId: string, quantity: number, unitCostCents = 100, extra: Json = {}): Promise<any> {
  return expectStatus(await postMovement(api, productId, { type: 'receipt', quantity, unitCostCents, ...extra }), 201, `receipt ${quantity}`);
}

export async function issue(api: Api, productId: string, quantity: number, extra: Json = {}): Promise<any> {
  return expectStatus(await postMovement(api, productId, { type: 'issue', quantity, ...extra }), 201, `issue ${quantity}`);
}

export async function adjust(admin: Api, productId: string, quantity: number, reason = 'Cycle count', extra: Json = {}): Promise<any> {
  return expectStatus(await postMovement(admin, productId, { type: 'adjustment', quantity, reason, ...extra }), 201, `adjustment ${quantity}`);
}

export async function movements(api: Api, productId: string, query = ''): Promise<any[]> {
  const body = await expectStatus(await api.get(`/api/products/${productId}/movements${query}`), 200, 'GET movements');
  expect(Array.isArray(body), 'movements is an array').toBe(true);
  return body;
}

/** A product with `onHand` units received at `unitCostCents`. */
export async function stockedProduct(admin: Api, onHand: number, unitCostCents = 100, input: ProductInput = {}): Promise<any> {
  const p = await createProduct(admin, input);
  if (onHand > 0) await receive(admin, idOf(p), onHand, unitCostCents);
  return p;
}

export interface LineInput {
  productId?: string;
  variantId?: string;
  quantity: number;
}

export function postOrder(api: Api, lines: LineInput[], extra: Json = {}) {
  return api.post('/api/orders', { customer: uniq('Customer'), lines, ...extra });
}

export async function createOrder(api: Api, lines: LineInput[], extra: Json = {}): Promise<any> {
  return expectStatus(await postOrder(api, lines, extra), 201, 'POST /api/orders');
}

export async function shipOrder(api: Api, orderId: string): Promise<any> {
  return expectStatus(await api.post(`/api/orders/${orderId}/ship`), 200, 'ship order');
}

export async function cancelOrder(api: Api, orderId: string): Promise<any> {
  return expectStatus(await api.post(`/api/orders/${orderId}/cancel`), 200, 'cancel order');
}

export async function lowStock(api: Api): Promise<any[]> {
  return expectStatus(await api.get('/api/alerts/low-stock'), 200, 'GET /api/alerts/low-stock');
}

export async function userIdByEmail(admin: Api, email: string): Promise<string> {
  const users = (await expectStatus(await admin.get('/api/users'), 200, 'GET /api/users')) as Json[];
  const u = users.find((x) => x.email === email);
  expect(u, `user ${email} in GET /api/users`).toBeDefined();
  return String(u!.id);
}

// ---------------------------------------------------------------- checkpoint 4

export async function warehouses(api: Api): Promise<any[]> {
  return expectStatus(await api.get('/api/warehouses'), 200, 'GET /api/warehouses');
}

export async function mainWarehouse(api: Api): Promise<any> {
  const all = await warehouses(api);
  const main = all.find((w) => w.code === 'MAIN');
  expect(main, 'warehouse MAIN exists (R4.1)').toBeDefined();
  return main;
}

export async function createWarehouse(admin: Api, name = uniq('Depot')): Promise<any> {
  const code = `W${Math.random().toString(36).slice(2, 10).toUpperCase()}`.replace(/[^A-Z0-9]/g, '0').slice(0, 10);
  return expectStatus(await admin.post('/api/warehouses', { code, name }), 201, 'POST /api/warehouses');
}

export async function createVariant(admin: Api, productId: string, input: { sku?: string; name?: string; reorderPoint?: number } = {}): Promise<any> {
  const body: Json = { sku: input.sku ?? uniqSku('V'), name: input.name ?? uniq('Var').slice(0, 40) };
  if (input.reorderPoint !== undefined) body.reorderPoint = input.reorderPoint;
  return expectStatus(await admin.post(`/api/products/${productId}/variants`, body), 201, 'POST variants');
}

export function postTransfer(api: Api, body: Json) {
  return api.post('/api/transfers', body);
}

/** Units of `variantId` in `warehouseId` per the product's `stock` array (0 when absent, R4.6). */
export function stockOf(product: any, variantId: string, warehouseId: string): { onHand: number; reserved: number; available: number } {
  const row = (product.stock as Json[] | undefined)?.find((s) => String(s.variantId) === variantId && String(s.warehouseId) === warehouseId);
  return row
    ? { onHand: Number(row.onHand), reserved: Number(row.reserved), available: Number(row.available) }
    : { onHand: 0, reserved: 0, available: 0 };
}

export function firstVariant(product: any): any {
  const v = (product.variants as Json[] | undefined)?.[0];
  expect(v, 'product.variants[0] exists (R4.6)').toBeDefined();
  return v;
}

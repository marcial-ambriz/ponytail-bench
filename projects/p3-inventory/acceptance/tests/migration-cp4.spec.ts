/**
 * CP4 migration check (R4.18). The harness ran `run.sh seed-cp3` against the checkpoint-3 app, kept that database
 * and started this checkpoint-4 app on a copy of it. The seed snapshot (SEED_MANIFEST) holds what the CP3 app itself
 * answered; every field below must be unchanged after the migration. Read-only: nothing seeded is modified, so the
 * data-loss hazard can inspect the same data afterwards.
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { adminApi, expectStatus, mainWarehouse, signIn, type Json } from './support';

interface Manifest {
  complete: boolean;
  steps: Array<{ name: string; ok: boolean; status: number; error: string | null }>;
  users: Array<{ key: string; email: string; password: string; name: string; role: string }>;
  products: Array<{ key: string; product: Json; movements: Json[] }>;
  orders: Json[];
  lowStock: Json[];
}

function manifest(): Manifest {
  const path = process.env.SEED_MANIFEST ?? '';
  if (!path || !existsSync(path)) throw new Error(`no CP3 seed snapshot at "${path}": the CP3 seed step did not run`);
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

const MOVEMENT_FIELDS = ['id', 'productId', 'type', 'quantity', 'unitCostCents', 'reason', 'orderId', 'balanceAfter', 'userId', 'userName'];
const pick = (o: Json, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
const sameInstant = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b);

test.describe('Checkpoint 4 - migration of checkpoint-3 data', () => {
  test('[cp4.40][R4.18][C2] the CP3 seed exists and every seeded product kept its id, SKU, name, stock and reorder point, now as a "Default" variant in MAIN', async ({ playwright }) => {
    const m = manifest();
    expect(m.products.length, `CP3 seed created products (seed steps failed: ${m.steps.filter((s) => !s.ok).map((s) => s.name).join(', ')})`).toBeGreaterThan(0);
    const admin = await adminApi(playwright);
    const main = await mainWarehouse(admin);
    for (const { key, product: before } of m.products) {
      const after = await expectStatus(await admin.get(`/api/products/${before.id}`), 200, `product ${key} still exists`);
      expect(pick(after, ['id', 'sku', 'name', 'description', 'onHand', 'reserved', 'available', 'reorderPoint']), `product ${key}`).toEqual(
        pick(before, ['id', 'sku', 'name', 'description', 'onHand', 'reserved', 'available', 'reorderPoint']),
      );
      expect(sameInstant(after.createdAt, before.createdAt), `product ${key} createdAt`).toBe(true);
      expect(after.variants, `product ${key} has exactly one variant`).toHaveLength(1);
      expect(after.variants[0]).toMatchObject({
        sku: before.sku,
        name: 'Default',
        reorderPoint: before.reorderPoint,
        onHand: before.onHand,
        reserved: before.reserved,
        available: before.available,
      });
      for (const s of after.stock as Json[]) {
        expect(s.warehouseId, `product ${key}: all stock in MAIN`).toBe(main.id);
      }
    }
    await admin.dispose();
  });

  test('[cp4.41][R4.18][C2] every seeded movement survived unchanged (same ids and order, type, quantity, cost, reason, order, user, timestamp, balance) in MAIN', async ({ playwright }) => {
    const m = manifest();
    const admin = await adminApi(playwright);
    const main = await mainWarehouse(admin);
    let count = 0;
    for (const { key, product, movements: before } of m.products) {
      const after = (await expectStatus(await admin.get(`/api/products/${product.id}/movements`), 200, `movements ${key}`)) as Json[];
      expect(after.map((x) => x.id), `product ${key}: same movements in the same order`).toEqual(before.map((x) => x.id));
      after.forEach((a, i) => {
        expect(pick(a, MOVEMENT_FIELDS), `product ${key} movement ${i}`).toEqual(pick(before[i], MOVEMENT_FIELDS));
        expect(sameInstant(a.createdAt, before[i].createdAt), `product ${key} movement ${i} createdAt`).toBe(true);
        expect(a.warehouseId, 'migrated movements are in MAIN').toBe(main.id);
        expect(a.sku).toBe(product.sku);
        expect(a.transferId ?? null).toBeNull();
      });
      count += after.length;
    }
    expect(count, 'the seed recorded movements').toBeGreaterThan(0);
    await admin.dispose();
  });

  test('[cp4.42][R4.18][C2] every seeded order kept its customer, status, lines and creator, now in MAIN', async ({ playwright }) => {
    const m = manifest();
    expect(m.orders.length, 'CP3 seed created orders').toBeGreaterThan(0);
    const admin = await adminApi(playwright);
    const main = await mainWarehouse(admin);
    for (const before of m.orders) {
      const after = await expectStatus(await admin.get(`/api/orders/${before.id}`), 200, `order ${before.customer}`);
      expect(pick(after, ['id', 'customer', 'status', 'createdBy'])).toEqual(pick(before, ['id', 'customer', 'status', 'createdBy']));
      expect(sameInstant(after.createdAt, before.createdAt)).toBe(true);
      expect(after.warehouseId).toBe(main.id);
      expect((after.lines as Json[]).map((l) => pick(l, ['productId', 'sku', 'quantity']))).toEqual(
        (before.lines as Json[]).map((l) => pick(l, ['productId', 'sku', 'quantity'])),
      );
      for (const l of after.lines as Json[]) expect(l.variantId, 'lines gain variantId').toBeDefined();
    }
    const listed = ((await (await admin.get('/api/orders')).json()) as Json[]).map((o) => o.id);
    for (const o of m.orders) expect(listed, `order ${o.customer} listed`).toContain(o.id);
    await admin.dispose();
  });

  test('[cp4.43][R4.18][C2] low-stock status and users (passwords and roles) survived the migration', async ({ playwright }) => {
    const m = manifest();
    const admin = await adminApi(playwright);
    const ids = new Set(m.products.map((p) => String(p.product.id)));
    const now = ((await (await admin.get('/api/alerts/low-stock')).json()) as Json[]).filter((a) => ids.has(String(a.productId)));
    expect(now.map((a) => pick(a, ['productId', 'sku', 'name', 'available', 'reorderPoint']))).toEqual(
      m.lowStock.map((a) => pick(a, ['productId', 'sku', 'name', 'available', 'reorderPoint'])),
    );
    for (const u of m.users) {
      const api = await signIn(playwright, u.email, u.password);
      const me = await (await api.get('/api/me')).json();
      expect(me, `user ${u.key}`).toMatchObject({ email: u.email, name: u.name, role: u.role });
      await api.dispose();
    }
    await admin.dispose();
  });
});

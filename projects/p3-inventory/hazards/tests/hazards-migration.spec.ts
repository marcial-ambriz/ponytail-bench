/**
 * Data-loss hazard for the CP4 migration (plan §5 P3): the CP3 data the harness seeded (snapshot in SEED_MANIFEST)
 * must still add up after the CP4 app migrated it. Read-only.
 */
import { existsSync, readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { adminApi, type Json } from '../../acceptance/tests/support';

test('[H18][data-loss:3][cp4][R4.18] migrated history still adds up: same movements, running balances and totals, no duplicates', async ({ playwright }) => {
  const path = process.env.SEED_MANIFEST ?? '';
  if (!path || !existsSync(path)) throw new Error(`no CP3 seed snapshot at "${path}"`);
  const m = JSON.parse(readFileSync(path, 'utf8')) as { products: Array<{ key: string; product: Json; movements: Json[] }>; orders: Json[] };
  expect(m.products.length).toBeGreaterThan(0);
  const admin = await adminApi(playwright);
  let before = 0;
  let after = 0;
  for (const { key, product, movements } of m.products) {
    const p = (await (await admin.get(`/api/products/${product.id}`)).json()) as Json;
    const ms = (await (await admin.get(`/api/products/${product.id}/movements`)).json()) as Json[];
    before += movements.length;
    after += ms.length;
    expect(new Set(ms.map((x) => x.id)).size, `${key}: no duplicated movements`).toBe(ms.length);
    const sum = ms.reduce((n, x) => n + Number(x.quantity), 0);
    expect(sum, `${key}: sum of movement quantities == onHand`).toBe(Number(p.onHand));
    expect(Number(p.onHand), `${key}: onHand unchanged`).toBe(Number(product.onHand));
    let running = 0;
    for (const x of [...ms].reverse()) {
      running += Number(x.quantity);
      expect(Number(x.balanceAfter), `${key}: balanceAfter of ${x.id} matches the running total`).toBe(running);
    }
    expect(ms.reduce((n, x) => n + Number(x.unitCostCents ?? 0) * Math.max(0, Number(x.quantity)) * (x.type === 'receipt' ? 1 : 0), 0), `${key}: receipt value`).toBe(
      movements.reduce((n, x) => n + Number(x.unitCostCents ?? 0) * Math.max(0, Number(x.quantity)) * (x.type === 'receipt' ? 1 : 0), 0),
    );
  }
  expect(after, 'movement count unchanged').toBe(before);
  const reservedByOrders = new Map<string, number>();
  for (const o of m.orders) {
    const now = (await (await admin.get(`/api/orders/${o.id}`)).json()) as Json;
    expect(now.status, `order ${o.customer}`).toBe(o.status);
    if (now.status === 'reserved') {
      for (const l of now.lines as Json[]) reservedByOrders.set(String(l.productId), (reservedByOrders.get(String(l.productId)) ?? 0) + Number(l.quantity));
    }
  }
  for (const { key, product } of m.products) {
    const p = (await (await admin.get(`/api/products/${product.id}`)).json()) as Json;
    expect(Number(p.reserved), `${key}: reserved == open seeded orders`).toBe(reservedByOrders.get(String(product.id)) ?? 0);
  }
  await admin.dispose();
});

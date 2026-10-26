import { expect, test } from '@playwright/test';

import {
  adminApi,
  clerkApi,
  createProduct,
  createVariant,
  createWarehouse,
  firstVariant,
  getProduct,
  mainWarehouse,
  missingId,
  movements,
  postTransfer,
  receive,
  stockOf,
  uniqSku,
  type Json,
} from '../../acceptance/tests/support';

test.describe('Hazards cp4', () => {
  test('[H12][concurrency:3][cp4][R4.10] 30 parallel transfers of 1 unit out of a warehouse holding 5: exactly 5 succeed, nothing goes negative', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const p = await createProduct(admin);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    const variantId = firstVariant(p).id;
    await receive(admin, p.id, 5, 100);
    const statuses = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        postTransfer(i % 2 ? c.api : admin, { variantId, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 1 }).then((r) => r.status()),
      ),
    );
    expect(statuses.filter((s) => s === 201).length, statuses.join(',')).toBe(5);
    const after = await getProduct(admin, p.id);
    expect(stockOf(after, String(variantId), String(main.id)).onHand).toBe(0);
    expect(stockOf(after, String(variantId), String(east.id)).onHand).toBe(5);
    expect(after.onHand).toBe(5);
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[H13][concurrency:3][cp4][R4.10] crossing transfers in both directions in parallel keep the total and pair every movement', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const p = await createProduct(admin);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    const variantId = firstVariant(p).id;
    await receive(admin, p.id, 10, 100);
    await receive(admin, p.id, 4, 100, { warehouseId: east.id });
    // Asymmetric on purpose (2 units forward, 1 back, 2:1 mix) so lost updates cannot cancel out.
    const jobs = Array.from({ length: 42 }, (_, i) => {
      const forward = i % 3 !== 0;
      const body = { variantId, fromWarehouseId: forward ? main.id : east.id, toWarehouseId: forward ? east.id : main.id, quantity: forward ? 2 : 1 };
      return postTransfer(i % 3 ? admin : c.api, body).then(async (r) => ({ forward, status: r.status(), body: r.ok() ? ((await r.json()) as Json) : null }));
    });
    const results = await Promise.all(jobs);
    expect(results.every((r) => r.status === 201 || r.status === 409), JSON.stringify(results.map((r) => r.status))).toBe(true);
    const after = await getProduct(admin, p.id);
    const inMain = stockOf(after, String(variantId), String(main.id)).onHand;
    const inEast = stockOf(after, String(variantId), String(east.id)).onHand;
    expect(inMain + inEast, 'total never changes').toBe(14);
    expect(inMain).toBeGreaterThanOrEqual(0);
    expect(inEast).toBeGreaterThanOrEqual(0);
    const fwd = results.filter((r) => r.status === 201 && r.forward).length;
    const back = results.filter((r) => r.status === 201 && !r.forward).length;
    expect(inMain, 'MAIN = 10 - 2 x forward + 1 x back').toBe(10 - 2 * fwd + back);
    const ms = await movements(admin, p.id);
    for (const [label, w] of [['MAIN', main], ['east', east]] as const) {
      const sum = ms.filter((m) => m.warehouseId === w.id).reduce((n, m) => n + Number(m.quantity), 0);
      expect(sum, `${label}: stock equals the sum of its movements`).toBe(label === 'MAIN' ? inMain : inEast);
    }
    const byTransfer = new Map<string, Json[]>();
    for (const m of ms.filter((x) => x.transferId)) byTransfer.set(String(m.transferId), [...(byTransfer.get(String(m.transferId)) ?? []), m]);
    expect(byTransfer.size, 'one transferId per successful transfer').toBe(fwd + back);
    for (const [id, pair] of byTransfer) {
      expect(pair.map((m) => m.type).sort(), `transfer ${id}`).toEqual(['transfer_in', 'transfer_out']);
      expect(pair.reduce((n, m) => n + Number(m.quantity), 0), `transfer ${id} nets to zero`).toBe(0);
    }
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[H14][data-loss:3][cp4][R4.10] a failed transfer records nothing on either side', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    const variantId = firstVariant(p).id;
    await receive(admin, p.id, 3, 100);
    const tries = [
      { variantId, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 4 },
      { variantId, fromWarehouseId: main.id, toWarehouseId: missingId(String(east.id)), quantity: 1 },
      { variantId, fromWarehouseId: missingId(String(east.id)), toWarehouseId: main.id, quantity: 1 },
      { variantId, fromWarehouseId: main.id, toWarehouseId: main.id, quantity: 1 },
    ];
    for (const body of tries) {
      const s = (await postTransfer(admin, body)).status();
      expect(s >= 400 && s < 500, `${JSON.stringify(body)} -> ${s}`).toBe(true);
    }
    expect(await movements(admin, p.id)).toHaveLength(1);
    const after = await getProduct(admin, p.id);
    expect(stockOf(after, String(variantId), String(main.id)).onHand).toBe(3);
    expect(((await (await admin.get('/api/transfers')).json()) as Json[]).some((t) => t.variantId === variantId)).toBe(false);
    await admin.dispose();
  });

  test('[H15][validation:2][cp4][R4.10] transfers with negative, zero, fractional, string or huge quantities -> 422 and nothing moves', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    const variantId = firstVariant(p).id;
    await receive(admin, p.id, 5, 100);
    for (const quantity of [-2, 0, 1.5, '1', 1e20, null]) {
      const s = (await postTransfer(admin, { variantId, fromWarehouseId: main.id, toWarehouseId: east.id, quantity })).status();
      expect(s, `quantity ${JSON.stringify(quantity)}`).toBe(422);
    }
    // A negative transfer from east to main would "pull" stock from a warehouse that has none.
    expect((await postTransfer(admin, { variantId, fromWarehouseId: east.id, toWarehouseId: main.id, quantity: -5 })).status()).toBe(422);
    const after = await getProduct(admin, p.id);
    expect(stockOf(after, String(variantId), String(east.id)).onHand).toBe(0);
    expect(await movements(admin, p.id)).toHaveLength(1);
    await admin.dispose();
  });

  test('[H16][authz:2][cp4][R4.2,R4.5] a clerk cannot create or rename warehouses or create or edit variants', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const p = await createProduct(admin);
    const v = await createVariant(admin, p.id, { name: 'Small' });
    const main = await mainWarehouse(admin);
    expect((await c.api.post('/api/warehouses', { code: 'CLK1', name: 'Clerk depot' })).status()).toBe(403);
    expect((await c.api.patch(`/api/warehouses/${main.id}`, { name: 'Hijacked' })).status()).toBe(403);
    const sku = uniqSku('C');
    expect((await c.api.post(`/api/products/${p.id}/variants`, { sku, name: 'Clerk variant' })).status()).toBe(403);
    expect((await c.api.patch(`/api/variants/${v.id}`, { name: 'Clerk rename', reorderPoint: 99 })).status()).toBe(403);
    expect((await mainWarehouse(admin)).name).toBe('Main warehouse');
    const after = await getProduct(admin, p.id);
    expect(after.variants.map((x: Json) => x.sku)).toEqual([p.sku, v.sku]);
    expect(after.variants[1]).toMatchObject({ name: 'Small', reorderPoint: 0 });
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[H17][concurrency:2][cp4][R4.4] concurrent creation of the same variant SKU: exactly one succeeds', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const a = await createProduct(admin);
    const b = await createProduct(admin);
    const sku = uniqSku('R');
    const statuses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => admin.post(`/api/products/${i % 2 ? a.id : b.id}/variants`, { sku, name: `Race ${i}` }).then((r) => r.status())),
    );
    expect(statuses.filter((s) => s === 201).length, statuses.join(',')).toBe(1);
    const all = [...(await getProduct(admin, a.id)).variants, ...(await getProduct(admin, b.id)).variants];
    expect(all.filter((v: Json) => v.sku === sku)).toHaveLength(1);
    await admin.dispose();
  });
});

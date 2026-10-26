import { expect, test } from '@playwright/test';

import {
  adminApi,
  clerkApi,
  createOrder,
  expectStatus,
  getProduct,
  movements,
  postOrder,
  stockedProduct,
  type Json,
} from '../../acceptance/tests/support';

test.describe('Hazards cp3', () => {
  test('[H06][concurrency:3][cp3][R3.4,R3.1] two simultaneous orders for the last unit: exactly one succeeds; 30 orders for 5 units: exactly 5', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const a = await clerkApi(playwright);
    const b = await clerkApi(playwright);
    const last = await stockedProduct(admin, 1);
    const pair = await Promise.all([postOrder(a.api, [{ productId: last.id, quantity: 1 }]), postOrder(b.api, [{ productId: last.id, quantity: 1 }])]);
    expect(pair.map((r) => r.status()).sort()).toEqual([201, 409]);
    expect(await getProduct(admin, last.id)).toMatchObject({ onHand: 1, reserved: 1, available: 0 });

    const five = await stockedProduct(admin, 5);
    const statuses = await Promise.all(
      Array.from({ length: 30 }, (_, i) => postOrder(i % 2 ? a.api : b.api, [{ productId: five.id, quantity: 1 }]).then((r) => r.status())),
    );
    expect(statuses.filter((s) => s === 201).length, statuses.join(',')).toBe(5);
    const p = await getProduct(admin, five.id);
    expect(p).toMatchObject({ onHand: 5, reserved: 5, available: 0 });
    await Promise.all([admin.dispose(), a.api.dispose(), b.api.dispose()]);
  });

  test('[H07][concurrency:3][cp3][R3.2,R3.4] parallel issues and orders competing for the same units never oversell (available >= 0)', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const p = await stockedProduct(admin, 6);
    const calls = Array.from({ length: 24 }, (_, i) =>
      i % 2
        ? postOrder(c.api, [{ productId: p.id, quantity: 1 }]).then((r) => ['order', r.status()] as const)
        : c.api.post(`/api/products/${p.id}/movements`, { type: 'issue', quantity: 1 }).then((r) => ['issue', r.status()] as const),
    );
    const results = await Promise.all(calls);
    const ok = results.filter(([, s]) => s === 201);
    expect(ok.length, JSON.stringify(results)).toBe(6);
    const after = await getProduct(admin, p.id);
    const orders = ok.filter(([k]) => k === 'order').length;
    const issues = ok.filter(([k]) => k === 'issue').length;
    expect(after).toMatchObject({ onHand: 6 - issues, reserved: orders, available: 0 });
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[H08][idempotency:3][cp3][R3.5] 20 parallel "ship" requests for one order deduct the stock once', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 10);
    const o = await createOrder(admin, [{ productId: p.id, quantity: 4 }]);
    const statuses = await Promise.all(Array.from({ length: 20 }, () => admin.post(`/api/orders/${o.id}/ship`).then((r) => r.status())));
    expect(statuses.filter((s) => s === 200).length, statuses.join(',')).toBe(1);
    expect(statuses.filter((s) => s !== 200).every((s) => s === 409)).toBe(true);
    expect(await getProduct(admin, p.id)).toMatchObject({ onHand: 6, reserved: 0 });
    expect((await movements(admin, p.id)).filter((m) => m.type === 'shipment')).toHaveLength(1);
    await admin.dispose();
  });

  test('[H09][idempotency:2][cp3][R3.6] parallel cancels release the reservation exactly once; a cancel racing a ship never does both', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 10);
    const keep = await createOrder(admin, [{ productId: p.id, quantity: 3 }]);
    const drop = await createOrder(admin, [{ productId: p.id, quantity: 4 }]);
    await Promise.all(Array.from({ length: 15 }, () => admin.post(`/api/orders/${drop.id}/cancel`)));
    expect(await getProduct(admin, p.id), 'only the cancelled order is released').toMatchObject({ onHand: 10, reserved: 3, available: 7 });
    expect((await (await admin.get(`/api/orders/${keep.id}`)).json()).status).toBe('reserved');

    const race = await createOrder(admin, [{ productId: p.id, quantity: 2 }]);
    const [ship, cancel] = await Promise.all([admin.post(`/api/orders/${race.id}/ship`), admin.post(`/api/orders/${race.id}/cancel`)]);
    const final = await (await admin.get(`/api/orders/${race.id}`)).json();
    const after = await getProduct(admin, p.id);
    if (final.status === 'shipped') {
      expect(ship.status()).toBe(200);
      expect(cancel.status()).toBe(409);
      expect(after).toMatchObject({ onHand: 8, reserved: 3 });
    } else {
      expect(final.status).toBe('cancelled');
      expect(ship.status()).toBe(409);
      expect(after).toMatchObject({ onHand: 10, reserved: 3 });
    }
    await admin.dispose();
  });

  test('[H10][data-loss:3][cp3][R3.4] an order whose last line fails reserves nothing on its earlier lines', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const lines = await Promise.all([10, 10, 10, 1].map((n) => stockedProduct(admin, n)));
    const res = await postOrder(admin, [
      ...lines.slice(0, 3).map((p) => ({ productId: p.id, quantity: 5 })),
      { productId: lines[3].id, quantity: 2 },
    ]);
    await expectStatus(res, 409, 'last line over available');
    for (const p of lines) expect((await getProduct(admin, p.id)).reserved, `product ${p.sku}`).toBe(0);
    const orders = (await (await admin.get('/api/orders')).json()) as Json[];
    expect(orders.some((o) => (o.lines as Json[]).some((l) => l.productId === lines[3].id)), 'no half order stored').toBe(false);
    await admin.dispose();
  });

  test('[H11][validation:2][cp3][R3.3] order lines with negative, zero, fractional, string or huge quantities -> 422 and nothing reserved', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 5);
    for (const quantity of [-1, 0, 0.5, '2', 1e20, null]) {
      const res = await admin.post('/api/orders', { customer: 'Valid customer', lines: [{ productId: p.id, quantity }] });
      expect(res.status(), `quantity ${JSON.stringify(quantity)}`).toBe(422);
    }
    const mixed = await admin.post('/api/orders', { customer: 'Valid customer', lines: [{ productId: p.id, quantity: 7 }, { productId: p.id, quantity: -2 }] });
    expect(mixed.status(), 'a negative line cannot offset another line').toBe(422);
    expect((await getProduct(admin, p.id)).reserved).toBe(0);
    await admin.dispose();
  });
});

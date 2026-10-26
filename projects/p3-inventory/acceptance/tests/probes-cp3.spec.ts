import { expect, test } from '@playwright/test';

import {
  adminApi,
  anonApi,
  cancelOrder,
  clerkApi,
  createOrder,
  createProduct,
  expectError,
  expectStatus,
  getProduct,
  lowStock,
  missingId,
  movements,
  postMovement,
  postOrder,
  receive,
  shipOrder,
  stockedProduct,
  uniq,
  type Json,
} from './support';

test.describe('Checkpoint 3 - API probes', () => {
  test('[cp3.20][R3.3,R3.7,R3.13][C2] order and alert endpoints return 401 { error } without a session', async ({ playwright }) => {
    const anon = await anonApi(playwright);
    for (const [method, path] of [
      ['GET', '/api/orders'],
      ['POST', '/api/orders'],
      ['GET', '/api/orders/x'],
      ['POST', '/api/orders/x/ship'],
      ['POST', '/api/orders/x/cancel'],
      ['GET', '/api/alerts/low-stock'],
    ] as const) {
      await expectStatus(await anon.send(method, path, method === 'POST' ? {} : undefined), 401, `${method} ${path}`);
    }
    await anon.dispose();
  });

  test('[cp3.21][R3.1,R3.3][C2] POST /api/orders -> 201 { id, customer, status "reserved", lines, createdAt, createdBy }; products expose reserved/available', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const a = await stockedProduct(admin, 10);
    const b = await stockedProduct(admin, 4);
    expect(await getProduct(admin, a.id)).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
    const customer = uniq('Hooli');
    const order = await expectStatus(
      await c.api.post('/api/orders', { customer: `  ${customer}  `, lines: [{ productId: a.id, quantity: 3 }, { productId: b.id, quantity: 4 }] }),
      201,
      'POST /api/orders',
    );
    expect(order).toMatchObject({
      customer,
      status: 'reserved',
      createdBy: c.user.name,
      lines: [
        { productId: a.id, sku: a.sku, quantity: 3 },
        { productId: b.id, sku: b.sku, quantity: 4 },
      ],
    });
    expect(order.id).toBeDefined();
    expect(Number.isNaN(Date.parse(order.createdAt))).toBe(false);
    expect(await getProduct(admin, a.id)).toMatchObject({ onHand: 10, reserved: 3, available: 7 });
    expect(await getProduct(admin, b.id)).toMatchObject({ onHand: 4, reserved: 4, available: 0 });
    const listed = (await (await admin.get('/api/products')).json()).find((x: Json) => x.id === a.id);
    expect(listed).toMatchObject({ reserved: 3, available: 7 });
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[cp3.22][R3.3][C2] invalid orders -> 422 { error } and nothing is reserved', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 50);
    const ok = { productId: p.id, quantity: 1 };
    const many = Array.from({ length: 21 }, () => ok);
    const cases: Array<[string, unknown]> = [
      ['missing customer', { lines: [ok] }],
      ['customer too short', { customer: ' A ', lines: [ok] }],
      ['customer too long', { customer: 'C'.repeat(81), lines: [ok] }],
      ['missing lines', { customer: 'Valid customer' }],
      ['no lines', { customer: 'Valid customer', lines: [] }],
      ['21 lines', { customer: 'Valid customer', lines: many }],
      ['zero quantity', { customer: 'Valid customer', lines: [{ productId: p.id, quantity: 0 }] }],
      ['negative quantity', { customer: 'Valid customer', lines: [{ productId: p.id, quantity: -2 }] }],
      ['fractional quantity', { customer: 'Valid customer', lines: [{ productId: p.id, quantity: 1.5 }] }],
      ['string quantity', { customer: 'Valid customer', lines: [{ productId: p.id, quantity: '2' }] }],
      ['same product twice', { customer: 'Valid customer', lines: [ok, { productId: p.id, quantity: 2 }] }],
      ['unknown product', { customer: 'Valid customer', lines: [{ productId: missingId(String(p.id)), quantity: 1 }] }],
    ];
    for (const [label, body] of cases) {
      await expectStatus(await admin.post('/api/orders', body), 422, label);
    }
    expect((await getProduct(admin, p.id)).reserved).toBe(0);
    const longest = await expectStatus(await admin.post('/api/orders', { customer: 'C'.repeat(80), lines: [ok] }), 201, '80-char customer');
    expect(longest.customer).toHaveLength(80);
    await admin.dispose();
  });

  test('[cp3.23][R3.4][C2] one line over the available stock -> 409 "Insufficient stock" and no line is reserved', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const a = await stockedProduct(admin, 10);
    const b = await stockedProduct(admin, 2);
    await expectError(await postOrder(admin, [{ productId: a.id, quantity: 5 }, { productId: b.id, quantity: 3 }]), 409, 'insufficient stock', 'second line too big');
    await expectError(await postOrder(admin, [{ productId: b.id, quantity: 3 }, { productId: a.id, quantity: 5 }]), 409, 'insufficient stock', 'first line too big');
    expect((await getProduct(admin, a.id)).reserved).toBe(0);
    expect((await getProduct(admin, b.id)).reserved).toBe(0);
    await createOrder(admin, [{ productId: b.id, quantity: 2 }]);
    await expectError(await postOrder(admin, [{ productId: b.id, quantity: 1 }]), 409, 'insufficient stock', 'reserved units are not available');
    await admin.dispose();
  });

  test('[cp3.24][R3.2][C2] issues and negative adjustments may only take available (unreserved) stock', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 10);
    await createOrder(admin, [{ productId: p.id, quantity: 7 }]);
    await expectError(await postMovement(admin, p.id, { type: 'issue', quantity: 4 }), 409, 'insufficient stock', 'issue 4 of 3 available');
    await expectError(await postMovement(admin, p.id, { type: 'adjustment', quantity: -4, reason: 'Recount' }), 409, 'insufficient stock', 'adjust -4 of 3 available');
    await expectStatus(await postMovement(admin, p.id, { type: 'issue', quantity: 3 }), 201, 'issue the 3 available');
    expect(await getProduct(admin, p.id)).toMatchObject({ onHand: 7, reserved: 7, available: 0 });
    await admin.dispose();
  });

  test('[cp3.25][R3.5][C2] ship: one "shipment" movement per line (negative, with orderId); stock and reservation drop; shipping again -> 409', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const a = await stockedProduct(admin, 10);
    const b = await stockedProduct(admin, 6);
    const order = await createOrder(c.api, [{ productId: a.id, quantity: 4 }, { productId: b.id, quantity: 6 }]);
    const shipped = await shipOrder(c.api, order.id);
    expect(shipped).toMatchObject({ id: order.id, status: 'shipped' });
    expect(await getProduct(admin, a.id)).toMatchObject({ onHand: 6, reserved: 0, available: 6 });
    expect(await getProduct(admin, b.id)).toMatchObject({ onHand: 0, reserved: 0, available: 0 });
    const [ma, receiptA] = await movements(admin, a.id);
    expect(ma).toMatchObject({ type: 'shipment', quantity: -4, orderId: order.id, balanceAfter: 6, userName: c.user.name });
    expect(receiptA).toMatchObject({ type: 'receipt', orderId: null });
    const [mb] = await movements(admin, b.id);
    expect(mb).toMatchObject({ type: 'shipment', quantity: -6, orderId: order.id, balanceAfter: 0 });
    await expectStatus(await c.api.post(`/api/orders/${order.id}/ship`), 409, 'ship twice');
    expect(await movements(admin, a.id)).toHaveLength(2);
    expect((await getProduct(admin, a.id)).onHand).toBe(6);
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[cp3.26][R3.6][C2] cancel releases the reservation; cancelling again -> 200 with no effect; shipped or cancelled orders cannot change state', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 10);
    const order = await createOrder(admin, [{ productId: p.id, quantity: 6 }]);
    const cancelled = await cancelOrder(admin, order.id);
    expect(cancelled).toMatchObject({ id: order.id, status: 'cancelled' });
    expect(await getProduct(admin, p.id)).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
    await cancelOrder(admin, order.id);
    expect((await getProduct(admin, p.id)).reserved, 'second cancel releases nothing').toBe(0);
    await expectStatus(await admin.post(`/api/orders/${order.id}/ship`), 409, 'ship a cancelled order');
    expect(await movements(admin, p.id)).toHaveLength(1);

    const other = await createOrder(admin, [{ productId: p.id, quantity: 2 }]);
    await shipOrder(admin, other.id);
    await expectStatus(await admin.post(`/api/orders/${other.id}/cancel`), 409, 'cancel a shipped order');
    expect(await getProduct(admin, p.id)).toMatchObject({ onHand: 8, reserved: 0 });
    await admin.dispose();
  });

  test('[cp3.27][R3.7][C2] GET /api/orders is newest first with a status filter; GET /api/orders/:id; unknown -> 404', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 10);
    const first = await createOrder(admin, [{ productId: p.id, quantity: 1 }]);
    const second = await createOrder(admin, [{ productId: p.id, quantity: 1 }]);
    await shipOrder(admin, first.id);
    const all = (await expectStatus(await admin.get('/api/orders'), 200, 'list')) as Json[];
    const ids = all.map((o) => o.id);
    expect(ids.indexOf(second.id), 'newest first').toBeLessThan(ids.indexOf(first.id));
    const shipped = (await expectStatus(await admin.get('/api/orders?status=shipped'), 200, 'status=shipped')) as Json[];
    expect(shipped.every((o) => o.status === 'shipped')).toBe(true);
    expect(shipped.map((o) => o.id)).toContain(first.id);
    expect(shipped.map((o) => o.id)).not.toContain(second.id);
    const one = await expectStatus(await admin.get(`/api/orders/${second.id}`), 200, 'get');
    expect(one).toMatchObject({ id: second.id, status: 'reserved', customer: second.customer });
    await expectStatus(await admin.get(`/api/orders/${missingId(String(second.id))}`), 404, 'unknown order');
    await expectStatus(await admin.post(`/api/orders/${missingId(String(second.id))}/ship`), 404, 'ship unknown');
    await expectStatus(await admin.post(`/api/orders/${missingId(String(second.id))}/cancel`), 404, 'cancel unknown');
    await admin.dispose();
  });

  test('[cp3.28][R3.12][C2] reorderPoint defaults to 0, is set by admins on POST/PATCH and validated', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const p = await createProduct(admin);
    expect(p.reorderPoint).toBe(0);
    const q = await createProduct(admin, { reorderPoint: 25 });
    expect(q.reorderPoint).toBe(25);
    expect((await expectStatus(await admin.patch(`/api/products/${p.id}`, { reorderPoint: 7 }), 200, 'PATCH')).reorderPoint).toBe(7);
    for (const bad of [-1, 1.5, '5', 1_000_001]) {
      await expectStatus(await admin.patch(`/api/products/${p.id}`, { reorderPoint: bad }), 422, `reorderPoint ${JSON.stringify(bad)}`);
    }
    await expectStatus(await c.api.patch(`/api/products/${p.id}`, { reorderPoint: 1 }), 403, 'clerk PATCH');
    expect((await getProduct(admin, p.id)).reorderPoint).toBe(7);
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[cp3.29][R3.13][C2] low stock: reorderPoint > 0 and available <= reorderPoint, ordered by SKU; reservations count', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const atPoint = await stockedProduct(admin, 5, 100, { reorderPoint: 5 });
    const above = await stockedProduct(admin, 6, 100, { reorderPoint: 5 });
    const untracked = await stockedProduct(admin, 0, 100, { reorderPoint: 0 });
    const empty = await createProduct(admin, { reorderPoint: 1 });
    const has = (list: Json[], id: unknown) => list.some((x) => x.productId === id);
    let list = await lowStock(admin);
    expect(has(list, atPoint.id), 'available == reorderPoint is low').toBe(true);
    expect(has(list, above.id), 'available > reorderPoint is not low').toBe(false);
    expect(has(list, untracked.id), 'reorderPoint 0 is never low').toBe(false);
    expect(has(list, empty.id)).toBe(true);
    expect(list.find((x) => x.productId === atPoint.id)).toMatchObject({ sku: atPoint.sku, name: atPoint.name, available: 5, reorderPoint: 5 });
    const skus = list.map((x) => String(x.sku));
    expect(skus, 'ordered by SKU').toEqual([...skus].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));

    await createOrder(admin, [{ productId: above.id, quantity: 1 }]);
    list = await lowStock(admin);
    expect(list.find((x) => x.productId === above.id), 'a reservation can make a product low').toMatchObject({ available: 5 });
    await receive(admin, atPoint.id, 1, 100);
    expect(has(await lowStock(admin), atPoint.id), 'a receipt clears the alert').toBe(false);
    await admin.dispose();
  });
});

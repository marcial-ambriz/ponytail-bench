import { expect, test } from '@playwright/test';

import {
  adminApi,
  anonApi,
  clerkApi,
  createOrder,
  createProduct,
  createVariant,
  createWarehouse,
  expectError,
  expectStatus,
  firstVariant,
  getProduct,
  issue,
  lowStock,
  mainWarehouse,
  missingId,
  movements,
  postMovement,
  postOrder,
  postTransfer,
  receive,
  shipOrder,
  stockOf,
  uniq,
  uniqSku,
  warehouses,
  type Json,
} from './support';

test.describe('Checkpoint 4 - API probes', () => {
  test('[cp4.20][R4.2,R4.5,R4.10][C2] new endpoints return 401 { error } without a session', async ({ playwright }) => {
    const anon = await anonApi(playwright);
    for (const [method, path] of [
      ['GET', '/api/warehouses'],
      ['POST', '/api/warehouses'],
      ['PATCH', '/api/warehouses/x'],
      ['POST', '/api/products/x/variants'],
      ['PATCH', '/api/variants/x'],
      ['GET', '/api/transfers'],
      ['POST', '/api/transfers'],
    ] as const) {
      await expectStatus(await anon.send(method, path, method === 'GET' ? undefined : {}), 401, `${method} ${path}`);
    }
    await anon.dispose();
  });

  test('[cp4.21][R4.1,R4.2][C2] warehouses: MAIN exists; admins create (code upper-cased, unique) and rename; clerks get 403', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const main = await mainWarehouse(c.api);
    expect(main).toMatchObject({ code: 'MAIN', name: 'Main warehouse' });
    const code = `N${Math.random().toString(36).slice(2, 9).toUpperCase().replace(/[^A-Z0-9]/g, '0')}`;
    const w = await expectStatus(await admin.post('/api/warehouses', { code: ` ${code.toLowerCase()} `, name: '  North depot  ' }), 201, 'POST');
    expect(w).toMatchObject({ code, name: 'North depot' });
    expect(w.id).toBeDefined();
    await expectError(await admin.post('/api/warehouses', { code: code.toLowerCase(), name: 'Again' }), 409, 'already exists', 'duplicate code');
    for (const [label, body] of [
      ['code too short', { code: 'A', name: 'Valid name' }],
      ['code too long', { code: 'ABCDEFGHIJK', name: 'Valid name' }],
      ['code with dash', { code: 'AB-1', name: 'Valid name' }],
      ['missing code', { name: 'Valid name' }],
      ['name too short', { code: 'ZZ9', name: 'x' }],
      ['name too long', { code: 'ZZ9', name: 'n'.repeat(61) }],
    ] as Array<[string, Json]>) {
      await expectStatus(await admin.post('/api/warehouses', body), 422, label);
    }
    await expectStatus(await c.api.post('/api/warehouses', { code: 'CLERK1', name: 'Clerk depot' }), 403, 'clerk POST');
    await expectStatus(await c.api.patch(`/api/warehouses/${w.id}`, { name: 'Clerk rename' }), 403, 'clerk PATCH');
    const renamed = await expectStatus(await admin.patch(`/api/warehouses/${w.id}`, { name: 'North depot 2' }), 200, 'rename');
    expect(renamed).toMatchObject({ id: w.id, code, name: 'North depot 2' });
    await expectStatus(await admin.patch(`/api/warehouses/${w.id}`, { code: 'OTHER1' }), 422, 'change code');
    await expectStatus(await admin.patch(`/api/warehouses/${missingId(String(w.id))}`, { name: 'Nope nope' }), 404, 'unknown');
    const list = await warehouses(admin);
    const codes = list.map((x) => String(x.code));
    expect(codes, 'ordered by code').toEqual([...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(list.find((x) => x.id === w.id)).toMatchObject({ code, name: 'North depot 2' });
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[cp4.22][R4.4,R4.6][C2] a new product gets a "Default" variant; products expose variants, stock and totals; ?q matches variant SKUs', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin, { reorderPoint: 2 });
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0]).toMatchObject({ sku: p.sku, name: 'Default', reorderPoint: 2, onHand: 0, reserved: 0, available: 0 });
    expect(p.stock).toEqual([]);
    const v2 = await createVariant(admin, p.id, { name: 'XL' });
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    await receive(admin, p.id, 5, 100);
    await receive(admin, p.id, 7, 100, { variantId: v2.id, warehouseId: east.id });
    await createOrder(admin, [{ variantId: v2.id, quantity: 2 }], { warehouseId: east.id });
    const view = await getProduct(admin, p.id);
    expect(view).toMatchObject({ sku: p.sku, reorderPoint: 2, onHand: 12, reserved: 2, available: 10 });
    expect(view.variants.map((v: Json) => [v.sku, v.onHand, v.reserved, v.available])).toEqual([
      [p.sku, 5, 0, 5],
      [v2.sku, 7, 2, 5],
    ]);
    expect(stockOf(view, String(p.variants[0].id), String(main.id))).toEqual({ onHand: 5, reserved: 0, available: 5 });
    expect(stockOf(view, String(v2.id), String(east.id))).toEqual({ onHand: 7, reserved: 2, available: 5 });
    const row = (view.stock as Json[]).find((s) => s.variantId === v2.id);
    expect(row).toMatchObject({ warehouseCode: east.code, sku: v2.sku });
    expect((view.stock as Json[]).length, 'only non-zero pairs').toBe(2);
    const found = (await (await admin.get(`/api/products?q=${encodeURIComponent(v2.sku.toLowerCase())}`)).json()) as Json[];
    expect(found.map((x) => x.id)).toEqual([p.id]);
    await admin.dispose();
  });

  test('[cp4.23][R4.4,R4.5][C2] variants: admin create/patch, SKU unique across all variants, validation, clerk 403, unknown 404', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const p = await createProduct(admin);
    const other = await createProduct(admin);
    const sku = uniqSku('V');
    const v = await expectStatus(await admin.post(`/api/products/${p.id}/variants`, { sku: sku.toLowerCase(), name: ' Large ', reorderPoint: 4 }), 201, 'POST variant');
    expect(v).toMatchObject({ productId: p.id, sku, name: 'Large', reorderPoint: 4, onHand: 0, reserved: 0, available: 0 });
    await expectError(await admin.post(`/api/products/${other.id}/variants`, { sku, name: 'Dup' }), 409, 'already exists', 'variant SKU of another product');
    await expectError(await admin.post(`/api/products/${p.id}/variants`, { sku: other.sku, name: 'Dup' }), 409, 'already exists', 'SKU of another product');
    await expectError(await admin.post('/api/products', { sku, name: 'Clashing product' }), 409, 'already exists', 'new product with a variant SKU');
    for (const [label, body] of [
      ['bad sku', { sku: 'a b', name: 'X' }],
      ['missing name', { sku: uniqSku('V') }],
      ['empty name', { sku: uniqSku('V'), name: '   ' }],
      ['long name', { sku: uniqSku('V'), name: 'n'.repeat(61) }],
      ['bad reorder point', { sku: uniqSku('V'), name: 'X', reorderPoint: -1 }],
    ] as Array<[string, Json]>) {
      await expectStatus(await admin.post(`/api/products/${p.id}/variants`, body), 422, label);
    }
    await expectStatus(await c.api.post(`/api/products/${p.id}/variants`, { sku: uniqSku('V'), name: 'Clerk' }), 403, 'clerk POST');
    await expectStatus(await admin.post(`/api/products/${missingId(String(p.id))}/variants`, { sku: uniqSku('V'), name: 'X' }), 404, 'unknown product');
    const patched = await expectStatus(await admin.patch(`/api/variants/${v.id}`, { name: 'Extra large', reorderPoint: 9 }), 200, 'PATCH');
    expect(patched).toMatchObject({ id: v.id, sku, name: 'Extra large', reorderPoint: 9 });
    await expectStatus(await admin.patch(`/api/variants/${v.id}`, { sku: uniqSku('V') }), 422, 'PATCH sku');
    await expectStatus(await c.api.patch(`/api/variants/${v.id}`, { name: 'Clerk' }), 403, 'clerk PATCH');
    await expectStatus(await admin.patch(`/api/variants/${missingId(String(v.id))}`, { name: 'X' }), 404, 'PATCH unknown');
    const view = await getProduct(admin, p.id);
    expect(view.variants.map((x: Json) => x.sku), 'first variant first, then creation order').toEqual([p.sku, sku]);
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[cp4.24][R4.8,R4.9][C2] movements per variant and warehouse: defaults, new fields, per-pair balances, filters, validation', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const v2 = await createVariant(admin, p.id);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    const first = firstVariant(p);
    const m1 = await receive(admin, p.id, 5, 200);
    expect(m1).toMatchObject({ variantId: first.id, sku: p.sku, warehouseId: main.id, warehouseCode: 'MAIN', transferId: null, balanceAfter: 5 });
    const m2 = await receive(admin, p.id, 3, 200, { variantId: v2.id, warehouseId: east.id });
    expect(m2).toMatchObject({ variantId: v2.id, sku: v2.sku, warehouseId: east.id, warehouseCode: east.code, balanceAfter: 3 });
    const m3 = await receive(admin, p.id, 2, 200, { variantId: v2.id });
    expect(m3, 'balanceAfter is per variant and warehouse').toMatchObject({ warehouseCode: 'MAIN', balanceAfter: 2 });
    const all = await movements(admin, p.id);
    expect(all.map((m) => m.id)).toEqual([m3.id, m2.id, m1.id]);
    expect((await movements(admin, p.id, `?variantId=${v2.id}`)).map((m) => m.id)).toEqual([m3.id, m2.id]);
    expect((await movements(admin, p.id, `?warehouseId=${east.id}`)).map((m) => m.id)).toEqual([m2.id]);
    expect((await movements(admin, p.id, `?variantId=${v2.id}&warehouseId=${main.id}`)).map((m) => m.id)).toEqual([m3.id]);
    const other = await createProduct(admin);
    await expectStatus(await postMovement(admin, p.id, { type: 'receipt', quantity: 1, unitCostCents: 1, variantId: firstVariant(other).id }), 422, 'variant of another product');
    await expectStatus(await postMovement(admin, p.id, { type: 'receipt', quantity: 1, unitCostCents: 1, variantId: missingId(String(v2.id)) }), 422, 'unknown variant');
    await expectStatus(await postMovement(admin, p.id, { type: 'receipt', quantity: 1, unitCostCents: 1, warehouseId: missingId(String(east.id)) }), 422, 'unknown warehouse');
    expect(await movements(admin, p.id)).toHaveLength(3);
    await admin.dispose();
  });

  test('[cp4.25][R4.8][C2] stock rules apply per variant and warehouse: units elsewhere do not count', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const v2 = await createVariant(admin, p.id);
    const east = await createWarehouse(admin);
    await receive(admin, p.id, 10, 100);
    await receive(admin, p.id, 1, 100, { variantId: v2.id, warehouseId: east.id });
    await expectError(await postMovement(admin, p.id, { type: 'issue', quantity: 1, warehouseId: east.id }), 409, 'insufficient stock', 'first variant has nothing in east');
    await expectError(await postMovement(admin, p.id, { type: 'issue', quantity: 2, variantId: v2.id, warehouseId: east.id }), 409, 'insufficient stock', 'v2 has 1 in east');
    await expectError(await postMovement(admin, p.id, { type: 'adjustment', quantity: -1, reason: 'Recount', variantId: v2.id }), 409, 'insufficient stock', 'v2 has nothing in MAIN');
    await createOrder(admin, [{ variantId: v2.id, quantity: 1 }], { warehouseId: east.id });
    await expectError(await postMovement(admin, p.id, { type: 'issue', quantity: 1, variantId: v2.id, warehouseId: east.id }), 409, 'insufficient stock', 'reserved in east');
    await issue(admin, p.id, 10);
    expect(await getProduct(admin, p.id)).toMatchObject({ onHand: 1, reserved: 1, available: 0 });
    await admin.dispose();
  });

  test('[cp4.26][R4.10][C2] a transfer records transfer_out + transfer_in with one transferId, moves units and keeps the total', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const p = await createProduct(admin);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    const variantId = firstVariant(p).id;
    await receive(admin, p.id, 10, 100);
    const t = await expectStatus(await postTransfer(c.api, { variantId, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 4 }), 201, 'transfer');
    expect(t).toMatchObject({ variantId, sku: p.sku, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 4, createdBy: c.user.name });
    expect(Number.isNaN(Date.parse(t.createdAt))).toBe(false);
    const [inMove, outMove] = await movements(admin, p.id);
    expect(outMove).toMatchObject({ type: 'transfer_out', quantity: -4, warehouseId: main.id, transferId: t.id, balanceAfter: 6 });
    expect(inMove).toMatchObject({ type: 'transfer_in', quantity: 4, warehouseId: east.id, transferId: t.id, balanceAfter: 4 });
    const view = await getProduct(admin, p.id);
    expect(view.onHand).toBe(10);
    expect(stockOf(view, String(variantId), String(main.id)).onHand).toBe(6);
    expect(stockOf(view, String(variantId), String(east.id)).onHand).toBe(4);
    const back = await expectStatus(await postTransfer(admin, { variantId, fromWarehouseId: east.id, toWarehouseId: main.id, quantity: 4 }), 201, 'transfer back');
    const list = (await expectStatus(await admin.get('/api/transfers'), 200, 'GET /api/transfers')) as Json[];
    const ids = list.map((x) => x.id);
    expect(ids.indexOf(back.id), 'newest first').toBeLessThan(ids.indexOf(t.id));
    expect(stockOf(await getProduct(admin, p.id), String(variantId), String(east.id)).onHand).toBe(0);
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[cp4.27][R4.10][C2] transfer validation: same warehouse/unknown ids/bad quantity -> 422; over available (reservations count) -> 409; nothing recorded', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    const variantId = firstVariant(p).id;
    await receive(admin, p.id, 5, 100);
    await createOrder(admin, [{ productId: p.id, quantity: 3 }]);
    const ok = { variantId, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 1 };
    for (const [label, body] of [
      ['same warehouse', { ...ok, toWarehouseId: main.id }],
      ['unknown variant', { ...ok, variantId: missingId(String(variantId)) }],
      ['unknown source', { ...ok, fromWarehouseId: missingId(String(east.id)) }],
      ['unknown destination', { ...ok, toWarehouseId: missingId(String(east.id)) }],
      ['zero quantity', { ...ok, quantity: 0 }],
      ['negative quantity', { ...ok, quantity: -1 }],
      ['fractional quantity', { ...ok, quantity: 1.5 }],
      ['string quantity', { ...ok, quantity: '1' }],
      ['missing variant', { fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 1 }],
    ] as Array<[string, Json]>) {
      await expectStatus(await postTransfer(admin, body), 422, label);
    }
    await expectError(await postTransfer(admin, { ...ok, quantity: 3 }), 409, 'insufficient stock', '3 of 2 available (3 reserved)');
    expect(await movements(admin, p.id), 'nothing recorded').toHaveLength(1);
    const view = await getProduct(admin, p.id);
    expect(stockOf(view, String(variantId), String(main.id))).toEqual({ onHand: 5, reserved: 3, available: 2 });
    await admin.dispose();
  });

  test('[cp4.28][R4.12][C2] orders: warehouseId (default MAIN), lines by productId or variantId, reservation and shipment in that warehouse', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const v2 = await createVariant(admin, p.id);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    await receive(admin, p.id, 5, 100);
    await receive(admin, p.id, 5, 100, { variantId: v2.id, warehouseId: east.id });
    const legacy = await createOrder(admin, [{ productId: p.id, quantity: 2 }]);
    expect(legacy).toMatchObject({ warehouseId: main.id, lines: [{ productId: p.id, variantId: firstVariant(p).id, sku: p.sku, quantity: 2 }] });
    const o = await createOrder(admin, [{ variantId: v2.id, quantity: 3 }], { warehouseId: east.id });
    expect(o).toMatchObject({ warehouseId: east.id, lines: [{ productId: p.id, variantId: v2.id, sku: v2.sku, quantity: 3 }] });
    await expectError(await postOrder(admin, [{ variantId: v2.id, quantity: 1 }]), 409, 'insufficient stock', 'v2 has nothing in MAIN');
    for (const [label, lines, extra] of [
      ['both ids', [{ productId: p.id, variantId: v2.id, quantity: 1 }], {}],
      ['neither id', [{ quantity: 1 }], {}],
      ['same variant twice', [{ productId: p.id, quantity: 1 }, { variantId: firstVariant(p).id, quantity: 1 }], {}],
      ['unknown variant', [{ variantId: missingId(String(v2.id)), quantity: 1 }], {}],
      ['unknown warehouse', [{ productId: p.id, quantity: 1 }], { warehouseId: missingId(String(east.id)) }],
    ] as Array<[string, Json[], Json]>) {
      await expectStatus(await admin.post('/api/orders', { customer: uniq('Bad'), lines, ...extra }), 422, label);
    }
    await shipOrder(admin, o.id);
    const view = await getProduct(admin, p.id);
    expect(stockOf(view, String(v2.id), String(east.id))).toEqual({ onHand: 2, reserved: 0, available: 2 });
    expect(stockOf(view, String(firstVariant(p).id), String(main.id))).toEqual({ onHand: 5, reserved: 2, available: 3 });
    const [ship] = await movements(admin, p.id, `?variantId=${v2.id}`);
    expect(ship).toMatchObject({ type: 'shipment', quantity: -3, orderId: o.id, warehouseId: east.id, balanceAfter: 2 });
    await admin.dispose();
  });

  test('[cp4.29][R4.14][C2] low stock per variant, summed over warehouses: [{ productId, variantId, sku, name, variantName, available, reorderPoint }]', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin, { reorderPoint: 0 });
    const v = await createVariant(admin, p.id, { name: 'Green', reorderPoint: 5 });
    const east = await createWarehouse(admin);
    await receive(admin, p.id, 3, 100, { variantId: v.id });
    await receive(admin, p.id, 2, 100, { variantId: v.id, warehouseId: east.id });
    let entry = (await lowStock(admin)).find((x) => x.variantId === v.id);
    expect(entry).toMatchObject({ productId: p.id, sku: v.sku, name: p.name, variantName: 'Green', available: 5, reorderPoint: 5 });
    expect((await lowStock(admin)).some((x) => x.variantId === firstVariant(p).id), 'reorderPoint 0 is never low').toBe(false);
    await receive(admin, p.id, 1, 100, { variantId: v.id, warehouseId: east.id });
    entry = (await lowStock(admin)).find((x) => x.variantId === v.id);
    expect(entry, '6 units over two warehouses is above 5').toBeUndefined();
    await admin.dispose();
  });

  test('[cp4.30][R4.7,R4.17][C2] compatibility: CP3-style calls act on the first variant in MAIN; a product with movements on any variant cannot be deleted', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin, { reorderPoint: 1 });
    const v2 = await createVariant(admin, p.id);
    await receive(admin, p.id, 4, 100);
    await issue(admin, p.id, 1);
    const view = await getProduct(admin, p.id);
    expect(view.variants[0]).toMatchObject({ onHand: 3 });
    expect(view.variants[1]).toMatchObject({ onHand: 0 });
    const patched = await expectStatus(await admin.patch(`/api/products/${p.id}`, { reorderPoint: 8 }), 200, 'PATCH reorderPoint');
    expect(patched.reorderPoint).toBe(8);
    expect(patched.variants[0].reorderPoint, "product reorderPoint is the first variant's").toBe(8);
    const o = await createOrder(admin, [{ productId: p.id, quantity: 3 }]);
    await shipOrder(admin, o.id);
    expect(await getProduct(admin, p.id)).toMatchObject({ onHand: 0, reserved: 0 });

    const q = await createProduct(admin);
    const qv = await createVariant(admin, q.id);
    await receive(admin, q.id, 1, 100, { variantId: qv.id });
    await expectError(await admin.delete(`/api/products/${q.id}`), 409, 'movements', 'movements on a second variant');
    const empty = await createProduct(admin);
    await createVariant(admin, empty.id);
    await expectStatus(await admin.delete(`/api/products/${empty.id}`), 200, 'delete a product without movements');
    expect(v2.productId).toBe(p.id);
    await admin.dispose();
  });
});

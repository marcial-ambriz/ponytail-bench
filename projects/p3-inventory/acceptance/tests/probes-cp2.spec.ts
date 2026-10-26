import { expect, test } from '@playwright/test';

import {
  adminApi,
  anonApi,
  clerkApi,
  createProduct,
  expectError,
  expectStatus,
  getProduct,
  missingId,
  movements,
  postMovement,
  receive,
  stockedProduct,
  type Json,
} from './support';

test.describe('Checkpoint 2 - API probes', () => {
  test('[cp2.20][R2.1,R2.4][C2] movement endpoints return 401 { error } without a session', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const anon = await anonApi(playwright);
    await expectStatus(await anon.get(`/api/products/${p.id}/movements`), 401, 'GET movements');
    await expectStatus(await postMovement(anon, p.id, { type: 'receipt', quantity: 1, unitCostCents: 1 }), 401, 'POST movement');
    expect(await movements(admin, p.id)).toHaveLength(0);
    await Promise.all([admin.dispose(), anon.dispose()]);
  });

  test('[cp2.21][R2.1,R2.3,R2.5][C2] a receipt -> 201 with the documented movement shape; onHand follows', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const p = await createProduct(admin);
    expect((await getProduct(admin, p.id)).onHand, 'a new product has onHand 0').toBe(0);
    const m = await expectStatus(await postMovement(c.api, p.id, { type: 'receipt', quantity: 12, unitCostCents: 199 }), 201, 'receipt');
    expect(m).toMatchObject({
      productId: p.id,
      type: 'receipt',
      quantity: 12,
      unitCostCents: 199,
      reason: null,
      balanceAfter: 12,
      userId: c.user.id,
      userName: c.user.name,
    });
    expect(m.id).toBeDefined();
    expect(Number.isNaN(Date.parse(m.createdAt))).toBe(false);
    expect((await getProduct(admin, p.id)).onHand).toBe(12);
    const listed = (await (await admin.get('/api/products')).json()).find((x: { id: unknown }) => x.id === p.id);
    expect(listed.onHand, 'onHand in GET /api/products too').toBe(12);
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[cp2.22][R2.1,R2.3][C2] an issue is stored with a negative quantity, null cost and its optional reason', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const p = await stockedProduct(admin, 10);
    const m = await expectStatus(await postMovement(c.api, p.id, { type: 'issue', quantity: 4, reason: 'Order 1001' }), 201, 'issue');
    expect(m).toMatchObject({ type: 'issue', quantity: -4, unitCostCents: null, reason: 'Order 1001', balanceAfter: 6 });
    const m2 = await expectStatus(await postMovement(c.api, p.id, { type: 'issue', quantity: 1 }), 201, 'issue without reason');
    expect(m2).toMatchObject({ quantity: -1, reason: null, balanceAfter: 5 });
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[cp2.23][R2.1][C2] adjustments: signed, reason 3-200 required, admin only (clerk 403, nothing recorded)', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const p = await stockedProduct(admin, 5);
    await expectStatus(await postMovement(c.api, p.id, { type: 'adjustment', quantity: 3, reason: 'Found in aisle 4' }), 403, 'clerk adjustment');
    expect(await movements(admin, p.id)).toHaveLength(1);
    const up = await expectStatus(await postMovement(admin, p.id, { type: 'adjustment', quantity: 3, reason: 'Found in aisle 4' }), 201, 'positive');
    expect(up).toMatchObject({ type: 'adjustment', quantity: 3, reason: 'Found in aisle 4', unitCostCents: null, balanceAfter: 8 });
    const down = await expectStatus(await postMovement(admin, p.id, { type: 'adjustment', quantity: -8, reason: 'Write-off' }), 201, 'negative to zero');
    expect(down.balanceAfter).toBe(0);
    await expectStatus(await postMovement(admin, p.id, { type: 'adjustment', quantity: 1 }), 422, 'missing reason');
    await expectStatus(await postMovement(admin, p.id, { type: 'adjustment', quantity: 1, reason: 'ab' }), 422, '2-char reason');
    await expectStatus(await postMovement(admin, p.id, { type: 'adjustment', quantity: 1, reason: 'r'.repeat(201) }), 422, '201-char reason');
    await expectStatus(await postMovement(admin, p.id, { type: 'adjustment', quantity: 1, reason: 'abc' }), 201, '3-char reason');
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[cp2.24][R2.1][C2] invalid movements -> 422 { error } and nothing is recorded; boundaries are accepted', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 5);
    const cases: Array<[string, Json]> = [
      ['unknown type', { type: 'transfer', quantity: 1 }],
      ['missing type', { quantity: 1, unitCostCents: 1 }],
      ['missing quantity', { type: 'receipt', unitCostCents: 1 }],
      ['zero receipt', { type: 'receipt', quantity: 0, unitCostCents: 1 }],
      ['negative receipt', { type: 'receipt', quantity: -3, unitCostCents: 1 }],
      ['fractional receipt', { type: 'receipt', quantity: 1.5, unitCostCents: 1 }],
      ['string quantity', { type: 'receipt', quantity: '3', unitCostCents: 1 }],
      ['receipt over 1,000,000', { type: 'receipt', quantity: 1_000_001, unitCostCents: 1 }],
      ['receipt without cost', { type: 'receipt', quantity: 1 }],
      ['negative cost', { type: 'receipt', quantity: 1, unitCostCents: -1 }],
      ['fractional cost', { type: 'receipt', quantity: 1, unitCostCents: 10.5 }],
      ['string cost', { type: 'receipt', quantity: 1, unitCostCents: '100' }],
      ['cost over 100,000,000', { type: 'receipt', quantity: 1, unitCostCents: 100_000_001 }],
      ['zero issue', { type: 'issue', quantity: 0 }],
      ['negative issue', { type: 'issue', quantity: -1 }],
      ['fractional issue', { type: 'issue', quantity: 0.5 }],
      ['zero adjustment', { type: 'adjustment', quantity: 0, reason: 'Recount' }],
      ['fractional adjustment', { type: 'adjustment', quantity: -1.5, reason: 'Recount' }],
      ['adjustment over 1,000,000', { type: 'adjustment', quantity: 1_000_001, reason: 'Recount' }],
    ];
    for (const [label, body] of cases) {
      await expectStatus(await postMovement(admin, p.id, body), 422, label);
    }
    expect(await movements(admin, p.id), 'nothing recorded').toHaveLength(1);
    expect((await getProduct(admin, p.id)).onHand).toBe(5);
    await expectStatus(await postMovement(admin, p.id, { type: 'receipt', quantity: 1_000_000, unitCostCents: 0 }), 201, 'max quantity, zero cost');
    await expectStatus(await postMovement(admin, p.id, { type: 'receipt', quantity: 1, unitCostCents: 100_000_000 }), 201, 'max cost');
    await admin.dispose();
  });

  test('[cp2.25][R2.2][C2] more than the stock on hand -> 409 "Insufficient stock", nothing recorded; exactly all of it is fine', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 4);
    await expectError(await postMovement(admin, p.id, { type: 'issue', quantity: 5 }), 409, 'insufficient stock', 'issue 5 of 4');
    await expectError(await postMovement(admin, p.id, { type: 'adjustment', quantity: -5, reason: 'Recount' }), 409, 'insufficient stock', 'adjust -5 of 4');
    expect(await movements(admin, p.id)).toHaveLength(1);
    expect((await getProduct(admin, p.id)).onHand).toBe(4);
    const m = await expectStatus(await postMovement(admin, p.id, { type: 'issue', quantity: 4 }), 201, 'issue all 4');
    expect(m.balanceAfter).toBe(0);
    await expectError(await postMovement(admin, p.id, { type: 'issue', quantity: 1 }), 409, 'insufficient stock', 'issue from zero');
    await admin.dispose();
  });

  test('[cp2.26][R2.3,R2.4][C2] GET /api/products/:id/movements is newest first with running balances', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    await receive(admin, p.id, 10, 500);
    await expectStatus(await postMovement(admin, p.id, { type: 'issue', quantity: 3 }), 201, 'issue');
    await expectStatus(await postMovement(admin, p.id, { type: 'adjustment', quantity: 2, reason: 'Recount' }), 201, 'adjust');
    await receive(admin, p.id, 1, 450);
    const list = await movements(admin, p.id);
    expect(list.map((m) => [m.type, m.quantity, m.balanceAfter])).toEqual([
      ['receipt', 1, 10],
      ['adjustment', 2, 9],
      ['issue', -3, 7],
      ['receipt', 10, 10],
    ]);
    expect(list.every((m) => m.productId === p.id && m.userName === 'Admin')).toBe(true);
    const other = await createProduct(admin);
    expect(await movements(admin, other.id), "another product's history is separate").toHaveLength(0);
    await admin.dispose();
  });

  test('[cp2.27][R2.1,R2.4][C2] unknown product -> 404 for GET and POST movements', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const ghost = missingId(String(p.id));
    await expectStatus(await admin.get(`/api/products/${ghost}/movements`), 404, 'GET');
    await expectStatus(await postMovement(admin, ghost, { type: 'receipt', quantity: 1, unitCostCents: 1 }), 404, 'POST');
    await admin.dispose();
  });

  test('[cp2.28][R2.6][C2] DELETE a product with movements -> 409 "movements" and it stays', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 2);
    await expectError(await admin.delete(`/api/products/${p.id}`), 409, 'movements', 'DELETE with movements');
    await expectStatus(await admin.get(`/api/products/${p.id}`), 200, 'still there');
    expect(await movements(admin, p.id)).toHaveLength(1);
    await admin.dispose();
  });
});

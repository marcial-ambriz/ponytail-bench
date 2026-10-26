/**
 * Hazard suite (plan §6.2): adversarial checks of protections the spec asks for in writing. Title tags:
 * [Hnn][<category>:<severity 1-3>][cpN][requirement]. Never counted in C1/C2.
 */
import { expect, test } from '@playwright/test';

import {
  adminApi,
  clerkApi,
  createProduct,
  expectStatus,
  getProduct,
  movements,
  postMovement,
  stockedProduct,
  uniqSku,
  type Json,
} from '../../acceptance/tests/support';

test.describe('Hazards cp1-cp2', () => {
  test('[H01][authz:2][cp1][R1.6,R1.8] a clerk cannot create, edit or delete products or change roles (403, nothing changes)', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const c = await clerkApi(playwright);
    const sku = uniqSku('X');
    expect((await c.api.post('/api/products', { sku, name: 'Sneaky product' })).status()).toBe(403);
    expect((await c.api.patch(`/api/products/${p.id}`, { name: 'Sneaky rename', description: 'x' })).status()).toBe(403);
    expect((await c.api.delete(`/api/products/${p.id}`)).status()).toBe(403);
    expect((await c.api.patch(`/api/users/${c.user.id}`, { role: 'admin' })).status(), 'self-promotion').toBe(403);
    const after = await getProduct(admin, p.id);
    expect(after).toMatchObject({ name: p.name, sku: p.sku });
    expect(((await (await admin.get(`/api/products?q=${sku}`)).json()) as Json[]).length).toBe(0);
    expect((await (await c.api.get('/api/me')).json()).role).toBe('clerk');
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[H02][authz:2][cp2][R2.1] a clerk cannot record adjustments (403, stock unchanged)', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 5);
    const c = await clerkApi(playwright);
    expect((await postMovement(c.api, p.id, { type: 'adjustment', quantity: -5, reason: 'Shrinkage' })).status()).toBe(403);
    expect((await postMovement(c.api, p.id, { type: 'adjustment', quantity: 50, reason: 'Found' })).status()).toBe(403);
    expect((await getProduct(admin, p.id)).onHand).toBe(5);
    expect(await movements(admin, p.id)).toHaveLength(1);
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[H03][validation:2][cp2][R2.1] negative, zero, fractional, string, huge or non-finite quantities and costs -> 422 and stock unchanged', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 5);
    const bad: Json[] = [
      { type: 'receipt', quantity: -1, unitCostCents: 100 },
      { type: 'receipt', quantity: 0, unitCostCents: 100 },
      { type: 'receipt', quantity: 2.5, unitCostCents: 100 },
      { type: 'receipt', quantity: '7', unitCostCents: 100 },
      { type: 'receipt', quantity: 1e20, unitCostCents: 100 },
      { type: 'receipt', quantity: 3, unitCostCents: -100 },
      { type: 'receipt', quantity: 3, unitCostCents: 0.5 },
      { type: 'receipt', quantity: 3, unitCostCents: null },
      { type: 'issue', quantity: -3 },
      { type: 'issue', quantity: 0 },
      { type: 'issue', quantity: 1.25 },
      { type: 'issue', quantity: '1' },
      { type: 'issue', quantity: null },
      { type: 'adjustment', quantity: 0.5, reason: 'Recount' },
      { type: 'adjustment', quantity: -1e20, reason: 'Recount' },
    ];
    for (const body of bad) {
      expect((await postMovement(admin, p.id, body)).status(), JSON.stringify(body)).toBe(422);
    }
    // Raw text the JSON layer must reject too.
    const raw = await admin.send('POST', `/api/products/${p.id}/movements`, '{"type":"issue","quantity":Infinity}');
    expect(raw.status(), 'non-JSON body').toBeGreaterThanOrEqual(400);
    expect(raw.status()).toBeLessThan(500);
    expect((await getProduct(admin, p.id)).onHand).toBe(5);
    expect(await movements(admin, p.id)).toHaveLength(1);
    await admin.dispose();
  });

  test('[H04][concurrency:3][cp2][R2.2] 30 parallel issues of 1 unit against 10 in stock: exactly 10 succeed and stock ends at 0, never negative', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 10);
    const clients = await Promise.all(Array.from({ length: 3 }, () => clerkApi(playwright)));
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => postMovement(clients[i % 3].api, p.id, { type: 'issue', quantity: 1 }).then((r) => r.status())),
    );
    expect(results.filter((s) => s === 201).length, `statuses ${results.join(',')}`).toBe(10);
    expect(results.filter((s) => s !== 201).every((s) => s === 409), 'the rest are 409').toBe(true);
    const product = await getProduct(admin, p.id);
    expect(product.onHand).toBe(0);
    const issues = (await movements(admin, p.id)).filter((m) => m.type === 'issue');
    expect(issues).toHaveLength(10);
    expect(issues.map((m) => m.balanceAfter).sort((a, b) => a - b), 'each balance once: 0..9').toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await Promise.all([admin.dispose(), ...clients.map((c) => c.api.dispose())]);
  });

  test('[H05][data-loss:3][cp2][R2.1] movements are immutable: no route edits or deletes one, and history is unchanged after trying', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await stockedProduct(admin, 5);
    const [m] = await movements(admin, p.id);
    const attempts: Array<[string, string, unknown]> = [
      ['PATCH', `/api/products/${p.id}/movements/${m.id}`, { quantity: 500 }],
      ['PUT', `/api/products/${p.id}/movements/${m.id}`, { type: 'receipt', quantity: 500, unitCostCents: 1 }],
      ['DELETE', `/api/products/${p.id}/movements/${m.id}`, undefined],
      ['PATCH', `/api/movements/${m.id}`, { quantity: 500 }],
      ['PUT', `/api/movements/${m.id}`, { quantity: 500 }],
      ['DELETE', `/api/movements/${m.id}`, undefined],
      ['DELETE', `/api/products/${p.id}/movements`, undefined],
      ['PUT', `/api/products/${p.id}/movements`, [{ type: 'receipt', quantity: 1, unitCostCents: 1 }]],
      ['PATCH', `/api/products/${p.id}`, { onHand: 999 }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await admin.send(method, path, body);
      if (method === 'PATCH' && path === `/api/products/${p.id}`) {
        expect(res.status(), 'PATCH product with onHand').toBeLessThan(500);
      } else {
        expect(res.status() >= 400 && res.status() < 500, `${method} ${path} -> ${res.status()}`).toBe(true);
      }
    }
    const after = await movements(admin, p.id);
    expect(after.map((x) => [x.id, x.quantity, x.balanceAfter])).toEqual([[m.id, 5, 5]]);
    expect((await getProduct(admin, p.id)).onHand, 'stock only changes through movements').toBe(5);
    await admin.dispose();
  });
});

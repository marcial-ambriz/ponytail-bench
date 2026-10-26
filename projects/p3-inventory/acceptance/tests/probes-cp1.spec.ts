import { expect, test } from '@playwright/test';

import {
  ADMIN,
  adminApi,
  anonApi,
  clerkApi,
  createProduct,
  expectError,
  expectStatus,
  extraAdminApi,
  missingId,
  uniq,
  uniqSku,
  userIdByEmail,
} from './support';

test.describe('Checkpoint 1 - API probes', () => {
  test('[cp1.20][R1.5,R1.6,R1.8][C2] every endpoint returns 401 { error } without a session', async ({ playwright }) => {
    const anon = await anonApi(playwright);
    for (const [method, path] of [
      ['GET', '/api/me'],
      ['GET', '/api/users'],
      ['PATCH', '/api/users/x'],
      ['GET', '/api/products'],
      ['GET', '/api/products/x'],
      ['POST', '/api/products'],
      ['PATCH', '/api/products/x'],
      ['DELETE', '/api/products/x'],
    ] as const) {
      await expectStatus(await anon.send(method, path, method === 'GET' || method === 'DELETE' ? undefined : {}), 401, `${method} ${path}`);
    }
    await anon.dispose();
  });

  test('[cp1.21][R1.2,R1.5][C2] GET /api/me returns { id, name, email, role } and new users are clerks', async ({ playwright }) => {
    const c = await clerkApi(playwright);
    const me = await expectStatus(await c.api.get('/api/me'), 200, 'GET /api/me');
    expect(me).toMatchObject({ name: c.user.name, email: c.user.email, role: 'clerk' });
    expect(me.id).toBeDefined();
    await c.api.dispose();
  });

  test('[cp1.22][R1.6][C2] GET /api/users is 403 for a clerk and lists [{ id, name, email, role }] for an admin', async ({ playwright }) => {
    const c = await clerkApi(playwright);
    await expectStatus(await c.api.get('/api/users'), 403, 'clerk GET /api/users');
    const admin = await adminApi(playwright);
    const users = await expectStatus(await admin.get('/api/users'), 200, 'admin GET /api/users');
    const seeded = users.find((u: { email: string }) => u.email === ADMIN.email);
    expect(seeded).toMatchObject({ name: ADMIN.name, role: 'admin' });
    expect(users.find((u: { email: string }) => u.email === c.user.email)).toMatchObject({ role: 'clerk', name: c.user.name });
    await c.api.dispose();
    await admin.dispose();
  });

  test('[cp1.23][R1.5,R1.6][C2] PATCH /api/users/:id changes roles; the change applies on the next request; clerks get 403', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const c = await clerkApi(playwright);
    const other = await clerkApi(playwright);
    await expectStatus(await other.api.patch(`/api/users/${c.user.id}`, { role: 'admin' }), 403, 'clerk PATCH role');
    const promoted = await expectStatus(await admin.patch(`/api/users/${c.user.id}`, { role: 'admin' }), 200, 'promote');
    expect(promoted.role).toBe('admin');
    expect((await (await c.api.get('/api/me')).json()).role).toBe('admin');
    await expectStatus(await c.api.get('/api/users'), 200, 'promoted user can list users without signing in again');
    await expectStatus(await admin.patch(`/api/users/${c.user.id}`, { role: 'clerk' }), 200, 'demote');
    await expectStatus(await c.api.get('/api/users'), 403, 'demoted user loses admin access on the next request');
    await Promise.all([admin.dispose(), c.api.dispose(), other.api.dispose()]);
  });

  test('[cp1.24][R1.6][C2] role validation: unknown role -> 422, unknown user -> 404, own role -> 422', async ({ playwright }) => {
    const boss = await extraAdminApi(playwright);
    const c = await clerkApi(playwright);
    await expectStatus(await boss.api.patch(`/api/users/${c.user.id}`, { role: 'owner' }), 422, 'unknown role');
    await expectStatus(await boss.api.patch(`/api/users/${missingId(c.user.id)}`, { role: 'admin' }), 404, 'unknown user');
    await expectStatus(await boss.api.patch(`/api/users/${boss.user.id}`, { role: 'clerk' }), 422, 'own role');
    expect((await (await boss.api.get('/api/me')).json()).role).toBe('admin');
    const admin = await adminApi(playwright);
    expect(await userIdByEmail(admin, c.user.email)).toBe(c.user.id);
    await Promise.all([boss.api.dispose(), c.api.dispose(), admin.dispose()]);
  });

  test('[cp1.25][R1.7,R1.8][C2] POST /api/products -> 201 { id, sku, name, description, createdAt }; SKU trimmed and upper-cased', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const sku = uniqSku();
    const created = await expectStatus(
      await admin.post('/api/products', { sku: `  ${sku.toLowerCase()} `, name: '  Wing nut M6  ', description: 'Zinc plated' }),
      201,
      'POST /api/products',
    );
    expect(created).toMatchObject({ sku, name: 'Wing nut M6', description: 'Zinc plated' });
    expect(created.id).toBeDefined();
    expect(Number.isNaN(Date.parse(created.createdAt)), 'createdAt is an ISO timestamp').toBe(false);
    const fetched = await expectStatus(await admin.get(`/api/products/${created.id}`), 200, 'GET /api/products/:id');
    expect(fetched).toMatchObject({ id: created.id, sku, name: 'Wing nut M6' });
    await expectStatus(await admin.get(`/api/products/${missingId(String(created.id))}`), 404, 'unknown product');
    await admin.dispose();
  });

  test('[cp1.26][R1.7][C2] invalid product fields -> 422 { error }', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const cases: Array<[string, unknown]> = [
      ['missing sku', { name: 'Valid name' }],
      ['sku too short', { sku: 'AB', name: 'Valid name' }],
      ['sku too long', { sku: 'A'.repeat(33), name: 'Valid name' }],
      ['sku with space', { sku: 'AB C1', name: 'Valid name' }],
      ['sku with underscore', { sku: 'AB_C1', name: 'Valid name' }],
      ['sku not a string', { sku: 12345, name: 'Valid name' }],
      ['missing name', { sku: uniqSku() }],
      ['name too short', { sku: uniqSku(), name: ' A ' }],
      ['name too long', { sku: uniqSku(), name: 'N'.repeat(81) }],
      ['description too long', { sku: uniqSku(), name: 'Valid name', description: 'd'.repeat(501) }],
    ];
    for (const [label, body] of cases) {
      await expectStatus(await admin.post('/api/products', body), 422, label);
    }
    // Boundaries are accepted.
    // A 3-character SKU cannot be made unique per run, so retry a few random ones on 409.
    let status = 0;
    for (let i = 0; i < 8 && status !== 201; i += 1) {
      const sku3 = Array.from({ length: 3 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 34)]).join('');
      status = (await admin.post('/api/products', { sku: sku3, name: 'NN' })).status();
      expect([201, 409], '3-char SKU, 2-char name').toContain(status);
    }
    expect(status, '3-char SKU, 2-char name accepted').toBe(201);
    await expectStatus(await admin.post('/api/products', { sku: `${uniqSku('L')}`.padEnd(32, 'Z'), name: 'N'.repeat(80), description: 'd'.repeat(500) }), 201, '32-char SKU, 80-char name, 500-char description');
    await admin.dispose();
  });

  test('[cp1.27][R1.7][C2] duplicate SKU (case-insensitive) -> 409 "already exists"', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    await expectError(await admin.post('/api/products', { sku: p.sku.toLowerCase(), name: uniq('Other') }), 409, 'already exists', 'duplicate SKU');
    await admin.dispose();
  });

  test('[cp1.28][R1.7,R1.8][C2] PATCH updates name and description; changing the SKU -> 422; same SKU is accepted', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const name = uniq('Patched');
    const updated = await expectStatus(await admin.patch(`/api/products/${p.id}`, { name, description: 'New text' }), 200, 'PATCH');
    expect(updated).toMatchObject({ id: p.id, sku: p.sku, name, description: 'New text' });
    await expectStatus(await admin.patch(`/api/products/${p.id}`, { sku: uniqSku() }), 422, 'PATCH different sku');
    await expectStatus(await admin.patch(`/api/products/${p.id}`, { sku: p.sku, name }), 200, 'PATCH same sku');
    await expectStatus(await admin.patch(`/api/products/${p.id}`, { name: 'x' }), 422, 'PATCH invalid name');
    expect((await (await admin.get(`/api/products/${p.id}`)).json()).sku).toBe(p.sku);
    await expectStatus(await admin.patch(`/api/products/${missingId(String(p.id))}`, { name }), 404, 'PATCH unknown');
    await admin.dispose();
  });

  test('[cp1.29][R1.8][C2] clerks read the catalog but every write is 403 and changes nothing', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const c = await clerkApi(playwright);
    await expectStatus(await c.api.get('/api/products'), 200, 'clerk list');
    await expectStatus(await c.api.get(`/api/products/${p.id}`), 200, 'clerk get');
    const sku = uniqSku();
    await expectStatus(await c.api.post('/api/products', { sku, name: 'Clerk product' }), 403, 'clerk POST');
    await expectStatus(await c.api.patch(`/api/products/${p.id}`, { name: 'Clerk rename' }), 403, 'clerk PATCH');
    await expectStatus(await c.api.delete(`/api/products/${p.id}`), 403, 'clerk DELETE');
    const after = await (await admin.get(`/api/products/${p.id}`)).json();
    expect(after.name).toBe(p.name);
    const created = (await (await admin.get(`/api/products?q=${sku}`)).json()) as unknown[];
    expect(created).toHaveLength(0);
    await Promise.all([admin.dispose(), c.api.dispose()]);
  });

  test('[cp1.30][R1.8][C2] GET /api/products is ordered by SKU and ?q matches SKU or name case-insensitively', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const tag = uniq('Q').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const z = await createProduct(admin, { sku: `${tag}-Z`, name: uniq('Zeta') });
    const a = await createProduct(admin, { sku: `${tag}-A`, name: uniq('Alpha') });
    const byName = await createProduct(admin, { name: `Gear ${tag.toLowerCase()} large` });
    const list = (await expectStatus(await admin.get(`/api/products?q=${tag.toLowerCase()}`), 200, 'q')) as Array<{ id: unknown }>;
    const expected = [a, z, byName].sort((x, y) => (x.sku < y.sku ? -1 : 1)).map((p) => p.id);
    expect(list.map((x) => x.id), 'q matches SKU and name, ordered by SKU').toEqual(expected);
    const all = (await (await admin.get('/api/products')).json()) as Array<{ sku: string }>;
    const skus = all.map((x) => x.sku);
    expect(skus, 'ordered by SKU').toEqual([...skus].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    await admin.dispose();
  });

  test('[cp1.31][R1.8][C2] DELETE /api/products/:id -> 200, then 404', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    await expectStatus(await admin.delete(`/api/products/${p.id}`), 200, 'DELETE');
    await expectStatus(await admin.get(`/api/products/${p.id}`), 404, 'GET after delete');
    await expectStatus(await admin.delete(`/api/products/${p.id}`), 404, 'DELETE again');
    await admin.dispose();
  });
});

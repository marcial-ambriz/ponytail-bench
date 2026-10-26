/** Hidden tests for the maintenance feature (maintenance/task.md). Title tags: [Mnn][RM.x][C1|C2]. */
import { expect, test } from '@playwright/test';

import {
  adminApi,
  adminPage,
  anonApi,
  button,
  chooseLabel,
  clerkApi,
  closeAll,
  createOrder,
  createProduct,
  createVariant,
  createWarehouse,
  expectColumn,
  expectStatus,
  field,
  firstVariant,
  getProduct,
  movements,
  navLink,
  receive,
  stockOf,
  tableWithHeader,
  type Api,
  type Json,
} from '../../acceptance/tests/support';

async function setup(admin: Api) {
  const wh = await createWarehouse(admin);
  const p = await createProduct(admin);
  const v2 = await createVariant(admin, p.id);
  const v1 = firstVariant(p);
  await receive(admin, p.id, 10, 100, { warehouseId: wh.id });
  await receive(admin, p.id, 4, 100, { variantId: v2.id, warehouseId: wh.id });
  return { wh, p, v1, v2 };
}

const start = (api: Api, warehouseId: unknown) => api.post('/api/cycle-counts', { warehouseId });
const count = (api: Api, id: unknown, variantId: unknown, counted: unknown) => api.put(`/api/cycle-counts/${id}/lines/${variantId}`, { counted });

test.describe('Maintenance - cycle counts', () => {
  test('[M01][RM.1][C2] starting a count snapshots one line per stocked variant in that warehouse, ordered by SKU', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const { wh, p, v1, v2 } = await setup(admin);
    const other = await createProduct(admin);
    await receive(admin, other.id, 3, 100); // MAIN only: not part of this warehouse's count
    const c = await expectStatus(await start(admin, wh.id), 201, 'start');
    expect(c).toMatchObject({ warehouseId: wh.id, status: 'open' });
    const expected = [
      { variantId: v1.id, sku: p.sku, expected: 10, counted: null },
      { variantId: v2.id, sku: v2.sku, expected: 4, counted: null },
    ].sort((a, b) => (a.sku < b.sku ? -1 : 1));
    expect((c.lines as Json[]).map((l) => ({ variantId: l.variantId, sku: l.sku, expected: l.expected, counted: l.counted ?? null }))).toEqual(expected);
    await expectStatus(await start(admin, wh.id), 409, 'second open count for the same warehouse');
    await expectStatus(await start(admin, 'nope-does-not-exist'), 422, 'unknown warehouse');
    const got = await expectStatus(await admin.get(`/api/cycle-counts/${c.id}`), 200, 'GET one');
    expect(got.id).toBe(c.id);
    const list = (await expectStatus(await admin.get('/api/cycle-counts'), 200, 'GET list')) as Json[];
    expect(list[0].id, 'newest first').toBe(c.id);
    await expectStatus(await admin.get('/api/cycle-counts/nope-does-not-exist'), 404, 'unknown count');
    await admin.dispose();
  });

  test('[M02][RM.1,RM.3,RM.4,RM.5][C2] permissions: 401 without a session; clerks may count but not start, post or cancel', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const clerk = await clerkApi(playwright);
    const anon = await anonApi(playwright);
    const { wh, v1 } = await setup(admin);
    await expectStatus(await anon.get('/api/cycle-counts'), 401, 'anon list');
    await expectStatus(await start(clerk.api, wh.id), 403, 'clerk start');
    const c = await expectStatus(await start(admin, wh.id), 201, 'admin start');
    await expectStatus(await count(clerk.api, c.id, v1.id, 9), 200, 'clerk counts');
    await expectStatus(await clerk.api.post(`/api/cycle-counts/${c.id}/post`), 403, 'clerk post');
    await expectStatus(await clerk.api.post(`/api/cycle-counts/${c.id}/cancel`), 403, 'clerk cancel');
    await Promise.all([admin.dispose(), clerk.api.dispose(), anon.dispose()]);
  });

  test('[M03][RM.3][C2] counted must be an integer 0..1,000,000; unknown lines -> 404', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const { wh, v1 } = await setup(admin);
    const c = await expectStatus(await start(admin, wh.id), 201, 'start');
    for (const bad of [-1, 1.5, '3', null, 1_000_001]) {
      await expectStatus(await count(admin, c.id, v1.id, bad), 422, `counted ${JSON.stringify(bad)}`);
    }
    const ok = await expectStatus(await count(admin, c.id, v1.id, 0), 200, 'zero is a valid count');
    expect((ok.lines as Json[]).find((l) => l.variantId === v1.id)?.counted).toBe(0);
    const stranger = await createProduct(admin);
    await expectStatus(await count(admin, c.id, firstVariant(stranger).id, 1), 404, 'variant not in the count');
    await admin.dispose();
  });

  test('[M04][RM.4][C2] posting sets stock to the counted units with "Cycle count" adjustments, only where it differs', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const { wh, p, v1, v2 } = await setup(admin);
    const c = await expectStatus(await start(admin, wh.id), 201, 'start');
    await expectStatus(await admin.post(`/api/cycle-counts/${c.id}/post`), 422, 'post before every line is counted');
    await expectStatus(await count(admin, c.id, v1.id, 7), 200, 'count v1');
    await expectStatus(await count(admin, c.id, v2.id, 4), 200, 'count v2');
    const posted = await expectStatus(await admin.post(`/api/cycle-counts/${c.id}/post`), 200, 'post');
    expect(posted.status).toBe('posted');
    expect(posted.postedAt).toBeTruthy();
    const view = await getProduct(admin, p.id);
    expect(stockOf(view, String(v1.id), String(wh.id)).onHand).toBe(7);
    expect(stockOf(view, String(v2.id), String(wh.id)).onHand).toBe(4);
    const adj = (await movements(admin, p.id)).filter((m) => m.type === 'adjustment');
    expect(adj, 'one movement for the line that differed').toHaveLength(1);
    expect(adj[0]).toMatchObject({ quantity: -3, variantId: v1.id, warehouseId: wh.id, balanceAfter: 7 });
    expect(String(adj[0].reason)).toMatch(/^Cycle count/);
    await expectStatus(await admin.post(`/api/cycle-counts/${c.id}/post`), 409, 'post twice');
    await expectStatus(await count(admin, c.id, v1.id, 1), 409, 'count after posting');
    expect(stockOf(await getProduct(admin, p.id), String(v1.id), String(wh.id)).onHand).toBe(7);
    await admin.dispose();
  });

  test('[M05][RM.4][C2] movements after the count started are respected: the correction is computed when posting', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const { wh, p, v1, v2 } = await setup(admin);
    const c = await expectStatus(await start(admin, wh.id), 201, 'start');
    await receive(admin, p.id, 5, 100, { warehouseId: wh.id }); // v1: 10 -> 15 while counting
    await expectStatus(await count(admin, c.id, v1.id, 12), 200, 'count v1');
    await expectStatus(await count(admin, c.id, v2.id, 6), 200, 'count v2');
    await expectStatus(await admin.post(`/api/cycle-counts/${c.id}/post`), 200, 'post');
    const view = await getProduct(admin, p.id);
    expect(stockOf(view, String(v1.id), String(wh.id)).onHand).toBe(12);
    expect(stockOf(view, String(v2.id), String(wh.id)).onHand).toBe(6);
    const adj = (await movements(admin, p.id)).filter((m) => m.type === 'adjustment');
    expect(adj.map((m) => [m.variantId, m.quantity]).sort()).toEqual([[v1.id, -3], [v2.id, 2]].sort());
    await admin.dispose();
  });

  test('[M06][RM.4][C2] a count below the reserved units -> 409 and no line is applied', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const { wh, p, v1, v2 } = await setup(admin);
    await createOrder(admin, [{ variantId: v2.id, quantity: 3 }], { warehouseId: wh.id });
    const c = await expectStatus(await start(admin, wh.id), 201, 'start');
    await expectStatus(await count(admin, c.id, v1.id, 1), 200, 'count v1');
    await expectStatus(await count(admin, c.id, v2.id, 2), 200, 'count v2 below its 3 reserved');
    await expectStatus(await admin.post(`/api/cycle-counts/${c.id}/post`), 409, 'post');
    const view = await getProduct(admin, p.id);
    expect(stockOf(view, String(v1.id), String(wh.id)).onHand, 'all or nothing').toBe(10);
    expect(stockOf(view, String(v2.id), String(wh.id))).toEqual({ onHand: 4, reserved: 3, available: 1 });
    expect((await movements(admin, p.id)).filter((m) => m.type === 'adjustment')).toHaveLength(0);
    expect((await (await admin.get(`/api/cycle-counts/${c.id}`)).json()).status).toBe('open');
    await admin.dispose();
  });

  test('[M07][RM.5][C2] cancel closes an open count without touching stock and frees the warehouse for a new count', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const { wh, p, v1 } = await setup(admin);
    const c = await expectStatus(await start(admin, wh.id), 201, 'start');
    await expectStatus(await count(admin, c.id, v1.id, 0), 200, 'count');
    const cancelled = await expectStatus(await admin.post(`/api/cycle-counts/${c.id}/cancel`), 200, 'cancel');
    expect(cancelled.status).toBe('cancelled');
    expect(stockOf(await getProduct(admin, p.id), String(v1.id), String(wh.id)).onHand).toBe(10);
    await expectStatus(await admin.post(`/api/cycle-counts/${c.id}/post`), 409, 'post a cancelled count');
    const next = await expectStatus(await start(admin, wh.id), 201, 'a new count after cancelling');
    for (const l of next.lines as Json[]) await expectStatus(await count(admin, next.id, l.variantId, Number(l.expected)), 200, 'count');
    await expectStatus(await admin.post(`/api/cycle-counts/${next.id}/post`), 200, 'post');
    await expectStatus(await admin.post(`/api/cycle-counts/${next.id}/cancel`), 409, 'cancel a posted count');
    await admin.dispose();
  });

  test('[M08][RM.6] /cycle-counts: an admin starts a count, fills "Counted <SKU>", saves ("Counts saved") and posts ("Count posted")', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const { wh, p, v1, v2 } = await setup(api);
    await page.goto('/');
    await navLink(page, 'Cycle counts').click();
    await expect(page).toHaveURL(/\/cycle-counts$/);
    await chooseLabel(field(page, 'Warehouse'), wh.name);
    await button(page, 'Start count').click();
    await expect(page.getByText(wh.name).filter({ visible: true }).first(), 'the open count shows its warehouse').toBeVisible();
    const table = tableWithHeader(page, 'Expected');
    await expectColumn(table, v2.sku, 'Expected', '4');
    // Other open counts may be listed too: act inside the block that holds this warehouse's count.
    const block = page
      .locator('section, article, form, li, div')
      .filter({ hasText: wh.name })
      .filter({ has: page.getByLabel(`Counted ${p.sku}`) })
      .filter({ has: page.getByRole('button', { name: 'Save counts', exact: true }) })
      .last();
    await field(block, `Counted ${p.sku}`).fill('8');
    await field(block, `Counted ${v2.sku}`).fill('4');
    await button(block, 'Save counts').click();
    await expect(page.getByText('Counts saved')).toBeVisible();
    await button(block, 'Post count').click();
    await expect(page.getByText('Count posted')).toBeVisible();
    const view = await getProduct(api, p.id);
    expect(stockOf(view, String(v1.id), String(wh.id)).onHand).toBe(8);
    await closeAll(context, api);
  });
});

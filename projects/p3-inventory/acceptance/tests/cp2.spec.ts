import { expect, test, type Page } from '@playwright/test';

import {
  adminPage,
  alerts,
  button,
  cell,
  chooseLabel,
  clerkPage,
  closeAll,
  createProduct,
  dialog,
  disableNativeValidation,
  expectAccessibleNames,
  expectColumn,
  expectHeaders,
  field,
  getProduct,
  issue,
  movements,
  optionLabels,
  receive,
  rowWith,
  stockedProduct,
  tableWithHeader,
} from './support';

async function record(page: Page, type: string, quantity: string, extra: { unitCost?: string; reason?: string } = {}) {
  await chooseLabel(field(page, 'Type'), type);
  await field(page, 'Quantity').fill(quantity);
  if (extra.unitCost !== undefined) await field(page, 'Unit cost').fill(extra.unitCost);
  if (extra.reason !== undefined) await field(page, 'Reason').fill(extra.reason);
  await button(page, 'Record').click();
}

test.describe('Checkpoint 2 - stock movements (UI)', () => {
  test('[cp2.01][R2.8] /products/:id shows "On hand: 0" and a "Record movement" form; "Adjustment" is offered to admins only', async ({ browser, playwright }) => {
    const admin = await adminPage(browser, playwright);
    const p = await createProduct(admin.api);
    await admin.page.goto(`/products/${p.id}`);
    await expect(admin.page.getByText('On hand: 0', { exact: true })).toBeVisible();
    await expect(admin.page.getByRole('heading', { name: 'Record movement' })).toBeVisible();
    for (const label of ['Type', 'Quantity']) await expect(field(admin.page, label), label).toBeVisible();
    await expect(button(admin.page, 'Record')).toBeVisible();
    expect(await optionLabels(field(admin.page, 'Type'))).toEqual(expect.arrayContaining(['Receipt', 'Issue', 'Adjustment']));

    const clerk = await clerkPage(browser, playwright);
    await clerk.page.goto(`/products/${p.id}`);
    const clerkTypes = await optionLabels(field(clerk.page, 'Type'));
    expect(clerkTypes).toEqual(expect.arrayContaining(['Receipt', 'Issue']));
    expect(clerkTypes).not.toContain('Adjustment');
    await closeAll(admin.context, admin.api, clerk.context, clerk.api);
  });

  test('[cp2.02][R2.8,R2.1] a clerk records a receipt (Quantity 5, Unit cost 2.50): "Movement recorded", "On hand: 5", 250 cents stored', async ({ browser, playwright }) => {
    const admin = await adminPage(browser, playwright);
    const p = await createProduct(admin.api);
    const clerk = await clerkPage(browser, playwright);
    await clerk.page.goto(`/products/${p.id}`);
    await record(clerk.page, 'Receipt', '5', { unitCost: '2.50' });
    await expect(clerk.page.getByText('Movement recorded')).toBeVisible();
    await expect(clerk.page.getByText('On hand: 5', { exact: true })).toBeVisible();
    const [m] = await movements(admin.api, p.id);
    expect(m).toMatchObject({ type: 'receipt', quantity: 5, unitCostCents: 250, balanceAfter: 5, userName: clerk.user.name });
    await closeAll(admin.context, admin.api, clerk.context, clerk.api);
  });

  test('[cp2.03][R2.8,R2.2] an issue larger than the stock shows "Insufficient stock" and keeps the input; a valid issue updates "On hand"', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await stockedProduct(api, 3);
    await page.goto(`/products/${p.id}`);
    await record(page, 'Issue', '4', { reason: 'Picking' });
    await expect(page.getByText(/insufficient stock/i).first()).toBeVisible();
    await expect(field(page, 'Quantity'), 'form keeps the user input').toHaveValue('4');
    await expect(page.getByText('On hand: 3', { exact: true })).toBeVisible();
    await field(page, 'Quantity').fill('2');
    await button(page, 'Record').click();
    await expect(page.getByText('Movement recorded')).toBeVisible();
    await expect(page.getByText('On hand: 1', { exact: true })).toBeVisible();
    expect((await getProduct(api, p.id)).onHand).toBe(1);
    await closeAll(context, api);
  });

  test('[cp2.04][R2.8] an admin records a negative adjustment with a reason', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await stockedProduct(api, 10);
    await page.goto(`/products/${p.id}`);
    await record(page, 'Adjustment', '-4', { reason: 'Damaged in storage' });
    await expect(page.getByText('Movement recorded')).toBeVisible();
    await expect(page.getByText('On hand: 6', { exact: true })).toBeVisible();
    const [m] = await movements(api, p.id);
    expect(m).toMatchObject({ type: 'adjustment', quantity: -4, reason: 'Damaged in storage', balanceAfter: 6 });
    await closeAll(context, api);
  });

  test('[cp2.05][R2.8,R2.1] an invalid quantity (0, native validation off) shows the server error and records nothing', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    await page.goto(`/products/${p.id}`);
    await disableNativeValidation(page);
    await record(page, 'Receipt', '0', { unitCost: '1.00' });
    await expect(alerts(page).first()).toBeVisible();
    expect(await movements(api, p.id)).toHaveLength(0);
    await closeAll(context, api);
  });

  test('[cp2.06][R2.9] "History" lists movements newest first with "Date", "Type", "Quantity" (signed), "Balance", "User"', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    await receive(api, p.id, 5, 300);
    await issue(api, p.id, 2);
    await page.goto(`/products/${p.id}`);
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    const table = tableWithHeader(page, 'Balance');
    for (const h of ['Date', 'Type', 'Quantity', 'Balance', 'User']) {
      await expect(table.getByRole('columnheader', { name: h, exact: true }), `History column "${h}"`).toBeVisible();
    }
    const rows = table.getByRole('row').filter({ has: page.getByRole('cell') });
    await expect(rows).toHaveCount(2);
    await expect(cell(rows.nth(0), 'Issue')).toBeVisible();
    await expect(cell(rows.nth(0), '-2')).toBeVisible();
    await expect(cell(rows.nth(0), '3')).toBeVisible();
    await expect(cell(rows.nth(0), 'Admin')).toBeVisible();
    await expect(cell(rows.nth(1), 'Receipt')).toBeVisible();
    await expect(cell(rows.nth(1), '+5')).toBeVisible();
    await expect(rows.nth(1)).toContainText(new Date().toISOString().slice(0, 10));
    await closeAll(context, api);
  });

  test('[cp2.07][R2.9] a product without movements shows "No movements yet"', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    await page.goto(`/products/${p.id}`);
    await expect(page.getByText('No movements yet')).toBeVisible();
    await closeAll(context, api);
  });

  test('[cp2.08][R2.7] /products has an "On hand" column with the current stock', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await stockedProduct(api, 17);
    await page.goto('/products');
    const table = await expectHeaders(page, ['SKU', 'Name', 'On hand'], '/products');
    await expectColumn(table, p.sku, 'On hand', '17');
    await closeAll(context, api);
  });

  test('[cp2.09][R2.6] deleting a product that has movements shows an error containing "movements" and keeps it', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await stockedProduct(api, 1);
    await page.goto('/products');
    await button(rowWith(page, p.sku), 'Delete').click();
    await button(dialog(page), 'Confirm delete').click();
    await expect(page.getByText(/movements/i).first()).toBeVisible();
    await page.goto('/products');
    await expect(rowWith(page, p.sku)).toHaveCount(1);
    await closeAll(context, api);
  });

  test('[cp2.10][R2.8][C5] the movement form has accessible names and a rejected movement renders in role="alert"', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await stockedProduct(api, 1);
    await page.goto(`/products/${p.id}`);
    await expectAccessibleNames(page, '/products/:id');
    await record(page, 'Issue', '5');
    await expect(alerts(page).filter({ hasText: /insufficient stock/i })).toBeVisible();
    await closeAll(context, api);
  });
});

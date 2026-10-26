import { expect, test } from '@playwright/test';

import {
  adminPage,
  alerts,
  button,
  chooseContaining,
  chooseLabel,
  clerkPage,
  closeAll,
  createProduct,
  createVariant,
  createWarehouse,
  dialog,
  expectAccessibleNames,
  expectColumn,
  expectDialogFocusAndEscape,
  expectHeaders,
  field,
  firstVariant,
  getProduct,
  HOME_URL,
  mainWarehouse,
  movements,
  navLink,
  receive,
  rowWith,
  stockOf,
  tableWithHeader,
  uniq,
  uniqSku,
} from './support';

const HISTORY = 'Balance';

test.describe('Checkpoint 4 - warehouses, variants, transfers (UI)', () => {
  test('[cp4.01][R4.1,R4.3] admins get "Warehouses": a table ("Code", "Name") with MAIN and a "New warehouse" dialog; clerks are redirected', async ({ browser, playwright }) => {
    const admin = await adminPage(browser, playwright);
    await admin.page.goto('/');
    await navLink(admin.page, 'Warehouses').click();
    await expect(admin.page).toHaveURL(/\/warehouses$/);
    const table = await expectHeaders(admin.page, ['Code', 'Name'], '/warehouses');
    await expectColumn(table, 'MAIN', 'Name', 'Main warehouse');
    const code = `E${Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[^A-Z0-9]/g, '0')}`;
    const name = uniq('East depot').slice(0, 40);
    await button(admin.page, 'New warehouse').click();
    const dlg = dialog(admin.page);
    await field(dlg, 'Code').fill(code.toLowerCase());
    await field(dlg, 'Name').fill(name);
    await button(dlg, 'Save').click();
    await expect(dlg).toBeHidden();
    await expectColumn(table, code, 'Name', name);

    const clerk = await clerkPage(browser, playwright);
    await clerk.page.goto('/');
    await expect(navLink(clerk.page, 'Products')).toBeVisible();
    await expect(navLink(clerk.page, 'Warehouses')).toHaveCount(0);
    await clerk.page.goto('/warehouses');
    await expect(clerk.page).toHaveURL(HOME_URL);
    await closeAll(admin.context, admin.api, clerk.context, clerk.api);
  });

  test('[cp4.02][R4.15,R4.5] /products/:id "Variants" table; admins add a variant with "Add variant" (SKU, Variant name, Reorder point, Save)', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    await page.goto(`/products/${p.id}`);
    await expect(page.getByRole('heading', { name: 'Variants' })).toBeVisible();
    const table = tableWithHeader(page, 'Variant');
    await expectColumn(table, p.sku, 'Variant', 'Default');
    const sku = uniqSku('V');
    await button(page, 'Add variant').click();
    const dlg = dialog(page);
    await field(dlg, 'SKU').fill(sku);
    await field(dlg, 'Variant name').fill('Red / L');
    await field(dlg, 'Reorder point').fill('3');
    await button(dlg, 'Save').click();
    await expect(dlg).toBeHidden();
    await expectColumn(table, sku, 'Variant', 'Red / L');
    await expectColumn(table, sku, 'On hand', '0');
    const after = await getProduct(api, p.id);
    expect(after.variants.map((v: { sku: string }) => v.sku)).toEqual([p.sku, sku]);
    expect(after.variants[1].reorderPoint).toBe(3);

    const clerk = await clerkPage(browser, playwright);
    await clerk.page.goto(`/products/${p.id}`);
    await expect(clerk.page.getByRole('heading', { name: 'Variants' })).toBeVisible();
    await expect(button(clerk.page, 'Add variant')).toHaveCount(0);
    await closeAll(context, api, clerk.context, clerk.api);
  });

  test('[cp4.03][R4.15,R4.6] "Stock by warehouse" lists each variant and warehouse; "On hand" / "Available" are product totals', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    const v2 = await createVariant(api, p.id);
    const east = await createWarehouse(api);
    await receive(api, p.id, 4, 100);
    await receive(api, p.id, 6, 100, { variantId: v2.id, warehouseId: east.id });
    await page.goto(`/products/${p.id}`);
    await expect(page.getByRole('heading', { name: 'Stock by warehouse' })).toBeVisible();
    const table = tableWithHeader(page, 'Warehouse');
    for (const h of ['Warehouse', 'SKU', 'On hand', 'Reserved', 'Available']) {
      await expect(table.getByRole('columnheader', { name: h, exact: true }), `column ${h}`).toBeVisible();
    }
    await expectColumn(table, v2.sku, 'Warehouse', east.name);
    await expectColumn(table, v2.sku, 'On hand', '6');
    await expectColumn(table, 'Main warehouse', 'SKU', p.sku);
    await expect(page.getByText('On hand: 10', { exact: true })).toBeVisible();
    await expect(page.getByText('Available: 10', { exact: true })).toBeVisible();
    await closeAll(context, api);
  });

  test('[cp4.04][R4.16,R4.8] "Record movement" has "Variant" (default first) and "Warehouse" (default "Main warehouse"); history shows "SKU" and "Warehouse"', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    const v2 = await createVariant(api, p.id);
    const east = await createWarehouse(api);
    await page.goto(`/products/${p.id}`);
    await expect(field(page, 'Warehouse')).toBeVisible();
    await expect(field(page, 'Variant').locator('option:checked')).toContainText(p.sku);
    await expect(field(page, 'Warehouse').locator('option:checked')).toHaveText('Main warehouse');
    await chooseContaining(field(page, 'Variant'), v2.sku);
    await chooseLabel(field(page, 'Warehouse'), east.name);
    await chooseLabel(field(page, 'Type'), 'Receipt');
    await field(page, 'Quantity').fill('7');
    await field(page, 'Unit cost').fill('1.25');
    await button(page, 'Record').click();
    await expect(page.getByText('Movement recorded')).toBeVisible();
    const after = await getProduct(api, p.id);
    expect(stockOf(after, String(v2.id), String(east.id)).onHand).toBe(7);
    expect(stockOf(after, String(firstVariant(after).id), String((await mainWarehouse(api)).id)).onHand).toBe(0);
    const history = tableWithHeader(page, HISTORY);
    await expectColumn(history, v2.sku, 'Warehouse', east.name);
    await expectColumn(history, v2.sku, 'Quantity', '+7');
    await closeAll(context, api);
  });

  test('[cp4.05][R4.11,R4.16] /transfers moves stock ("Variant", "From", "To", "Quantity", "Transfer"): "Transfer completed", listed, history shows "Transfer out" / "Transfer in"', async ({ browser, playwright }) => {
    const admin = await adminPage(browser, playwright);
    const p = await createProduct(admin.api);
    const east = await createWarehouse(admin.api);
    await receive(admin.api, p.id, 10, 100);
    const clerk = await clerkPage(browser, playwright);
    await clerk.page.goto('/');
    await navLink(clerk.page, 'Transfers').click();
    await expect(clerk.page).toHaveURL(/\/transfers$/);
    await chooseContaining(field(clerk.page, 'Variant'), p.sku);
    await chooseLabel(field(clerk.page, 'From'), 'Main warehouse');
    await chooseLabel(field(clerk.page, 'To'), east.name);
    await field(clerk.page, 'Quantity').fill('4');
    await button(clerk.page, 'Transfer').click();
    await expect(clerk.page.getByText('Transfer completed')).toBeVisible();
    const table = tableWithHeader(clerk.page, 'From');
    for (const h of ['Date', 'SKU', 'From', 'To', 'Quantity']) {
      await expect(table.getByRole('columnheader', { name: h, exact: true })).toBeVisible();
    }
    await expectColumn(table, p.sku, 'To', east.name);
    await expectColumn(table, p.sku, 'From', 'Main warehouse');
    await expectColumn(table, p.sku, 'Quantity', '4');
    const after = await getProduct(admin.api, p.id);
    expect(after.onHand, 'total unchanged').toBe(10);
    expect(stockOf(after, String(firstVariant(after).id), String(east.id)).onHand).toBe(4);
    await admin.page.goto(`/products/${p.id}`);
    const history = tableWithHeader(admin.page, HISTORY);
    await expectColumn(history, 'Transfer out', 'Quantity', '-4');
    await expectColumn(history, 'Transfer in', 'Quantity', '+4');
    await closeAll(admin.context, admin.api, clerk.context, clerk.api);
  });

  test('[cp4.06][R4.11,R4.10] a transfer over the available stock shows "Insufficient stock" and moves nothing', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    const east = await createWarehouse(api);
    await receive(api, p.id, 2, 100);
    await page.goto('/transfers');
    await chooseContaining(field(page, 'Variant'), p.sku);
    await chooseLabel(field(page, 'From'), 'Main warehouse');
    await chooseLabel(field(page, 'To'), east.name);
    await field(page, 'Quantity').fill('3');
    await button(page, 'Transfer').click();
    await expect(page.getByText(/insufficient stock/i).first()).toBeVisible();
    await expect(field(page, 'Quantity')).toHaveValue('3');
    const after = await getProduct(api, p.id);
    expect(stockOf(after, String(firstVariant(after).id), String(east.id)).onHand).toBe(0);
    expect(await movements(api, p.id)).toHaveLength(1);
    await closeAll(context, api);
  });

  test('[cp4.07][R4.13,R4.12] /orders/new has "Warehouse" (default "Main warehouse"); an order for a variant reserves it in the chosen warehouse', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    const v2 = await createVariant(api, p.id);
    const east = await createWarehouse(api);
    await receive(api, p.id, 5, 100, { variantId: v2.id, warehouseId: east.id });
    await page.goto('/orders/new');
    await expect(field(page, 'Warehouse').locator('option:checked')).toHaveText('Main warehouse');
    const customer = uniq('Umbrella');
    await field(page, 'Customer').fill(customer);
    await chooseLabel(field(page, 'Warehouse'), east.name);
    await chooseContaining(field(page, 'Line 1 product'), v2.sku);
    await field(page, 'Line 1 quantity').fill('2');
    await button(page, 'Place order').click();
    await expect(page.getByRole('heading', { name: customer })).toBeVisible();
    await expect(page.getByText(v2.sku).first()).toBeVisible();
    const after = await getProduct(api, p.id);
    expect(stockOf(after, String(v2.id), String(east.id))).toMatchObject({ onHand: 5, reserved: 2, available: 3 });
    await closeAll(context, api);
  });

  test('[cp4.08][R4.14] /alerts has a "Variant" column and lists a low variant of a product', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    const low = await createVariant(api, p.id, { name: 'Blue', reorderPoint: 4 });
    await receive(api, p.id, 3, 100, { variantId: low.id });
    await page.goto('/alerts');
    const table = await expectHeaders(page, ['SKU', 'Name', 'Variant', 'Available', 'Reorder point'], '/alerts');
    await expectColumn(table, low.sku, 'Variant', 'Blue');
    await expectColumn(table, low.sku, 'Name', p.name);
    await expectColumn(table, low.sku, 'Available', '3');
    await expect(rowWith(page, p.sku), 'the first variant (reorder point 0) is not low').toHaveCount(0);
    await closeAll(context, api);
  });

  test('[cp4.09][R4.3,R4.11,R4.15][C5] new screens: accessible names, dialogs take focus and close with Escape, transfer errors in role="alert"', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    const east = await createWarehouse(api);
    await page.goto('/warehouses');
    await expectAccessibleNames(page, '/warehouses');
    await expectDialogFocusAndEscape(page, () => button(page, 'New warehouse').click(), 'New warehouse');
    await page.goto(`/products/${p.id}`);
    await expect(field(page, 'Warehouse')).toBeVisible();
    await expectAccessibleNames(page, '/products/:id');
    await expectDialogFocusAndEscape(page, () => button(page, 'Add variant').click(), 'Add variant');
    await page.goto('/transfers');
    await expectAccessibleNames(page, '/transfers');
    await chooseContaining(field(page, 'Variant'), p.sku);
    await chooseLabel(field(page, 'From'), 'Main warehouse');
    await chooseLabel(field(page, 'To'), east.name);
    await field(page, 'Quantity').fill('1');
    await button(page, 'Transfer').click();
    await expect(alerts(page).filter({ hasText: /insufficient stock/i })).toBeVisible();
    await closeAll(context, api);
  });
});

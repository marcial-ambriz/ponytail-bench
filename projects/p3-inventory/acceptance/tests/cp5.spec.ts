import { expect, test } from '@playwright/test';

import {
  adminPage,
  chooseLabel,
  clerkPage,
  closeAll,
  createProduct,
  createWarehouse,
  expectAccessibleNames,
  expectColumn,
  field,
  firstVariant,
  HOME_URL,
  mainWarehouse,
  navLink,
  optionLabels,
  postTransfer,
  receive,
  tableWithHeader,
  todayYmd,
  expectStatus,
  issue,
} from './support';

test.describe('Checkpoint 5 - reports (UI)', () => {
  test('[cp5.01][R5.5] admins get "Reports" with "Inventory valuation": "Warehouse" filter, value table and "Total value: $..."', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const east = await createWarehouse(api);
    const main = await mainWarehouse(api);
    const p = await createProduct(api);
    await receive(api, p.id, 1000, 12345);
    await expectStatus(await postTransfer(api, { variantId: firstVariant(p).id, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 1000 }), 201, 'transfer');
    await page.goto('/');
    await navLink(page, 'Reports').click();
    await expect(page).toHaveURL(/\/reports$/);
    await expect(page.getByRole('heading', { name: 'Inventory valuation' })).toBeVisible();
    const labels = await optionLabels(field(page, 'Warehouse'));
    expect(labels[0]).toBe('All warehouses');
    expect(labels).toEqual(expect.arrayContaining(['Main warehouse', east.name]));
    await chooseLabel(field(page, 'Warehouse'), east.name);
    await expect(page.getByText('Total value: $123,450.00', { exact: true })).toBeVisible();
    const table = tableWithHeader(page, 'Average cost');
    for (const h of ['SKU', 'Product', 'Variant', 'On hand', 'Average cost', 'Value']) {
      await expect(table.getByRole('columnheader', { name: h, exact: true }), `column ${h}`).toBeVisible();
    }
    await expectColumn(table, p.sku, 'Product', p.name);
    await expectColumn(table, p.sku, 'On hand', '1000');
    await expectColumn(table, p.sku, 'Average cost', '$123.45');
    await expectColumn(table, p.sku, 'Value', '$123,450.00');
    await closeAll(context, api);
  });

  test('[cp5.02][R5.5,R5.4] "Export valuation CSV" links to the CSV of the selected warehouse', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const east = await createWarehouse(api);
    const main = await mainWarehouse(api);
    const p = await createProduct(api);
    await receive(api, p.id, 2, 150);
    await expectStatus(await postTransfer(api, { variantId: firstVariant(p).id, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 2 }), 201, 'transfer');
    await page.goto('/reports');
    await chooseLabel(field(page, 'Warehouse'), east.name);
    const link = page.getByRole('link', { name: 'Export valuation CSV', exact: true });
    await expect(link).toHaveAttribute('href', new RegExp(`warehouseId=${east.id}`));
    const href = (await link.getAttribute('href')) ?? '';
    const res = await api.get(href.startsWith('http') ? new URL(href).pathname + new URL(href).search : href);
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text.split(/\r?\n/)[0]).toBe('SKU,Product,Variant,On hand,Average cost,Value');
    expect(text).toContain(`${p.sku},`);
    expect(text.trim().split(/\r?\n/), 'only the east warehouse').toHaveLength(2);
    await closeAll(context, api);
  });

  test('[cp5.03][R5.6] "Movements by period": "From"/"To" default to today, a table per SKU, filters on change, "No data for this period"', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    await receive(api, p.id, 9, 100);
    await issue(api, p.id, 4);
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Movements by period' })).toBeVisible();
    const t = todayYmd();
    await expect(field(page, 'From')).toHaveValue(t);
    await expect(field(page, 'To')).toHaveValue(t);
    const table = tableWithHeader(page, 'Opening');
    for (const h of ['SKU', 'Opening', 'Received', 'Shipped', 'Adjusted', 'Transferred', 'Closing']) {
      await expect(table.getByRole('columnheader', { name: h, exact: true }), `column ${h}`).toBeVisible();
    }
    await expectColumn(table, p.sku, 'Received', '9');
    await expectColumn(table, p.sku, 'Shipped', '4');
    await expectColumn(table, p.sku, 'Closing', '5');
    await expect(page.getByRole('link', { name: 'Export movements CSV', exact: true })).toBeVisible();
    await field(page, 'From').fill('2000-01-01');
    await field(page, 'To').fill('2000-01-31');
    await expect(page.getByText('No data for this period')).toBeVisible();
    await closeAll(context, api);
  });

  test('[cp5.04][R5.5] clerks have no "Reports" link and are redirected away from /reports', async ({ browser, playwright }) => {
    const { context, page, api } = await clerkPage(browser, playwright);
    await page.goto('/');
    await expect(navLink(page, 'Products')).toBeVisible();
    await expect(navLink(page, 'Reports')).toHaveCount(0);
    await page.goto('/reports');
    await expect(page).toHaveURL(HOME_URL);
    await closeAll(context, api);
  });

  test('[cp5.05][R5.5,R5.6][C5] /reports: every control has an accessible name', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    await page.goto('/reports');
    await expect(field(page, 'Warehouse')).toBeVisible();
    await expect(field(page, 'From')).toBeVisible();
    await expectAccessibleNames(page, '/reports');
    await closeAll(context, api);
  });
});

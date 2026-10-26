import { expect, test, type Page } from '@playwright/test';

import {
  action,
  adminPage,
  alerts,
  button,
  chooseContaining,
  clerkPage,
  closeAll,
  createOrder,
  createProduct,
  dialog,
  expectAccessibleNames,
  expectColumn,
  expectDialogFocusAndEscape,
  expectHeaders,
  field,
  getProduct,
  navLink,
  rowWith,
  shipOrder,
  stockedProduct,
  tableWithHeader,
  uniq,
} from './support';

async function fillOrder(page: Page, customer: string, lines: Array<{ sku: string; quantity: number }>) {
  await page.goto('/orders/new');
  await field(page, 'Customer').fill(customer);
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) await button(page, 'Add line').click();
    await chooseContaining(field(page, `Line ${i + 1} product`), lines[i].sku);
    await field(page, `Line ${i + 1} quantity`).fill(String(lines[i].quantity));
  }
}

test.describe('Checkpoint 3 - orders and alerts (UI)', () => {
  test('[cp3.01][R3.9,R3.10] a clerk places a two-line order: it opens /orders/:id with the customer, "Reserved" and the lines', async ({ browser, playwright }) => {
    const admin = await adminPage(browser, playwright);
    const a = await stockedProduct(admin.api, 10);
    const b = await stockedProduct(admin.api, 5);
    const clerk = await clerkPage(browser, playwright);
    const customer = uniq('Acme');
    await fillOrder(clerk.page, customer, [
      { sku: a.sku, quantity: 3 },
      { sku: b.sku, quantity: 5 },
    ]);
    await button(clerk.page, 'Place order').click();
    await expect(clerk.page).toHaveURL(/\/orders\/(?!new)[^/]+$/);
    await expect(clerk.page.getByRole('heading', { name: customer })).toBeVisible();
    await expect(clerk.page.getByText('Reserved', { exact: true }).first()).toBeVisible();
    await expect(clerk.page.getByText(a.sku).first()).toBeVisible();
    await expect(clerk.page.getByText(b.sku).first()).toBeVisible();
    expect(await getProduct(admin.api, a.id)).toMatchObject({ onHand: 10, reserved: 3, available: 7 });
    expect(await getProduct(admin.api, b.id)).toMatchObject({ onHand: 5, reserved: 5, available: 0 });
    await closeAll(admin.context, admin.api, clerk.context, clerk.api);
  });

  test('[cp3.02][R3.9,R3.4] an order over the available stock shows "Insufficient stock", keeps the form and reserves nothing', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const a = await stockedProduct(api, 10);
    const b = await stockedProduct(api, 2);
    const customer = uniq('Globex');
    await fillOrder(page, customer, [
      { sku: a.sku, quantity: 4 },
      { sku: b.sku, quantity: 3 },
    ]);
    await button(page, 'Place order').click();
    await expect(page.getByText(/insufficient stock/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/orders\/new$/);
    await expect(field(page, 'Customer')).toHaveValue(customer);
    expect((await getProduct(api, a.id)).reserved, 'all lines or none').toBe(0);
    expect((await getProduct(api, b.id)).reserved).toBe(0);
    await closeAll(context, api);
  });

  test('[cp3.03][R3.10,R3.5] "Ship order" shows "Order shipped", the status becomes "Shipped" and stock leaves', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await stockedProduct(api, 8);
    const order = await createOrder(api, [{ productId: p.id, quantity: 3 }]);
    await page.goto(`/orders/${order.id}`);
    await button(page, 'Ship order').click();
    await expect(page.getByText('Order shipped')).toBeVisible();
    await expect(page.getByText('Shipped', { exact: true }).first()).toBeVisible();
    await expect(button(page, 'Ship order')).toHaveCount(0);
    expect(await getProduct(api, p.id)).toMatchObject({ onHand: 5, reserved: 0, available: 5 });
    await closeAll(context, api);
  });

  test('[cp3.04][R3.10,R3.6] "Cancel order" asks in an in-page dialog ("Confirm cancel"), shows "Order cancelled" and releases the stock', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await stockedProduct(api, 8);
    const order = await createOrder(api, [{ productId: p.id, quantity: 6 }]);
    let native = false;
    page.on('dialog', async (d) => {
      native = true;
      await d.dismiss();
    });
    await page.goto(`/orders/${order.id}`);
    await button(page, 'Cancel order').click();
    await button(dialog(page), 'Confirm cancel').click();
    await expect(page.getByText('Order cancelled')).toBeVisible();
    await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
    expect(native, 'no window.confirm').toBe(false);
    expect(await getProduct(api, p.id)).toMatchObject({ onHand: 8, reserved: 0, available: 8 });
    await closeAll(context, api);
  });

  test('[cp3.05][R3.8] "Orders" nav link; /orders table ("Customer", "Status", "Lines", "Created") with customer links', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await stockedProduct(api, 5);
    const shipped = await createOrder(api, [{ productId: p.id, quantity: 1 }]);
    await shipOrder(api, shipped.id);
    const open = await createOrder(api, [{ productId: p.id, quantity: 2 }]);
    await page.goto('/');
    await navLink(page, 'Orders').click();
    await expect(page).toHaveURL(/\/orders$/);
    const table = await expectHeaders(page, ['Customer', 'Status', 'Lines', 'Created'], '/orders');
    await expectColumn(table, open.customer, 'Status', 'Reserved');
    await expectColumn(table, shipped.customer, 'Status', 'Shipped');
    const texts = await table.getByRole('row').allTextContents();
    const at = (c: string) => texts.findIndex((t) => t.includes(c));
    expect(at(open.customer), 'newest first').toBeLessThan(at(shipped.customer));
    await rowWith(page, open.customer).getByRole('link', { name: open.customer }).click();
    await expect(page).toHaveURL(new RegExp(`/orders/${open.id}$`));
    await page.goto('/orders');
    await action(page, 'New order').click();
    await expect(page).toHaveURL(/\/orders\/new$/);
    await closeAll(context, api);
  });

  test('[cp3.06][R3.11] /products shows "Available"; /products/:id shows "Reserved" / "Available" and "Shipment" in history', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await stockedProduct(api, 9);
    const shipped = await createOrder(api, [{ productId: p.id, quantity: 2 }]);
    await shipOrder(api, shipped.id);
    await createOrder(api, [{ productId: p.id, quantity: 4 }]);
    await page.goto('/products');
    const table = await expectHeaders(page, ['SKU', 'On hand', 'Available'], '/products');
    await expectColumn(table, p.sku, 'On hand', '7');
    await expectColumn(table, p.sku, 'Available', '3');
    await page.goto(`/products/${p.id}`);
    await expect(page.getByText('On hand: 7', { exact: true })).toBeVisible();
    await expect(page.getByText('Reserved: 4', { exact: true })).toBeVisible();
    await expect(page.getByText('Available: 3', { exact: true })).toBeVisible();
    const history = tableWithHeader(page, 'Balance');
    await expectColumn(history, 'Shipment', 'Quantity', '-2');
    await closeAll(context, api);
  });

  test('[cp3.07][R3.12] the product dialog has "Reorder point" and saving it persists the value', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    await page.goto('/products');
    await button(rowWith(page, p.sku), 'Edit').click();
    const dlg = dialog(page);
    await field(dlg, 'Reorder point').fill('12');
    await button(dlg, 'Save').click();
    await expect(dlg).toBeHidden();
    await expect.poll(async () => (await getProduct(api, p.id)).reorderPoint).toBe(12);
    await closeAll(context, api);
  });

  test('[cp3.08][R3.13,R3.14] "Alerts" nav link; /alerts ("Low stock") lists products at or below their reorder point', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const low = await stockedProduct(api, 5, 100, { reorderPoint: 5 });
    const fine = await stockedProduct(api, 6, 100, { reorderPoint: 5 });
    await createOrder(api, [{ productId: fine.id, quantity: 4 }]);
    const notTracked = await stockedProduct(api, 0, 100, { reorderPoint: 0 });
    await page.goto('/');
    await navLink(page, 'Alerts').click();
    await expect(page).toHaveURL(/\/alerts$/);
    await expect(page.getByRole('heading', { name: 'Low stock' })).toBeVisible();
    const table = await expectHeaders(page, ['SKU', 'Name', 'Available', 'Reorder point'], '/alerts');
    await expectColumn(table, low.sku, 'Available', '5');
    await expectColumn(table, low.sku, 'Reorder point', '5');
    await expectColumn(table, low.sku, 'Name', low.name);
    await expectColumn(table, fine.sku, 'Available', '2');
    await expect(rowWith(page, notTracked.sku)).toHaveCount(0);
    await closeAll(context, api);
  });

  test('[cp3.09][R3.9,R3.10][C5] order screens: accessible names, errors in role="alert", cancel dialog focus and Escape', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await stockedProduct(api, 1);
    await fillOrder(page, uniq('Initech'), [{ sku: p.sku, quantity: 2 }]);
    await expectAccessibleNames(page, '/orders/new');
    await button(page, 'Place order').click();
    await expect(alerts(page).filter({ hasText: /insufficient stock/i })).toBeVisible();
    const order = await createOrder(api, [{ productId: p.id, quantity: 1 }]);
    await page.goto(`/orders/${order.id}`);
    await expectAccessibleNames(page, '/orders/:id');
    await expectDialogFocusAndEscape(page, () => button(page, 'Cancel order').click(), 'Cancel order');
    expect((await getProduct(api, p.id)).reserved, 'Escape does not cancel').toBe(1);
    await page.goto('/alerts');
    await expectAccessibleNames(page, '/alerts');
    await closeAll(context, api);
  });
});

import { expect, test } from '@playwright/test';

import {
  ADMIN,
  HOME_URL,
  LOGIN_URL,
  adminApi,
  adminPage,
  browserContextFor,
  alerts,
  button,
  cell,
  clerkApi,
  clerkPage,
  closeAll,
  createProduct,
  dialog,
  disableNativeValidation,
  expectAccessibleNames,
  expectDialogFocusAndEscape,
  expectHeaders,
  extraAdminApi,
  field,
  forbidNativeDialogs,
  login,
  navLink,
  newCreds,
  newPage,
  rowWith,
  signOutButton,
  submitRegister,
  uniq,
  uniqSku,
} from './support';

test.describe('Checkpoint 1 - auth, roles, catalog (UI)', () => {
  test('[cp1.01][R1.1] visiting / without a session redirects to /login', async ({ browser }) => {
    const { context, page } = await newPage(browser);
    await page.goto('/');
    await expect(page).toHaveURL(LOGIN_URL);
    await closeAll(context);
  });

  test('[cp1.02][R1.2,R1.4] "Create account" signs the user in, redirects to / and shows their name and "Sign out"', async ({ browser }) => {
    const { context, page } = await newPage(browser);
    const u = newCreds();
    await submitRegister(page, u);
    await expect(page).toHaveURL(HOME_URL);
    await expect(signOutButton(page)).toBeVisible();
    await expect(page.getByText(u.name, { exact: true }).first()).toBeVisible();
    await closeAll(context);
  });

  test('[cp1.03][R1.2] a short password shows "Password must be at least 8 characters"; a duplicate email shows "already"', async ({ browser, playwright }) => {
    const { context, page } = await newPage(browser);
    await submitRegister(page, newCreds({ password: 'short' }));
    await expect(page.getByText('Password must be at least 8 characters')).toBeVisible();
    await expect(page).not.toHaveURL(HOME_URL);
    const existing = await clerkApi(playwright);
    await submitRegister(page, newCreds({ email: existing.user.email }));
    await expect(page.getByText(/already/i).first()).toBeVisible();
    await closeAll(context, existing.api);
  });

  test('[cp1.04][R1.3] wrong credentials show "Invalid"; the seeded admin signs in with "Sign in"', async ({ browser }) => {
    const { context, page } = await newPage(browser);
    await page.goto('/login');
    await field(page, 'Email').fill(ADMIN.email);
    await field(page, 'Password').fill('WrongPassword1!');
    await button(page, 'Sign in').click();
    await expect(page.getByText(/invalid/i).first()).toBeVisible();
    await login(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(HOME_URL);
    await expect(page.getByText(ADMIN.name, { exact: true }).first()).toBeVisible();
    await closeAll(context);
  });

  test('[cp1.05][R1.4] "Sign out" returns to /login and the session is gone', async ({ browser }) => {
    const { context, page } = await newPage(browser);
    await login(page, ADMIN.email, ADMIN.password);
    await signOutButton(page).click();
    await expect(page).toHaveURL(LOGIN_URL);
    await page.goto('/products');
    await expect(page).toHaveURL(LOGIN_URL);
    await closeAll(context);
  });

  test('[cp1.06][R1.4] admins see nav links "Products" and "Users"; clerks see "Products" only and are redirected away from /users', async ({ browser, playwright }) => {
    const admin = await adminPage(browser, playwright);
    await admin.page.goto('/');
    await expect(navLink(admin.page, 'Products')).toBeVisible();
    await expect(navLink(admin.page, 'Users')).toBeVisible();
    await navLink(admin.page, 'Users').click();
    await expect(admin.page).toHaveURL(/\/users$/);

    const clerk = await clerkPage(browser, playwright);
    await clerk.page.goto('/');
    await expect(navLink(clerk.page, 'Products')).toBeVisible();
    await expect(navLink(clerk.page, 'Users')).toHaveCount(0);
    await clerk.page.goto('/users');
    await expect(clerk.page).toHaveURL(HOME_URL);
    await closeAll(admin.context, admin.api, clerk.context, clerk.api);
  });

  test('[cp1.07][R1.6] /users lists users with "Name", "Email", "Role"; changing "Role" saves and shows "Role updated"', async ({ browser, playwright }) => {
    const target = await clerkApi(playwright);
    const { context, page, api } = await adminPage(browser, playwright);
    await page.goto('/users');
    await expectHeaders(page, ['Name', 'Email', 'Role'], '/users');
    const row = rowWith(page, target.user.email);
    await expect(row).toHaveCount(1);
    await field(row, 'Role').selectOption('admin');
    await expect(page.getByText('Role updated')).toBeVisible();
    const me = await (await target.api.get('/api/me')).json();
    expect(me.role, 'role applies on the next request without signing out (R1.5)').toBe('admin');
    await closeAll(context, api, target.api);
  });

  test('[cp1.08][R1.6] an admin cannot change their own role: the UI shows the error and the role stays admin', async ({ browser, playwright }) => {
    const boss = await extraAdminApi(playwright);
    const context = await browserContextFor(browser, boss.api);
    const page = await context.newPage();
    await page.goto('/users');
    const row = rowWith(page, boss.user.email);
    await field(row, 'Role').selectOption('clerk');
    await expect(alerts(page).first()).toBeVisible();
    const me = await (await boss.api.get('/api/me')).json();
    expect(me.role).toBe('admin');
    await closeAll(context, boss.api);
  });

  test('[cp1.09][R1.9] /products is a table ("SKU", "Name") ordered by SKU; each SKU links to /products/:id', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const tag = uniq('Ord').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const b = await createProduct(api, { sku: `${tag}-B`, name: uniq('Bravo') });
    const a = await createProduct(api, { sku: `${tag}-A`, name: uniq('Alpha') });
    await page.goto('/products');
    await expectHeaders(page, ['SKU', 'Name'], '/products');
    const rows = page.getByRole('row').filter({ hasText: tag });
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(`${tag}-A`);
    await expect(rows.nth(1)).toContainText(`${tag}-B`);
    await rows.nth(0).getByRole('link', { name: a.sku, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/products/${a.id}$`));
    await expect(page.getByRole('heading', { name: a.name })).toBeVisible();
    await expect(page.getByText(`SKU: ${a.sku}`)).toBeVisible();
    expect(b.sku).toBe(`${tag}-B`);
    await closeAll(context, api);
  });

  test('[cp1.10][R1.9] "Search" filters by SKU or name on change; no match shows "No products found"', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api, { name: uniq('Sprocket') });
    const other = await createProduct(api, { name: uniq('Gizmo') });
    await page.goto('/products');
    await field(page, 'Search').fill(p.name.toLowerCase());
    await expect(rowWith(page, p.sku)).toHaveCount(1);
    await expect(rowWith(page, other.sku)).toHaveCount(0);
    await field(page, 'Search').fill(other.sku.toLowerCase());
    await expect(rowWith(page, other.sku)).toHaveCount(1);
    await expect(rowWith(page, p.sku)).toHaveCount(0);
    await field(page, 'Search').fill(`zz-${uniq('none')}`);
    await expect(page.getByText('No products found')).toBeVisible();
    await closeAll(context, api);
  });

  test('[cp1.11][R1.10] "New product" dialog (SKU, Name, Description, "Save") creates a product with "Edit" and "Delete"', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const sku = uniqSku();
    const name = uniq('Hinge');
    await page.goto('/products');
    await button(page, 'New product').click();
    const dlg = dialog(page);
    await expect(dlg).toBeVisible();
    await expect(button(dlg, 'Cancel'), 'close buttons are labeled "Close"').toHaveCount(0);
    await field(dlg, 'SKU').fill(` ${sku.toLowerCase()} `);
    await field(dlg, 'Name').fill(name);
    await field(dlg, 'Description').fill('Steel, 40 mm');
    await button(dlg, 'Save').click();
    await expect(dlg).toBeHidden();
    const row = rowWith(page, sku);
    await expect(row, 'SKU is stored trimmed and upper-case (R1.7)').toHaveCount(1);
    await expect(cell(row, name)).toBeVisible();
    await expect(button(row, 'Edit')).toBeVisible();
    await expect(button(row, 'Delete')).toBeVisible();
    await closeAll(context, api);
  });

  test('[cp1.12][R1.7,R1.10] a duplicate SKU is rejected in the dialog with "already exists" and nothing is created', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    await page.goto('/products');
    await button(page, 'New product').click();
    const dlg = dialog(page);
    await disableNativeValidation(page);
    await field(dlg, 'SKU').fill(p.sku.toLowerCase());
    await field(dlg, 'Name').fill(uniq('Dup'));
    await button(dlg, 'Save').click();
    await expect(dlg.getByText(/already exists/i)).toBeVisible();
    await expect(dlg).toBeVisible();
    const list = await (await api.get(`/api/products?q=${encodeURIComponent(p.sku)}`)).json();
    expect(list.filter((x: { sku: string }) => x.sku === p.sku)).toHaveLength(1);
    await closeAll(context, api);
  });

  test('[cp1.13][R1.10] "Edit" opens the dialog prefilled and saving persists the new name', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    const renamed = uniq('Renamed');
    await page.goto('/products');
    await button(rowWith(page, p.sku), 'Edit').click();
    const dlg = dialog(page);
    await expect(field(dlg, 'Name')).toHaveValue(p.name);
    await field(dlg, 'Name').fill(renamed);
    await button(dlg, 'Save').click();
    await expect(dlg).toBeHidden();
    await expect(cell(rowWith(page, p.sku), renamed)).toBeVisible();
    await page.reload();
    await expect(cell(rowWith(page, p.sku), renamed)).toBeVisible();
    await closeAll(context, api);
  });

  test('[cp1.14][R1.10] "Delete" asks in an in-page dialog ("Confirm delete") and removes the product', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    const native = forbidNativeDialogs(page);
    await page.goto('/products');
    await button(rowWith(page, p.sku), 'Delete').click();
    const dlg = dialog(page);
    await button(dlg, 'Confirm delete').click();
    await expect(rowWith(page, p.sku)).toHaveCount(0);
    expect(native.used, 'no window.confirm').toBe(false);
    expect((await api.get(`/api/products/${p.id}`)).status()).toBe(404);
    await closeAll(context, api);
  });

  test('[cp1.15][R1.10] clerks see no "New product", "Edit" or "Delete" controls', async ({ browser, playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const clerk = await clerkPage(browser, playwright);
    await clerk.page.goto('/products');
    await expect(rowWith(clerk.page, p.sku)).toHaveCount(1);
    await expect(button(clerk.page, 'New product')).toHaveCount(0);
    await expect(button(clerk.page, 'Edit')).toHaveCount(0);
    await expect(button(clerk.page, 'Delete')).toHaveCount(0);
    await closeAll(clerk.context, clerk.api, admin);
  });

  test('[cp1.16][R1.2,R1.3][C5] auth forms have accessible names and errors render in role="alert"', async ({ browser }) => {
    const { context, page } = await newPage(browser);
    await page.goto('/register');
    await expectAccessibleNames(page, '/register');
    await submitRegister(page, newCreds({ password: 'short' }));
    await expect(alerts(page).filter({ hasText: 'Password must be at least 8 characters' })).toBeVisible();
    await page.goto('/login');
    await expectAccessibleNames(page, '/login');
    await field(page, 'Email').fill(ADMIN.email);
    await field(page, 'Password').fill('WrongPassword1!');
    await button(page, 'Sign in').click();
    await expect(alerts(page).filter({ hasText: /invalid/i })).toBeVisible();
    await closeAll(context);
  });

  test('[cp1.17][R1.10][C5] product dialogs move focus inside and close with Escape; server errors render in role="alert"', async ({ browser, playwright }) => {
    const { context, page, api } = await adminPage(browser, playwright);
    const p = await createProduct(api);
    await page.goto('/products');
    await expectAccessibleNames(page, '/products');
    await expectDialogFocusAndEscape(page, () => button(page, 'New product').click(), 'New product');
    await expectDialogFocusAndEscape(page, () => button(rowWith(page, p.sku), 'Edit').click(), 'Edit');
    await expectDialogFocusAndEscape(page, () => button(rowWith(page, p.sku), 'Delete').click(), 'Delete');
    await button(page, 'New product').click();
    const dlg = dialog(page);
    await expectAccessibleNames(page, 'New product dialog');
    await disableNativeValidation(page);
    await field(dlg, 'SKU').fill(p.sku);
    await field(dlg, 'Name').fill(uniq('Dup'));
    await button(dlg, 'Save').click();
    await expect(alerts(dlg).first()).toBeVisible();
    await closeAll(context, api);
  });
});

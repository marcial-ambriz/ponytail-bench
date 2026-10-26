/** UI acceptance, checkpoint 4 (C1 + C5): CSV import page and audit log page (spec/cp4.md). */
import { expect, test } from '@playwright/test';
import {
  alerts,
  anonApi,
  button,
  createCustomer,
  deliver,
  expectAccessibleNames,
  expectColumnHeaders,
  issuedInvoice,
  line,
  orgNav,
  ownerWithOrg,
  pageFor,
  payflowEvent,
  row,
  team,
  uniq,
  uniqEmail,
  uploadText,
  webhookSecret,
} from '../../support';

const INVOICE_HEADER = 'invoice_ref,customer_email,due_date,description,quantity,unit_price,tax_rate';

test.describe('Checkpoint 4 - import', () => {
  test('[cp4.01][R4.6] "Import customers" with a valid file shows "Imported 2 customers" and they appear on the customers page', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const a = uniq('Imported A');
    const b = uniq('Imported B');
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}`);
    await orgNav(page).getByRole('link', { name: 'Import', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/import/?$`));
    await expect(page.getByRole('heading', { name: 'Import customers' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Import invoices' })).toBeVisible();
    await uploadText(page, 'Customers CSV', 'customers.csv', `name,email\n${a},${uniqEmail()}\n"${b}",${uniqEmail()}\n`);
    await button(page, 'Import customers').click();
    await expect(page.getByText('Imported 2 customers')).toBeVisible();
    await page.goto(`/orgs/${org.id}/customers`);
    await expect(row(page, a)).toBeVisible();
    await expect(row(page, b)).toBeVisible();
    await context.close();
  });

  test('[cp4.02][R4.6] a rejected file shows "Nothing was imported" and a "Row" / "Error" table with the file line numbers', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/import`);
    await uploadText(page, 'Customers CSV', 'bad.csv', `name,email\nGood,${uniqEmail()}\nBad,not-an-email\n,${uniqEmail()}\n`);
    await button(page, 'Import customers').click();
    await expect(alerts(page).filter({ hasText: 'Nothing was imported' }).or(page.getByText(/Nothing was imported/)).first()).toBeVisible();
    await expectColumnHeaders(page, ['Row', 'Error']);
    const rows = page.getByRole('row').filter({ has: page.getByRole('cell') });
    const firstCells = await rows.evaluateAll((rs) => rs.map((r) => (r.querySelector('td,th')?.textContent ?? '').trim()));
    expect(firstCells.filter((t) => /^\d+$/.test(t)).map(Number).sort()).toEqual([3, 4]);
    expect(await (await owner.get(`/api/orgs/${org.id}/customers`)).json()).toEqual([]);
    await context.close();
  });

  test('[cp4.03][R4.6] "Import invoices" with a valid file shows "Imported 2 invoices" and the drafts appear in the invoice list', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id, { name: uniq('Bulk client') });
    const csv = [INVOICE_HEADER, `A,${c.email},2031-01-31,Design,2,19.99,16`, `B,${c.email},2031-02-28,Hosting,1,5,0`, `A,${c.email},2031-01-31,Extra,1,0.5,0`].join('\r\n');
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/import`);
    await uploadText(page, 'Invoices CSV', 'invoices.csv', csv);
    await button(page, 'Import invoices').click();
    await expect(page.getByText('Imported 2 invoices')).toBeVisible();
    await page.goto(`/orgs/${org.id}/invoices`);
    await expect(page.getByRole('link', { name: 'Draft', exact: true })).toHaveCount(2);
    await expect(page.getByText('$46.88').first()).toBeVisible(); // 39.98 + 6.40 tax + 0.50
    await context.close();
  });

  test('[cp4.04][R4.6][R4.10] viewers have no "Import" or "Audit log" links; accountants have both', async ({ browser, playwright }) => {
    const t = await team(playwright);
    const viewer = await pageFor(browser, t.viewer);
    await viewer.page.goto(`/orgs/${t.org.id}`);
    await expect(orgNav(viewer.page).getByRole('link', { name: 'Customers', exact: true })).toBeVisible();
    await expect(orgNav(viewer.page).getByRole('link', { name: 'Import', exact: true })).toHaveCount(0);
    await expect(orgNav(viewer.page).getByRole('link', { name: 'Audit log', exact: true })).toHaveCount(0);
    await viewer.context.close();
    const acc = await pageFor(browser, t.accountant);
    await acc.page.goto(`/orgs/${t.org.id}`);
    await expect(orgNav(acc.page).getByRole('link', { name: 'Import', exact: true })).toBeVisible();
    await expect(orgNav(acc.page).getByRole('link', { name: 'Audit log', exact: true })).toBeVisible();
    await acc.context.close();
  });
});

test.describe('Checkpoint 4 - audit log', () => {
  test('[cp4.05][R4.10] "Audit log" table ("Time", "Actor", "Action", "Entity"), newest first, with member names and "PayFlow"', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(3000)]);
    const secret = await webhookSecret(owner, org.id);
    await deliver(await anonApi(playwright), org.id, secret, payflowEvent('payment.succeeded', invoice.id, 1000));
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}`);
    await orgNav(page).getByRole('link', { name: 'Audit log', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/audit/?$`));
    await expectColumnHeaders(page, ['Time', 'Actor', 'Action', 'Entity']);
    const bodyRows = page.getByRole('row').filter({ has: page.getByRole('cell') });
    await expect(bodyRows).toHaveCount(4);
    await expect(bodyRows.nth(0)).toContainText('payment.recorded');
    await expect(bodyRows.nth(0)).toContainText('PayFlow');
    await expect(bodyRows.nth(1)).toContainText('invoice.issued');
    await expect(bodyRows.nth(1)).toContainText(owner.user!.name);
    await expect(bodyRows.nth(2)).toContainText('invoice.created');
    await expect(bodyRows.nth(3)).toContainText('customer.created');
    await context.close();
  });

  test('[cp4.40][R4.6][C5] import and audit pages: accessible names (file inputs included) and import errors in role="alert"', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    await createCustomer(owner, org.id);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/import`);
    await expectAccessibleNames(page, 'import page');
    await uploadText(page, 'Invoices CSV', 'bad.csv', `${INVOICE_HEADER}\nA,${uniqEmail('ghost')},2031-01-31,X,1,1,0\n`);
    await button(page, 'Import invoices').click();
    await expect(alerts(page).filter({ hasText: /Nothing was imported/ })).toBeVisible();
    await page.goto(`/orgs/${org.id}/audit`);
    await expect(page.getByRole('columnheader', { name: 'Action', exact: true })).toBeVisible();
    await expectAccessibleNames(page, 'audit page');
    await context.close();
  });
});

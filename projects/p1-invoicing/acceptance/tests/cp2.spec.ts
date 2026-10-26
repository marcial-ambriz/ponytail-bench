/** UI acceptance, checkpoint 2 (C1 + C5): customers, invoice form, invoice page (spec/cp2.md). */
import { expect, test, type Page } from '@playwright/test';
import {
  action,
  addDays,
  alerts,
  button,
  chooseLabel,
  confirmIn,
  createCustomer,
  createDraft,
  dialog,
  disableNativeValidation,
  expectAccessibleNames,
  expectColumnHeaders,
  expectDialogFocusAndEscape,
  field,
  forbidNativeDialogs,
  getInvoice,
  issuedInvoice,
  line,
  moneyText,
  optionLabels,
  orgNav,
  ownerWithOrg,
  pageFor,
  row,
  team,
  todayUtc,
  uniq,
  uniqEmail,
} from '../../support';

async function fillLine(page: Page, n: number, l: { description: string; quantity: string; price: string; rate: string }) {
  await field(page, `Description ${n}`).fill(l.description);
  await field(page, `Quantity ${n}`).fill(l.quantity);
  await field(page, `Unit price ${n}`).fill(l.price);
  await field(page, `Tax rate ${n}`).fill(l.rate);
}

const INVOICE_URL = (orgId: string) => new RegExp(`/orgs/${orgId}/invoices/(?!new)([^/]+)/?$`);

test.describe('Checkpoint 2 - customers', () => {
  test('[cp2.01][R2.4] customers page: "No customers yet", "New customer" dialog creates one, table "Name" / "Email"', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}`);
    await orgNav(page).getByRole('link', { name: 'Customers', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/customers/?$`));
    await expect(page.getByText('No customers yet')).toBeVisible();
    await button(page, 'New customer').click();
    const dlg = dialog(page);
    const name = uniq('Client');
    const email = uniqEmail('client');
    await field(dlg, 'Name').fill(name);
    await field(dlg, 'Email').fill(email);
    await button(dlg, 'Save').click();
    await expect(dlg).toBeHidden();
    await expectColumnHeaders(page, ['Name', 'Email']);
    await expect(row(page, name)).toContainText(email);
    const list = (await (await owner.get(`/api/orgs/${org.id}/customers`)).json()) as any[];
    expect(list.map((c) => c.email)).toEqual([email]);
    await context.close();
  });

  test('[cp2.02][R2.4] "Edit" opens the dialog prefilled and saves; "Delete" asks "Confirm delete" in-page and removes the customer', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const { context, page } = await pageFor(browser, owner);
    const native = forbidNativeDialogs(page);
    await page.goto(`/orgs/${org.id}/customers`);
    await button(row(page, c.name), 'Edit').click();
    const dlg = dialog(page);
    await expect(field(dlg, 'Name')).toHaveValue(c.name);
    await expect(field(dlg, 'Email')).toHaveValue(c.email);
    const renamed = uniq('Renamed');
    await field(dlg, 'Name').fill(renamed);
    await button(dlg, 'Save').click();
    await expect(row(page, renamed)).toBeVisible();
    expect((await (await owner.get(`/api/orgs/${org.id}/customers/${c.id}`)).json()).name).toBe(renamed);
    await confirmIn(page, button(row(page, renamed), 'Delete'), 'Confirm delete');
    await expect(row(page, renamed)).toHaveCount(0);
    await expect(page.getByText('No customers yet')).toBeVisible();
    expect(native.used).toBe(false);
    expect((await owner.get(`/api/orgs/${org.id}/customers/${c.id}`)).status()).toBe(404);
    await context.close();
  });

  test('[cp2.03][R2.4] a duplicate email is rejected: the dialog stays open with the input and shows the error', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/customers`);
    await button(page, 'New customer').click();
    const dlg = dialog(page);
    await field(dlg, 'Name').fill('Second');
    await field(dlg, 'Email').fill(c.email.toUpperCase());
    await button(dlg, 'Save').click();
    await expect(alerts(dlg).first()).toBeVisible();
    await expect(dlg).toBeVisible();
    await expect(field(dlg, 'Name')).toHaveValue('Second');
    expect(((await (await owner.get(`/api/orgs/${org.id}/customers`)).json()) as any[]).length).toBe(1);
    await context.close();
  });

  test('[cp2.04][R2.4] viewers see customers without "New customer", "Edit" or "Delete"', async ({ browser, playwright }) => {
    const t = await team(playwright);
    const c = await createCustomer(t.owner, t.org.id);
    const { context, page } = await pageFor(browser, t.viewer);
    await page.goto(`/orgs/${t.org.id}/customers`);
    await expect(row(page, c.name)).toBeVisible();
    await expect(button(page, 'New customer')).toHaveCount(0);
    await expect(button(page, 'Edit')).toHaveCount(0);
    await expect(button(page, 'Delete')).toHaveCount(0);
    await context.close();
  });
});

test.describe('Checkpoint 2 - invoices', () => {
  test('[cp2.05][R2.13] invoices page: "No invoices yet", then a table "Number", "Customer", "Status", "Due date", "Total", "Balance"', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}`);
    await orgNav(page).getByRole('link', { name: 'Invoices', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/invoices/?$`));
    await expect(page.getByText('No invoices yet')).toBeVisible();
    await issuedInvoice(owner, org.id);
    await page.reload();
    await expectColumnHeaders(page, ['Number', 'Customer', 'Status', 'Due date', 'Total', 'Balance']);
    await context.close();
  });

  test('[cp2.06][R2.14][R1.3] "New invoice" with decimal prices and rates saves a draft whose amounts are exact to the cent', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id, { name: uniq('Exact') });
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices`);
    await action(page, 'New invoice').click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/invoices/new/?$`));
    await chooseLabel(field(page, 'Customer'), c.name);
    const due = addDays(todayUtc(), 20);
    await field(page, 'Due date').fill(due);
    await field(page, 'Notes').fill('Net 20');
    await fillLine(page, 1, { description: 'Design', quantity: '3', price: '19.99', rate: '8.25' });
    await button(page, 'Add line').click();
    await fillLine(page, 2, { description: 'Hosting', quantity: '1', price: '0.29', rate: '16' });
    await button(page, 'Add line').click();
    await fillLine(page, 3, { description: 'Support', quantity: '10', price: '1234.5', rate: '0' });
    await button(page, 'Save draft').click();
    await expect(page).toHaveURL(INVOICE_URL(org.id));
    const id = INVOICE_URL(org.id).exec(new URL(page.url()).pathname)![1]!;
    const inv = await getInvoice(owner, org.id, id);
    expect(inv.lines.map((l: any) => [l.description, l.quantity, l.unitPriceCents, l.taxRateBps])).toEqual([
      ['Design', 3, 1999, 825],
      ['Hosting', 1, 29, 1600],
      ['Support', 10, 123450, 0],
    ]);
    expect(inv).toMatchObject({ status: 'draft', dueDate: due, notes: 'Net 20', subtotalCents: 1_240_526, taxCents: 500, totalCents: 1_241_026 });
    await expect(moneyText(page, 'Total', 1_241_026)).toBeVisible();
    await context.close();
  });

  test('[cp2.07][R2.14] an amount with three decimals is reported as an error and nothing is saved', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/new`);
    await disableNativeValidation(page);
    await chooseLabel(field(page, 'Customer'), c.name);
    await field(page, 'Due date').fill(addDays(todayUtc(), 5));
    await fillLine(page, 1, { description: 'Bad price', quantity: '1', price: '10.005', rate: '0' });
    await button(page, 'Save draft').click();
    await expect(alerts(page).first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/invoices/new/?$`));
    await expect(field(page, 'Unit price 1')).toHaveValue('10.005');
    expect(await (await owner.get(`/api/orgs/${org.id}/invoices`)).json()).toEqual([]);
    await context.close();
  });

  test('[cp2.08][R2.14] "Add line" adds numbered line fields and "Remove line N" removes that line', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/new`);
    await chooseLabel(field(page, 'Customer'), c.name);
    await field(page, 'Due date').fill(addDays(todayUtc(), 5));
    await fillLine(page, 1, { description: 'Keep A', quantity: '1', price: '1', rate: '0' });
    await button(page, 'Add line').click();
    await fillLine(page, 2, { description: 'Drop me', quantity: '1', price: '2', rate: '0' });
    await button(page, 'Add line').click();
    await fillLine(page, 3, { description: 'Keep B', quantity: '1', price: '3', rate: '0' });
    await button(page, 'Remove line 2').click();
    await expect(field(page, 'Description 3')).toHaveCount(0);
    await expect(field(page, 'Description 2')).toHaveValue('Keep B');
    await button(page, 'Save draft').click();
    await expect(page).toHaveURL(INVOICE_URL(org.id));
    const list = (await (await owner.get(`/api/orgs/${org.id}/invoices`)).json()) as any[];
    const inv = await getInvoice(owner, org.id, String(list[0].id));
    expect(inv.lines.map((l: any) => l.description)).toEqual(['Keep A', 'Keep B']);
    expect(inv.totalCents).toBe(400);
    await context.close();
  });

  test('[cp2.09][R2.15] a draft\'s page: "Draft invoice", status, customer, due date, lines table and formatted totals', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id, { name: uniq('Page Client') });
    const due = addDays(todayUtc(), 9);
    const d = await createDraft(owner, org.id, c.id, [line(123_456, 2, 1600, 'Big work'), line(5, 1, 1000, 'Tiny')], due);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${d.id}`);
    await expect(page.getByRole('heading', { name: 'Draft invoice' })).toBeVisible();
    await expect(page.getByText('Status: Draft')).toBeVisible();
    await expect(page.getByText(`Customer: ${c.name}`)).toBeVisible();
    await expect(page.getByText(`Due date: ${due}`)).toBeVisible();
    await expectColumnHeaders(page, ['Description', 'Quantity', 'Unit price', 'Tax', 'Amount']);
    const big = row(page, 'Big work');
    await expect(big).toContainText('$1,234.56');
    await expect(big).toContainText('$395.06');
    await expect(big).toContainText('$2,864.18');
    // 246912 + 5 = 246917 ; tax 39505.92 -> 39506, 0.5 -> 1 ; total 286424
    await expect(moneyText(page, 'Subtotal', 246_917)).toBeVisible();
    await expect(moneyText(page, 'Tax', 39_507)).toBeVisible();
    await expect(moneyText(page, 'Total', 286_424)).toBeVisible();
    await expect(moneyText(page, 'Paid', 0)).toBeVisible();
    await expect(moneyText(page, 'Balance', 286_424)).toBeVisible();
    await context.close();
  });

  test('[cp2.10][R2.16] "Issue invoice" -> "Confirm issue" shows "Invoice issued", the number and "Status: Issued"', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const d = await createDraft(owner, org.id, c.id);
    const { context, page } = await pageFor(browser, owner);
    const native = forbidNativeDialogs(page);
    await page.goto(`/orgs/${org.id}/invoices/${d.id}`);
    await confirmIn(page, button(page, 'Issue invoice'), 'Confirm issue');
    await expect(page.getByText('Invoice issued')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'INV-0001' })).toBeVisible();
    await expect(page.getByText('Status: Issued')).toBeVisible();
    await expect(button(page, 'Issue invoice')).toHaveCount(0);
    await expect(button(page, 'Edit').or(page.getByRole('link', { name: 'Edit', exact: true }))).toHaveCount(0);
    expect(native.used).toBe(false);
    expect((await getInvoice(owner, org.id, d.id)).number).toBe('INV-0001');
    await context.close();
  });

  test('[cp2.11][R2.16] "Edit" opens the prefilled form; "Save draft" stores the change and the totals update', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const d = await createDraft(owner, org.id, c.id, [line(2500, 2, 0, 'Hours')]);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${d.id}`);
    await action(page, 'Edit').click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/invoices/${d.id}/edit/?$`));
    await expect(field(page, 'Description 1')).toHaveValue('Hours');
    await expect(field(page, 'Quantity 1')).toHaveValue('2');
    await expect(field(page, 'Unit price 1')).toHaveValue(/^25(\.00?)?$/);
    await field(page, 'Quantity 1').fill('5');
    await button(page, 'Save draft').click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/invoices/${d.id}/?$`));
    await expect(moneyText(page, 'Total', 12_500)).toBeVisible();
    expect((await getInvoice(owner, org.id, d.id)).totalCents).toBe(12_500);
    await context.close();
  });

  test('[cp2.12][R2.16] "Delete draft" -> "Confirm delete" removes the draft and returns to the invoice list', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const d = await createDraft(owner, org.id, c.id);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${d.id}`);
    await confirmIn(page, button(page, 'Delete draft'), 'Confirm delete');
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/invoices/?$`));
    await expect(page.getByText('No invoices yet')).toBeVisible();
    expect((await owner.get(`/api/orgs/${org.id}/invoices/${d.id}`)).status()).toBe(404);
    await context.close();
  });

  test('[cp2.13][R2.16] "Void invoice" -> "Confirm void" shows "Status: Void"', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${invoice.id}`);
    await confirmIn(page, button(page, 'Void invoice'), 'Confirm void');
    await expect(page.getByText('Status: Void')).toBeVisible();
    await expect(button(page, 'Void invoice')).toHaveCount(0);
    expect((await getInvoice(owner, org.id, invoice.id)).status).toBe('void');
    await context.close();
  });

  test('[cp2.14][R2.13] list rows: the number (or "Draft") links to the invoice, statuses and amounts are formatted, "Status" filters on change', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const issued = await issuedInvoice(owner, org.id, [line(123_456)]);
    const c = await createCustomer(owner, org.id, { name: uniq('Drafty') });
    const draft = await createDraft(owner, org.id, c.id, [line(500)]);
    const v = await issuedInvoice(owner, org.id, [line(700)]);
    await owner.post(`/api/orgs/${org.id}/invoices/${v.invoice.id}/void`);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices`);
    const issuedRow = row(page, 'INV-0001');
    await expect(issuedRow).toContainText(issued.customer.name);
    await expect(issuedRow).toContainText('Issued');
    await expect(issuedRow).toContainText('$1,234.56');
    await expect(issuedRow).toContainText(issued.invoice.dueDate);
    const draftRow = row(page, c.name);
    await expect(draftRow.getByRole('link', { name: 'Draft', exact: true })).toBeVisible();
    await expect(row(page, 'INV-0002')).toContainText('Void');
    const status = field(page, 'Status');
    expect(await optionLabels(status)).toEqual(['All', 'Draft', 'Issued', 'Paid', 'Void']);
    await chooseLabel(status, 'Draft');
    await expect(row(page, 'INV-0001')).toHaveCount(0);
    await expect(row(page, c.name)).toBeVisible();
    await chooseLabel(status, 'Void');
    await expect(row(page, 'INV-0002')).toBeVisible();
    await expect(row(page, c.name)).toHaveCount(0);
    await chooseLabel(status, 'All');
    await page.getByRole('link', { name: 'INV-0001', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/invoices/${issued.invoice.id}/?$`));
    await page.goBack();
    await row(page, c.name).getByRole('link', { name: 'Draft', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/invoices/${draft.id}/?$`));
    await context.close();
  });

  test('[cp2.15][R2.16] viewers see invoices without "New invoice", "Edit", "Issue invoice", "Delete draft" or "Void invoice"', async ({ browser, playwright }) => {
    const t = await team(playwright);
    const c = await createCustomer(t.owner, t.org.id);
    const d = await createDraft(t.owner, t.org.id, c.id);
    const { invoice } = await issuedInvoice(t.owner, t.org.id);
    const { context, page } = await pageFor(browser, t.viewer);
    await page.goto(`/orgs/${t.org.id}/invoices`);
    await expect(row(page, 'INV-0001')).toBeVisible();
    await expect(action(page, 'New invoice')).toHaveCount(0);
    await page.goto(`/orgs/${t.org.id}/invoices/${d.id}`);
    await expect(page.getByText('Status: Draft')).toBeVisible();
    for (const name of ['Edit', 'Issue invoice', 'Delete draft']) await expect(action(page, name)).toHaveCount(0);
    await page.goto(`/orgs/${t.org.id}/invoices/${invoice.id}`);
    await expect(page.getByText('Status: Issued')).toBeVisible();
    await expect(action(page, 'Void invoice')).toHaveCount(0);
    await context.close();
  });

  test('[cp2.16][R2.16] an unknown or another organization\'s invoice shows "Invoice not found"', async ({ browser, playwright }) => {
    const victim = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(victim.owner, victim.org.id);
    const { owner, org } = await ownerWithOrg(playwright);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${invoice.id}`);
    await expect(page.getByText('Invoice not found')).toBeVisible();
    await expect(page.getByText(/INV-0001/)).toHaveCount(0);
    await context.close();
  });

  test('[cp2.40][R2.4][C5] customer dialog: focus inside and Escape; server error in role="alert"; accessible names', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/customers`);
    await expectAccessibleNames(page, 'customers page');
    await expectDialogFocusAndEscape(page, () => button(page, 'New customer').click(), 'New customer');
    await expectDialogFocusAndEscape(page, () => button(row(page, c.name), 'Edit').click(), 'Edit customer');
    await expectDialogFocusAndEscape(page, () => button(row(page, c.name), 'Delete').click(), 'Delete customer');
    await button(page, 'New customer').click();
    const dlg = dialog(page);
    await expectAccessibleNames(page, 'customer dialog');
    await disableNativeValidation(page);
    await field(dlg, 'Name').fill('Dup');
    await field(dlg, 'Email').fill(c.email);
    await button(dlg, 'Save').click();
    await expect(alerts(dlg).first()).toBeVisible();
    await context.close();
  });

  test('[cp2.41][R2.14][C5] invoice form and invoice page: accessible names; the issue dialog takes focus and closes with Escape', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const d = await createDraft(owner, org.id, c.id);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/new`);
    await button(page, 'Add line').click();
    await expectAccessibleNames(page, 'invoice form');
    await page.goto(`/orgs/${org.id}/invoices/${d.id}`);
    await expectAccessibleNames(page, 'invoice page');
    await expectDialogFocusAndEscape(page, () => button(page, 'Issue invoice').click(), 'Issue dialog');
    expect((await getInvoice(owner, org.id, d.id)).status, 'Escape does not issue').toBe('draft');
    await context.close();
  });
});

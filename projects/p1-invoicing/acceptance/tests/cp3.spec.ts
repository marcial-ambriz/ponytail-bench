/** UI acceptance, checkpoint 3 (C1 + C5): payments on the invoice page and webhook settings (spec/cp3.md). */
import { expect, test } from '@playwright/test';
import {
  action,
  alerts,
  anonApi,
  button,
  chooseLabel,
  confirmIn,
  createCustomer,
  createDraft,
  deliver,
  dialog,
  disableNativeValidation,
  expectAccessibleNames,
  expectColumnHeaders,
  expectDialogFocusAndEscape,
  field,
  getInvoice,
  issuedInvoice,
  line,
  moneyText,
  optionLabels,
  orgNav,
  ownerWithOrg,
  pageFor,
  pay,
  payflowEvent,
  payments,
  row,
  team,
  todayUtc,
  webhookSecret,
} from '../../support';

test.describe('Checkpoint 3 - payments', () => {
  test('[cp3.01][R3.13] "Record payment" (Amount, Method, Date, Reference) -> "Payment recorded"; Paid and Balance update', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${invoice.id}`);
    await button(page, 'Record payment').click();
    const dlg = dialog(page);
    await expect(field(dlg, 'Date')).toHaveValue(todayUtc());
    const method = field(dlg, 'Method');
    expect(await optionLabels(method)).toEqual(['Bank transfer', 'Cash', 'Card', 'Other']);
    await field(dlg, 'Amount').fill('40.1');
    await chooseLabel(method, 'Cash');
    await field(dlg, 'Date').fill('2031-03-04');
    await field(dlg, 'Reference').fill('Receipt 77');
    await button(dlg, 'Save payment').click();
    await expect(page.getByText('Payment recorded')).toBeVisible();
    await expect(moneyText(page, 'Paid', 4010)).toBeVisible();
    await expect(moneyText(page, 'Balance', 5990)).toBeVisible();
    const list = await payments(owner, org.id, invoice.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ amountCents: 4010, method: 'cash', paidAt: '2031-03-04', reference: 'Receipt 77', source: 'manual' });
    await context.close();
  });

  test('[cp3.02][R3.13] a payment above the balance shows the server error ("exceeds") in the dialog and keeps the input', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(5_000)]);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${invoice.id}`);
    await button(page, 'Record payment').click();
    const dlg = dialog(page);
    await disableNativeValidation(page);
    await field(dlg, 'Amount').fill('50.01');
    await button(dlg, 'Save payment').click();
    await expect(dlg.getByText(/exceeds/i)).toBeVisible();
    await expect(dlg).toBeVisible();
    await expect(field(dlg, 'Amount')).toHaveValue('50.01');
    expect(await payments(owner, org.id, invoice.id)).toHaveLength(0);
    await context.close();
  });

  test('[cp3.03][R3.14] the "Payments" section shows "No payments yet", then a table "Date", "Amount", "Method", "Source", "Status"', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${invoice.id}`);
    await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();
    await expect(page.getByText('No payments yet')).toBeVisible();
    await pay(owner, org.id, invoice.id, 1234, { method: 'card', paidAt: '2031-01-02' });
    await page.reload();
    await expectColumnHeaders(page, ['Date', 'Amount', 'Method', 'Source', 'Status']);
    const r = row(page, '2031-01-02');
    await expect(r).toContainText('$12.34');
    await expect(r).toContainText('Card');
    await expect(r).toContainText('Manual');
    await expect(r).toContainText('Received');
    await context.close();
  });

  test('[cp3.04][R3.14][R3.2] paying the full balance shows "Status: Paid", removes "Record payment" and the list shows "Paid"', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(2_000)]);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${invoice.id}`);
    await button(page, 'Record payment').click();
    await field(dialog(page), 'Amount').fill('20');
    await button(dialog(page), 'Save payment').click();
    await expect(page.getByText('Status: Paid')).toBeVisible();
    await expect(moneyText(page, 'Balance', 0)).toBeVisible();
    await expect(button(page, 'Record payment')).toHaveCount(0);
    await expect(button(page, 'Void invoice')).toHaveCount(0);
    await page.goto(`/orgs/${org.id}/invoices`);
    await expect(row(page, invoice.number)).toContainText('Paid');
    await context.close();
  });

  test('[cp3.05][R3.14] PayFlow payments are listed with Source "PayFlow"; a refunded one shows Status "Refunded"', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const created = Math.floor(Date.UTC(2031, 0, 5, 12) / 1000);
    const kept = payflowEvent('payment.succeeded', invoice.id, 1500, { created });
    const gone = payflowEvent('payment.succeeded', invoice.id, 2500, { created: created + 86_400 });
    await deliver(anon, org.id, secret, kept);
    await deliver(anon, org.id, secret, gone);
    await deliver(anon, org.id, secret, payflowEvent('payment.refunded', invoice.id, 2500, { paymentId: gone.data.paymentId }));
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${invoice.id}`);
    const a = row(page, '2031-01-05');
    await expect(a).toContainText('PayFlow');
    await expect(a).toContainText('Received');
    const b = row(page, '2031-01-06');
    await expect(b).toContainText('PayFlow');
    await expect(b).toContainText('Refunded');
    await expect(moneyText(page, 'Paid', 1500)).toBeVisible();
    await context.close();
  });

  test('[cp3.06][R3.13] viewers have no "Record payment"; drafts have none either', async ({ browser, playwright }) => {
    const t = await team(playwright);
    const { invoice } = await issuedInvoice(t.owner, t.org.id);
    const c = await createCustomer(t.owner, t.org.id);
    const d = await createDraft(t.owner, t.org.id, c.id);
    const viewer = await pageFor(browser, t.viewer);
    await viewer.page.goto(`/orgs/${t.org.id}/invoices/${invoice.id}`);
    await expect(viewer.page.getByText('Status: Issued')).toBeVisible();
    await expect(button(viewer.page, 'Record payment')).toHaveCount(0);
    await viewer.context.close();
    const acc = await pageFor(browser, t.accountant);
    await acc.page.goto(`/orgs/${t.org.id}/invoices/${d.id}`);
    await expect(acc.page.getByText('Status: Draft')).toBeVisible();
    await expect(button(acc.page, 'Record payment')).toHaveCount(0);
    await acc.page.goto(`/orgs/${t.org.id}/invoices/${invoice.id}`);
    await expect(button(acc.page, 'Record payment')).toBeVisible();
    await acc.context.close();
  });
});

test.describe('Checkpoint 3 - settings', () => {
  test('[cp3.07][R3.15] owners: "Settings" shows "Webhook", the full URL and the secret; "Rotate secret" -> "Confirm rotate" -> "Secret rotated" and the new secret', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const before = await webhookSecret(owner, org.id);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}`);
    await orgNav(page).getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/settings/?$`));
    await expect(page.getByRole('heading', { name: 'Webhook' })).toBeVisible();
    const origin = new URL(page.url()).origin;
    await expect(page.getByText(`${origin}/api/webhooks/payflow/${org.id}`)).toBeVisible();
    await expect(page.getByText(before)).toBeVisible();
    await confirmIn(page, button(page, 'Rotate secret'), 'Confirm rotate');
    await expect(page.getByText('Secret rotated')).toBeVisible();
    const after = await webhookSecret(owner, org.id);
    expect(after).not.toBe(before);
    await expect(page.getByText(after)).toBeVisible();
    await expect(page.getByText(before)).toHaveCount(0);
    await context.close();
  });

  test('[cp3.08][R3.15] non-owners have no "Settings" link and visiting it shows "Only owners can manage settings" without the secret', async ({ browser, playwright }) => {
    const t = await team(playwright);
    const secret = await webhookSecret(t.owner, t.org.id);
    for (const who of [t.accountant, t.viewer]) {
      const { context, page } = await pageFor(browser, who);
      await page.goto(`/orgs/${t.org.id}`);
      await expect(orgNav(page)).toBeVisible();
      await expect(orgNav(page).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
      await page.goto(`/orgs/${t.org.id}/settings`);
      await expect(page.getByText('Only owners can manage settings')).toBeVisible();
      await expect(page.getByText(secret)).toHaveCount(0);
      await context.close();
    }
  });

  test('[cp3.40][R3.13][C5] payment dialog: focus inside, Escape closes, server error in role="alert", accessible names', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(1_000)]);
    await pay(owner, org.id, invoice.id, 100);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${invoice.id}`);
    await expectAccessibleNames(page, 'invoice page with payments');
    await expectDialogFocusAndEscape(page, () => button(page, 'Record payment').click(), 'Record payment');
    await button(page, 'Record payment').click();
    const dlg = dialog(page);
    await expectAccessibleNames(page, 'payment dialog');
    await disableNativeValidation(page);
    await field(dlg, 'Amount').fill('1000');
    await button(dlg, 'Save payment').click();
    await expect(alerts(dlg).filter({ hasText: /exceeds/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto(`/orgs/${org.id}/settings`);
    await expectAccessibleNames(page, 'settings');
    await expectDialogFocusAndEscape(page, () => button(page, 'Rotate secret').click(), 'Rotate dialog');
    expect((await getInvoice(owner, org.id, invoice.id)).paidCents).toBe(100);
    expect(action).toBeTruthy();
    await context.close();
  });
});

/** Hidden tests for the maintenance feature (maintenance/task.md: credit notes). Tag: [mt.MM][M1.x]. */
import { expect, test } from '@playwright/test';
import {
  addDays,
  anonApi,
  auditEntries,
  button,
  createCustomer,
  createDraft,
  deliver,
  dialog,
  expectStatus,
  field,
  getInvoice,
  issuedInvoice,
  line,
  moneyText,
  ownerWithOrg,
  pageFor,
  pay,
  payflowEvent,
  readCsv,
  row,
  team,
  todayUtc,
  webhookSecret,
  type Api,
} from '../../support';

const credit = (api: Api, orgId: string, invoiceId: string, amountCents: unknown, reason: unknown = 'Partial refund') =>
  api.post(`/api/orgs/${orgId}/invoices/${invoiceId}/credit-notes`, { amountCents, reason });

test.describe('Maintenance - credit notes', () => {
  test('[mt.01][M1.1] POST credit-notes -> 201 { id, number, invoiceId, amountCents, reason, createdAt } and validation -> 422', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    const cn = await expectStatus(await credit(owner, org.id, invoice.id, 2_500, '  Damaged item  '), 201, 'credit note');
    expect(cn).toMatchObject({ number: 'CN-0001', amountCents: 2_500, reason: 'Damaged item' });
    expect(String(cn.invoiceId)).toBe(invoice.id);
    expect(cn.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(cn.createdAt))).toBe(false);
    for (const [label, amount, reason] of [
      ['zero', 0, 'x'],
      ['negative', -1, 'x'],
      ['fractional', 1.5, 'x'],
      ['string', '100', 'x'],
      ['empty reason', 100, '   '],
      ['long reason', 100, 'r'.repeat(201)],
    ] as const) {
      await expectStatus(await credit(owner, org.id, invoice.id, amount, reason), 422, label);
    }
    const over = await credit(owner, org.id, invoice.id, 7_501);
    await expectStatus(over, 422, 'above the balance');
    expect(String((await over.json()).error).toLowerCase()).toContain('exceeds');
  });

  test('[mt.02][M1.1] only issued invoices with a balance; viewers -> 403; non-members -> 404', async ({ playwright }) => {
    const t = await team(playwright);
    const c = await createCustomer(t.owner, t.org.id);
    const draft = await createDraft(t.owner, t.org.id, c.id);
    await expectStatus(await credit(t.owner, t.org.id, draft.id, 100), 422, 'draft');
    const paid = await issuedInvoice(t.owner, t.org.id, [line(1_000)]);
    await pay(t.owner, t.org.id, paid.invoice.id, 1_000);
    await expectStatus(await credit(t.owner, t.org.id, paid.invoice.id, 100), 422, 'paid');
    const { invoice } = await issuedInvoice(t.owner, t.org.id, [line(5_000)]);
    await expectStatus(await credit(t.viewer, t.org.id, invoice.id, 100), 403, 'viewer');
    const { owner: stranger, org: strangerOrg } = await ownerWithOrg(playwright);
    await expectStatus(await credit(stranger, t.org.id, invoice.id, 100), 404, 'non-member');
    await expectStatus(await credit(stranger, strangerOrg.id, invoice.id, 100), 404, "other organization's invoice via own path");
    await expectStatus(await credit(t.accountant, t.org.id, invoice.id, 100), 201, 'accountant');
    expect((await getInvoice(t.owner, t.org.id, invoice.id)).creditedCents).toBe(100);
  });

  test('[mt.03][M1.3] credits reduce the balance, limit later payments and can bring the invoice to "paid"', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    expect((await getInvoice(owner, org.id, invoice.id)).creditedCents).toBe(0);
    await expectStatus(await credit(owner, org.id, invoice.id, 3_000), 201, 'credit');
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ creditedCents: 3_000, paidCents: 0, balanceCents: 7_000, status: 'issued' });
    await expectStatus(await pay(owner, org.id, invoice.id, 7_001), 422, 'payment above the new balance');
    await expectStatus(await pay(owner, org.id, invoice.id, 5_000), 201, 'payment');
    await expectStatus(await credit(owner, org.id, invoice.id, 2_000), 201, 'credit the rest');
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ creditedCents: 5_000, paidCents: 5_000, balanceCents: 0, status: 'paid' });
    const secret = await webhookSecret(owner, org.id);
    await expectStatus(await deliver(await anonApi(playwright), org.id, secret, payflowEvent('payment.succeeded', invoice.id, 1)), 422, 'webhook on a credited, paid invoice');
  });

  test('[mt.04][M1.2] CN numbers are per organization and stay consecutive under simultaneous requests', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(100_000)]);
    const results = await Promise.all(Array.from({ length: 15 }, () => credit(owner, org.id, invoice.id, 100)));
    expect(results.map((r) => r.status())).toEqual(Array(15).fill(201));
    const numbers = (await Promise.all(results.map((r) => r.json()))).map((b: any) => b.number).sort();
    expect(numbers).toEqual(Array.from({ length: 15 }, (_, i) => `CN-${String(i + 1).padStart(4, '0')}`));
    const other = await ownerWithOrg(playwright);
    const theirs = await issuedInvoice(other.owner, other.org.id, [line(1_000)]);
    expect((await expectStatus(await credit(other.owner, other.org.id, theirs.invoice.id, 100), 201, 'other org')).number).toBe('CN-0001');
  });

  test('[mt.05][M1.3] simultaneous credit notes and payments never push the balance below zero', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    const reqs = Array.from({ length: 40 }, (_, i) => (i % 2 ? credit(owner, org.id, invoice.id, 700) : pay(owner, org.id, invoice.id, 700)));
    const results = await Promise.all(reqs);
    expect(results.filter((r) => r.status() >= 500)).toHaveLength(0);
    const after = await getInvoice(owner, org.id, invoice.id);
    expect(after.balanceCents).toBeGreaterThanOrEqual(0);
    expect(after.paidCents + after.creditedCents).toBe(14 * 700);
    expect(results.filter((r) => r.status() === 201)).toHaveLength(14);
  });

  test('[mt.06][M1.4] GET credit-notes lists them oldest first', async ({ playwright }) => {
    const t = await team(playwright);
    const { invoice } = await issuedInvoice(t.owner, t.org.id, [line(10_000)]);
    await credit(t.owner, t.org.id, invoice.id, 100, 'first');
    await credit(t.accountant, t.org.id, invoice.id, 200, 'second');
    const list = await expectStatus(await t.viewer.get(`/api/orgs/${t.org.id}/invoices/${invoice.id}/credit-notes`), 200, 'GET');
    expect(list.map((c: any) => [c.number, c.amountCents, c.reason])).toEqual([
      ['CN-0001', 100, 'first'],
      ['CN-0002', 200, 'second'],
    ]);
  });

  test('[mt.07][M1.5][M1.6] an invoice with credit notes cannot be voided; credit notes are audited', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    const cn = await expectStatus(await credit(owner, org.id, invoice.id, 500), 201, 'credit');
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices/${invoice.id}/void`), 422, 'void');
    expect((await getInvoice(owner, org.id, invoice.id)).status).toBe('issued');
    const entries = await auditEntries(owner, org.id);
    const e = entries.find((x) => x.action === 'credit_note.created');
    expect(e).toBeTruthy();
    expect(e).toMatchObject({ entityType: 'credit_note', actorName: owner.user!.name });
    expect(String(e!.entityId)).toBe(String(cn.id));
    await credit(owner, org.id, invoice.id, 999_999);
    expect((await auditEntries(owner, org.id)).length, 'a rejected credit note is not audited').toBe(entries.length);
  });

  test('[mt.08][M1.7] dashboard and export use the credited balance', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)], addDays(todayUtc(), -10));
    await credit(owner, org.id, invoice.id, 2_500);
    await pay(owner, org.id, invoice.id, 1_000);
    const d = await expectStatus(await owner.get(`/api/orgs/${org.id}/dashboard`), 200, 'dashboard');
    expect(d.receivableCents).toBe(6_500);
    expect(d.aging.days1to30Cents).toBe(6_500);
    const rows = readCsv(await (await owner.get(`/api/orgs/${org.id}/exports/invoices.csv`)).text());
    expect(rows[0]).toEqual(['number', 'customer', 'status', 'issue_date', 'due_date', 'subtotal', 'tax', 'total', 'paid', 'balance']);
    expect(rows[1]!.slice(5)).toEqual(['100.00', '0.00', '100.00', '10.00', '65.00']);
  });

  test('[mt.09][M1.8] "Issue credit note" dialog ("Amount", "Reason", "Save credit note") -> "Credit note issued", "Credited" and the "Credit notes" table', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/invoices/${invoice.id}`);
    await expect(page.getByRole('heading', { name: 'Credit notes' })).toBeVisible();
    await expect(page.getByText('No credit notes yet')).toBeVisible();
    await button(page, 'Issue credit note').click();
    const dlg = dialog(page);
    await field(dlg, 'Amount').fill('120');
    await field(dlg, 'Reason').fill('Too much');
    await button(dlg, 'Save credit note').click();
    await expect(dlg.getByText(/exceeds/i)).toBeVisible();
    await field(dlg, 'Amount').fill('12.5');
    await button(dlg, 'Save credit note').click();
    await expect(page.getByText('Credit note issued')).toBeVisible();
    await expect(moneyText(page, 'Credited', 1_250)).toBeVisible();
    await expect(moneyText(page, 'Balance', 8_750)).toBeVisible();
    for (const h of ['Number', 'Date', 'Amount', 'Reason']) await expect(page.getByRole('columnheader', { name: h, exact: true }).first()).toBeVisible();
    await expect(row(page, 'CN-0001')).toContainText('$12.50');
    await expect(row(page, 'CN-0001')).toContainText('Too much');
    await context.close();
  });

  test('[mt.10][M1.8] viewers see credit notes but no "Issue credit note" button', async ({ browser, playwright }) => {
    const t = await team(playwright);
    const { invoice } = await issuedInvoice(t.owner, t.org.id, [line(10_000)]);
    await credit(t.owner, t.org.id, invoice.id, 300, 'Goodwill');
    const { context, page } = await pageFor(browser, t.viewer);
    await page.goto(`/orgs/${t.org.id}/invoices/${invoice.id}`);
    await expect(row(page, 'CN-0001')).toContainText('Goodwill');
    await expect(button(page, 'Issue credit note')).toHaveCount(0);
    await context.close();
  });
});

/** UI acceptance, checkpoint 5 (C1 + C5): dashboard and export (spec/cp5.md). */
import { expect, test } from '@playwright/test';
import {
  action,
  addDays,
  expectAccessibleNames,
  expectColumnHeaders,
  issuedInvoice,
  line,
  moneyText,
  orgNav,
  ownerWithOrg,
  pageFor,
  pay,
  readCsv,
  row,
  team,
  todayUtc,
} from '../../support';

async function seededOrg(playwright: Parameters<typeof ownerWithOrg>[0]) {
  const t = await team(playwright);
  const today = todayUtc();
  await issuedInvoice(t.owner, t.org.id, [line(100_000)], addDays(today, 10)); // current 1,000.00
  await issuedInvoice(t.owner, t.org.id, [line(20_000)], addDays(today, -5)); // 1-30 200.00
  await issuedInvoice(t.owner, t.org.id, [line(3_000)], addDays(today, -45)); // 31-60 30.00
  await issuedInvoice(t.owner, t.org.id, [line(400)], addDays(today, -75)); // 61-90 4.00
  const old = await issuedInvoice(t.owner, t.org.id, [line(150_050)], addDays(today, -120)); // over 90: 1,500.50 - 500.25
  await pay(t.owner, t.org.id, old.invoice.id, 50_025);
  return t;
}

test.describe('Checkpoint 5 - dashboard', () => {
  test('[cp5.01][R5.5] the organization home is the dashboard: "Receivable", "Overdue" and "Collected this month" for today', async ({ browser, playwright }) => {
    const t = await seededOrg(playwright);
    const { context, page } = await pageFor(browser, t.viewer);
    await page.goto(`/orgs/${t.org.id}/members`);
    await orgNav(page).getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${t.org.id}/?$`));
    // 1000 + 200 + 30 + 4 + 1000.25
    await expect(moneyText(page, 'Receivable', 223_425)).toBeVisible();
    await expect(moneyText(page, 'Overdue', 123_425)).toBeVisible();
    await expect(moneyText(page, 'Collected this month', 50_025)).toBeVisible();
    await context.close();
  });

  test('[cp5.02][R5.5] the aging table ("Bucket", "Amount") lists the five buckets with their amounts', async ({ browser, playwright }) => {
    const t = await seededOrg(playwright);
    const { context, page } = await pageFor(browser, t.owner);
    await page.goto(`/orgs/${t.org.id}`);
    await expectColumnHeaders(page, ['Bucket', 'Amount']);
    const expected: Array<[string, string]> = [
      ['Current', '$1,000.00'],
      ['1-30 days', '$200.00'],
      ['31-60 days', '$30.00'],
      ['61-90 days', '$4.00'],
      ['Over 90 days', '$1,000.25'],
    ];
    for (const [bucket, amount] of expected) {
      const r = page.getByRole('row').filter({ has: page.getByRole('cell', { name: bucket, exact: true }) });
      await expect(r, bucket).toContainText(amount);
    }
    await context.close();
  });

  test('[cp5.03][R5.8] "Export invoices CSV" downloads the organization\'s export', async ({ browser, playwright }) => {
    const t = await seededOrg(playwright);
    const { context, page } = await pageFor(browser, t.viewer);
    await page.goto(`/orgs/${t.org.id}`);
    const [download] = await Promise.all([page.waitForEvent('download'), action(page, 'Export invoices CSV').click()]);
    const path = await download.path();
    const text = require('fs').readFileSync(path, 'utf8') as string;
    const rows = readCsv(text);
    expect(rows[0]).toEqual(['number', 'customer', 'status', 'issue_date', 'due_date', 'subtotal', 'tax', 'total', 'paid', 'balance']);
    expect(rows.slice(1).map((r) => r[0])).toEqual(['INV-0001', 'INV-0002', 'INV-0003', 'INV-0004', 'INV-0005']);
    expect(rows[5]!.slice(7)).toEqual(['1500.50', '500.25', '1000.25']);
    await context.close();
  });

  test('[cp5.04][R5.5] an organization with nothing receivable shows $0.00 figures', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}`);
    await expect(moneyText(page, 'Receivable', 0)).toBeVisible();
    await expect(moneyText(page, 'Overdue', 0)).toBeVisible();
    await expect(moneyText(page, 'Collected this month', 0)).toBeVisible();
    await expect(row(page, 'Over 90 days')).toContainText('$0.00');
    await context.close();
  });

  test('[cp5.40][R5.5][C5] dashboard: every control has an accessible name', async ({ browser, playwright }) => {
    const t = await seededOrg(playwright);
    const { context, page } = await pageFor(browser, t.owner);
    await page.goto(`/orgs/${t.org.id}`);
    await expect(moneyText(page, 'Receivable', 223_425)).toBeVisible();
    await expectAccessibleNames(page, 'dashboard');
    await context.close();
  });
});

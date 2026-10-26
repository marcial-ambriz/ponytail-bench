/** C2 API probes for checkpoint 5: dashboard figures, aging and CSV export (spec/cp5.md). */
import { expect, test } from '@playwright/test';
import {
  addDays,
  anonApi,
  createCustomer,
  createDraft,
  deliver,
  expectStatus,
  issue,
  issuedInvoice,
  line,
  ownerWithOrg,
  pay,
  payflowEvent,
  readCsv,
  team,
  todayUtc,
  webhookSecret,
  type Api,
} from '../../support';

const AS_OF = '2031-06-15';
const HEADER = ['number', 'customer', 'status', 'issue_date', 'due_date', 'subtotal', 'tax', 'total', 'paid', 'balance'];

async function dashboard(api: Api, orgId: string, asOf?: string) {
  return expectStatus(await api.get(`/api/orgs/${orgId}/dashboard${asOf ? `?asOf=${asOf}` : ''}`), 200, 'GET dashboard');
}

async function exportCsv(api: Api, orgId: string, query = '') {
  const res = await api.get(`/api/orgs/${orgId}/exports/invoices.csv${query}`);
  expect(res.status(), `export ${query}: ${(await res.text()).slice(0, 200)}`).toBe(200);
  return { res, rows: readCsv(await res.text()) };
}

test.describe('Probes CP5', () => {
  test('[cp5.20][R5.1][C2] GET dashboard -> { asOf, receivableCents, overdueCents, collectedCents, aging{...} }; asOf defaults to today; invalid asOf -> 422', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const d = await dashboard(owner, org.id);
    expect(d).toEqual({
      asOf: todayUtc(),
      receivableCents: 0,
      overdueCents: 0,
      collectedCents: 0,
      aging: { currentCents: 0, days1to30Cents: 0, days31to60Cents: 0, days61to90Cents: 0, over90Cents: 0 },
    });
    expect((await dashboard(owner, org.id, AS_OF)).asOf).toBe(AS_OF);
    for (const bad of ['2031-02-30', '15-06-2031', 'yesterday']) {
      await expectStatus(await owner.get(`/api/orgs/${org.id}/dashboard?asOf=${bad}`), 422, `asOf=${bad}`);
    }
  });

  test('[cp5.21][R5.2][C2] aging buckets by days past due (<=0, 1-30, 31-60, 61-90, >90) over issued invoices with a balance only', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const due = (daysPastDue: number) => addDays(AS_OF, -daysPastDue);
    const spec: Array<[number, number]> = [
      [-5, 10_000], [0, 20_000], // current
      [1, 1_000], [30, 2_000], // 1-30
      [31, 100], [60, 200], // 31-60
      [61, 10], [90, 20], // 61-90
      [91, 1], [400, 2], // over 90
    ];
    for (const [days, cents] of spec) await issuedInvoice(owner, org.id, [line(cents)], due(days));
    const c = await createCustomer(owner, org.id);
    await createDraft(owner, org.id, c.id, [line(777_777)], due(100)); // draft: not receivable
    const voided = await createDraft(owner, org.id, c.id, [line(555_555)], due(100));
    await issue(owner, org.id, voided.id);
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices/${voided.id}/void`), 200, 'void');
    const paid = await issuedInvoice(owner, org.id, [line(333_333)], due(45));
    await expectStatus(await pay(owner, org.id, paid.invoice.id, 333_333), 201, 'pay in full');
    const d = await dashboard(owner, org.id, AS_OF);
    expect(d.aging).toEqual({ currentCents: 30_000, days1to30Cents: 3_000, days31to60Cents: 300, days61to90Cents: 30, over90Cents: 3 });
    expect(d.receivableCents).toBe(33_333);
    expect(d.overdueCents).toBe(3_333);
    // A different asOf moves the same invoices between buckets.
    const later = await dashboard(owner, org.id, addDays(AS_OF, 31));
    expect(later.aging.currentCents).toBe(0);
    expect(later.receivableCents).toBe(33_333);
  });

  test('[cp5.22][R5.3][C2] figures reconcile with payments: partial payments reduce, refunded ones do not, and buckets add up to receivable', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const a = await issuedInvoice(owner, org.id, [line(10_000, 1, 1600)], addDays(AS_OF, -10)); // 116.00, 1-30
    const b = await issuedInvoice(owner, org.id, [line(5_000)], addDays(AS_OF, 5)); // 50.00, current
    await expectStatus(await pay(owner, org.id, a.invoice.id, 2_599), 201, 'partial manual');
    const kept = payflowEvent('payment.succeeded', b.invoice.id, 1_000);
    await expectStatus(await deliver(anon, org.id, secret, kept), 200, 'webhook payment');
    const refunded = payflowEvent('payment.succeeded', a.invoice.id, 3_000);
    await expectStatus(await deliver(anon, org.id, secret, refunded), 200, 'webhook payment to refund');
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.refunded', a.invoice.id, 3_000, { paymentId: refunded.data.paymentId })), 200, 'refund');
    const d = await dashboard(owner, org.id, AS_OF);
    expect(d.aging.days1to30Cents).toBe(11_600 - 2_599);
    expect(d.aging.currentCents).toBe(5_000 - 1_000);
    const sum = Object.values(d.aging as Record<string, number>).reduce((x, y) => x + y, 0);
    expect(sum).toBe(d.receivableCents);
    expect(d.receivableCents).toBe(9_001 + 4_000);
    expect(d.overdueCents).toBe(9_001);
  });

  test('[cp5.23][R5.4][C2] collectedCents sums non-refunded payments with paidAt in the calendar month of asOf', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(100_000)]);
    await expectStatus(await pay(owner, org.id, invoice.id, 1_000, { paidAt: '2031-06-01' }), 201, 'June 1');
    await expectStatus(await pay(owner, org.id, invoice.id, 2_000, { paidAt: '2031-06-30' }), 201, 'June 30');
    await expectStatus(await pay(owner, org.id, invoice.id, 4_000, { paidAt: '2031-05-31' }), 201, 'May 31');
    await expectStatus(await pay(owner, org.id, invoice.id, 8_000, { paidAt: '2031-07-01' }), 201, 'July 1');
    const june = Date.UTC(2031, 5, 10) / 1000;
    const viaWebhook = payflowEvent('payment.succeeded', invoice.id, 16_000, { created: june });
    await expectStatus(await deliver(anon, org.id, secret, viaWebhook), 200, 'webhook June 10');
    const refunded = payflowEvent('payment.succeeded', invoice.id, 32_000, { created: june });
    await expectStatus(await deliver(anon, org.id, secret, refunded), 200, 'webhook June 10 (refunded later)');
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.refunded', invoice.id, 32_000, { paymentId: refunded.data.paymentId })), 200, 'refund');
    expect((await dashboard(owner, org.id, AS_OF)).collectedCents).toBe(1_000 + 2_000 + 16_000);
    expect((await dashboard(owner, org.id, '2031-05-01')).collectedCents).toBe(4_000);
  });

  test('[cp5.24][R5.6][C2] export: text/csv attachment, exact header, non-draft invoices ordered by number, two-decimal amounts, lowercase status', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id, { name: 'Export Client' });
    const first = await createDraft(owner, org.id, c.id, [line(123_450, 1, 1000)], '2031-01-31'); // 1234.50 + 123.45
    const second = await createDraft(owner, org.id, c.id, [line(5)], '2031-02-28');
    await createDraft(owner, org.id, c.id, [line(999)]); // stays a draft
    await issue(owner, org.id, second.id); // INV-0001
    await issue(owner, org.id, first.id); // INV-0002
    await expectStatus(await pay(owner, org.id, first.id, 100_000), 201, 'partial');
    const v = await createDraft(owner, org.id, c.id, [line(700)], '2031-03-31');
    await issue(owner, org.id, v.id); // INV-0003
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices/${v.id}/void`), 200, 'void');
    const { res, rows } = await exportCsv(owner, org.id);
    expect(res.headers()['content-type']).toContain('text/csv');
    expect((res.headers()['content-disposition'] ?? '').toLowerCase()).toContain('attachment');
    expect(rows[0]).toEqual(HEADER);
    const today = todayUtc();
    expect(rows.slice(1)).toEqual([
      ['INV-0001', 'Export Client', 'issued', today, '2031-02-28', '0.05', '0.00', '0.05', '0.00', '0.05'],
      ['INV-0002', 'Export Client', 'issued', today, '2031-01-31', '1234.50', '123.45', '1357.95', '1000.00', '357.95'],
      ['INV-0003', 'Export Client', 'void', today, '2031-03-31', '7.00', '0.00', '7.00', '0.00', '7.00'],
    ]);
  });

  test('[cp5.25][R5.6][C2] export from/to filter inclusively on issueDate; an invalid date -> 422', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    await issuedInvoice(owner, org.id, [line(100)]);
    await issuedInvoice(owner, org.id, [line(200)]);
    const today = todayUtc();
    expect((await exportCsv(owner, org.id, `?from=${today}&to=${today}`)).rows).toHaveLength(3);
    expect((await exportCsv(owner, org.id, `?from=${addDays(today, 1)}`)).rows).toHaveLength(1);
    expect((await exportCsv(owner, org.id, `?to=${addDays(today, -1)}`)).rows).toHaveLength(1);
    expect((await exportCsv(owner, org.id, `?from=${addDays(today, -1)}`)).rows).toHaveLength(3);
    await expectStatus(await owner.get(`/api/orgs/${org.id}/exports/invoices.csv?from=2031-02-30`), 422, 'bad from');
    await expectStatus(await owner.get(`/api/orgs/${org.id}/exports/invoices.csv?to=nope`), 422, 'bad to');
  });

  test('[cp5.26][R5.7][C2] export quotes commas, quotes and line breaks and neutralizes formula-like text with a leading quote', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const names = ['Acme, "Big" Co', '=HYPERLINK("http://evil.test","x")', '+1 Corp', '-Dash Ltd', '@SUM Inc'];
    for (const name of names) await issuedInvoice(owner, org.id, [line(100)]).then(async ({ customer }) => {
      await expectStatus(await owner.patch(`/api/orgs/${org.id}/customers/${customer.id}`, { name }), 200, `rename ${name}`);
    });
    const res = await owner.get(`/api/orgs/${org.id}/exports/invoices.csv`);
    const text = await res.text();
    expect(text).toContain('"Acme, ""Big"" Co"');
    const customers = readCsv(text).slice(1).map((r) => r[1]);
    expect(customers).toEqual(["Acme, \"Big\" Co", '\'=HYPERLINK("http://evil.test","x")', "'+1 Corp", "'-Dash Ltd", "'@SUM Inc"]);
  });

  test('[cp5.27][R5.1][C2] every member, viewers included, can read the dashboard and the export; non-members get 404', async ({ playwright }) => {
    const t = await team(playwright);
    await issuedInvoice(t.owner, t.org.id, [line(4_200)]);
    expect((await dashboard(t.viewer, t.org.id)).receivableCents).toBe(4_200);
    expect((await exportCsv(t.viewer, t.org.id)).rows).toHaveLength(2);
    const stranger = await ownerWithOrg(playwright);
    await expectStatus(await stranger.owner.get(`/api/orgs/${t.org.id}/dashboard`), 404, 'stranger dashboard');
    await expectStatus(await stranger.owner.get(`/api/orgs/${t.org.id}/exports/invoices.csv`), 404, 'stranger export');
  });
});

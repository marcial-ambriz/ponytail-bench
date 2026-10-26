/** C2 API probes for checkpoint 3: manual payments, balances and the PayFlow webhook (spec/cp3.md). */
import { expect, test } from '@playwright/test';
import {
  anonApi,
  createCustomer,
  createDraft,
  deliver,
  errorOf,
  expectStatus,
  getInvoice,
  issue,
  issuedInvoice,
  line,
  nowSeconds,
  ownerWithOrg,
  pay,
  payflowEvent,
  payments,
  signPayflow,
  team,
  todayUtc,
  uniq,
  webhookSecret,
} from '../../support';

const UTC_DATE = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

test.describe('Probes CP3 - manual payments', () => {
  test('[cp3.20][R3.4][C2] POST payments -> 201 payment; paidCents/balanceCents follow; the invoice becomes "paid" at balance 0', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(5000, 2, 1000)]); // 110.00
    const p = await expectStatus(await pay(owner, org.id, invoice.id, 4000, { method: 'cash', paidAt: '2030-05-04', reference: 'R-1' }), 201, 'POST payment');
    expect(p).toMatchObject({ amountCents: 4000, method: 'cash', paidAt: '2030-05-04', reference: 'R-1', source: 'manual', providerPaymentId: null, refunded: false });
    expect(String(p.invoiceId)).toBe(invoice.id);
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ status: 'issued', paidCents: 4000, balanceCents: 7000, totalCents: 11000 });
    const last = await expectStatus(await pay(owner, org.id, invoice.id, 7000), 201, 'pay the rest');
    expect(last.paidAt).toBe(todayUtc());
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ status: 'paid', paidCents: 11000, balanceCents: 0 });
    const paidList = (await (await owner.get(`/api/orgs/${org.id}/invoices?status=paid`)).json()) as any[];
    expect(paidList.map((i) => String(i.id))).toContain(invoice.id);
  });

  test('[cp3.21][R3.4][C2] payment validation: integer cents 1..balance ("exceeds" above it), known method, real date, reference <= 100 -> else 422', async ({ playwright }) => {
    const t = await team(playwright);
    const { invoice } = await issuedInvoice(t.accountant, t.org.id, [line(10_000)]);
    const bad: Array<[string, Record<string, unknown>]> = [
      ['zero', { amountCents: 0 }],
      ['negative', { amountCents: -500 }],
      ['fractional', { amountCents: 10.5 }],
      ['numeric string', { amountCents: '100' }],
      ['unknown method', { amountCents: 100, method: 'cheque' }],
      ['bad date', { amountCents: 100, paidAt: '2030-13-01' }],
      ['long reference', { amountCents: 100, reference: 'r'.repeat(101) }],
    ];
    for (const [label, body] of bad) await expectStatus(await pay(t.accountant, t.org.id, invoice.id, 0, body), 422, label);
    const over = await pay(t.accountant, t.org.id, invoice.id, 10_001);
    await expectStatus(over, 422, 'one cent over the balance');
    expect((await errorOf(over)).toLowerCase()).toContain('exceeds');
    await expectStatus(await pay(t.accountant, t.org.id, invoice.id, 1, { reference: 'r'.repeat(100) }), 201, 'boundary: 1 cent, 100-char reference');
    await expectStatus(await pay(t.viewer, t.org.id, invoice.id, 100), 403, 'viewer');
    expect((await getInvoice(t.owner, t.org.id, invoice.id)).paidCents).toBe(1);
  });

  test('[cp3.22][R3.3][C2] payments only on issued invoices with a balance: draft, void and paid invoices -> 422', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const draft = await createDraft(owner, org.id, c.id);
    await expectStatus(await pay(owner, org.id, draft.id, 100), 422, 'draft');
    const voided = await createDraft(owner, org.id, c.id);
    await issue(owner, org.id, voided.id);
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices/${voided.id}/void`), 200, 'void');
    await expectStatus(await pay(owner, org.id, voided.id, 100), 422, 'void');
    const { invoice } = await issuedInvoice(owner, org.id, [line(300)]);
    await expectStatus(await pay(owner, org.id, invoice.id, 300), 201, 'full');
    await expectStatus(await pay(owner, org.id, invoice.id, 1), 422, 'paid');
  });

  test('[cp3.23][R3.3][C2] an invoice with payments cannot be voided (422 "payments"); invoice and payments stay unchanged', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    await expectStatus(await pay(owner, org.id, invoice.id, 2500), 201, 'partial payment');
    const res = await owner.post(`/api/orgs/${org.id}/invoices/${invoice.id}/void`);
    await expectStatus(res, 422, 'void with payments');
    expect((await errorOf(res)).toLowerCase()).toContain('payments');
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ status: 'issued', paidCents: 2500, balanceCents: 7500 });
    expect(await payments(owner, org.id, invoice.id)).toHaveLength(1);
  });

  test('[cp3.24][R3.6][C2] GET payments lists the invoice\'s payments oldest first with the documented fields', async ({ playwright }) => {
    const t = await team(playwright);
    const { invoice } = await issuedInvoice(t.owner, t.org.id, [line(10_000)]);
    await expectStatus(await pay(t.owner, t.org.id, invoice.id, 100, { method: 'card' }), 201, 'first');
    await expectStatus(await pay(t.accountant, t.org.id, invoice.id, 200, { method: 'other', reference: 'second' }), 201, 'second');
    const list = await payments(t.viewer, t.org.id, invoice.id);
    expect(list.map((p) => p.amountCents)).toEqual([100, 200]);
    for (const p of list) {
      for (const key of ['id', 'invoiceId', 'amountCents', 'method', 'paidAt', 'reference', 'source', 'providerPaymentId', 'refunded']) {
        expect(p, `payment has "${key}"`).toHaveProperty(key);
      }
    }
    expect(list[1]).toMatchObject({ method: 'other', reference: 'second', source: 'manual', refunded: false });
  });
});

test.describe('Probes CP3 - PayFlow webhook', () => {
  test('[cp3.25][R3.7][C2] GET settings/webhook (owner only) -> { secret, url }; rotate returns a new secret', async ({ playwright }) => {
    const t = await team(playwright);
    const view = await expectStatus(await t.owner.get(`/api/orgs/${t.org.id}/settings/webhook`), 200, 'GET webhook settings');
    expect(view.url).toBe(`/api/webhooks/payflow/${t.org.id}`);
    expect(typeof view.secret === 'string' && view.secret.length >= 16).toBe(true);
    for (const who of [t.accountant, t.viewer]) {
      await expectStatus(await who.get(`/api/orgs/${t.org.id}/settings/webhook`), 403, 'non-owner GET');
      await expectStatus(await who.post(`/api/orgs/${t.org.id}/settings/webhook/rotate`), 403, 'non-owner rotate');
    }
    const rotated = await expectStatus(await t.owner.post(`/api/orgs/${t.org.id}/settings/webhook/rotate`), 200, 'rotate');
    expect(rotated.secret).not.toBe(view.secret);
    expect(rotated.url).toBe(view.url);
    expect(await webhookSecret(t.owner, t.org.id)).toBe(rotated.secret);
    const other = await ownerWithOrg(playwright);
    expect(await webhookSecret(other.owner, other.org.id)).not.toBe(rotated.secret);
  });

  test('[cp3.26][R3.10][C2] a signed payment.succeeded -> 200 { received: true } and records a PayFlow payment dated from "created"', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(2500)]);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const created = nowSeconds() - 3600 * 30; // older events are fine: only the signature timestamp is checked
    const event = payflowEvent('payment.succeeded', invoice.id, 2500, { created });
    const body = await expectStatus(await deliver(anon, org.id, secret, event), 200, 'deliver');
    expect(body).toEqual({ received: true });
    const list = await payments(owner, org.id, invoice.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ amountCents: 2500, source: 'payflow', providerPaymentId: event.data.paymentId, refunded: false, paidAt: UTC_DATE(created) });
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ status: 'paid', balanceCents: 0 });
  });

  test('[cp3.27][R3.8][C2] missing, malformed or wrong signatures and stale timestamps -> 401; unknown organization -> 404; nothing recorded', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(2500)]);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const ev = () => payflowEvent('payment.succeeded', invoice.id, 1000);
    await expectStatus(await deliver(anon, org.id, secret, ev(), { header: null }), 401, 'no header');
    await expectStatus(await deliver(anon, org.id, secret, ev(), { header: 'garbage' }), 401, 'malformed header');
    await expectStatus(await deliver(anon, org.id, `${secret}x`, ev()), 401, 'wrong secret');
    await expectStatus(await deliver(anon, org.id, secret, ev(), { t: nowSeconds() - 301 }), 401, 'timestamp 301 s old');
    await expectStatus(await deliver(anon, org.id, secret, ev(), { t: nowSeconds() + 400 }), 401, 'timestamp 400 s ahead');
    const e = ev();
    const signedFor = JSON.stringify(e);
    const t = nowSeconds();
    await expectStatus(
      await deliver(anon, org.id, secret, e, { raw: signedFor.replace('"amountCents":1000', '"amountCents":2000'), header: `t=${t},v1=${signPayflow(secret, t, signedFor)}` }),
      401,
      'body changed after signing',
    );
    await expectStatus(await deliver(anon, 'no-such-org', secret, ev()), 404, 'unknown organization');
    expect(await payments(owner, org.id, invoice.id)).toHaveLength(0);
    await expectStatus(await deliver(anon, org.id, secret, ev(), { t: nowSeconds() - 240 }), 200, 'timestamp 240 s old is accepted');
  });

  test('[cp3.28][R3.9][C2] a correctly signed body without the documented shape -> 422 and nothing recorded', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(2500)]);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const good = payflowEvent('payment.succeeded', invoice.id, 1000);
    const variants: Array<[string, unknown]> = [
      ['missing id', { ...good, id: undefined }],
      ['missing data', { ...good, data: undefined }],
      ['amount 0', { ...good, data: { ...good.data, amountCents: 0 } }],
      ['amount as string', { ...good, data: { ...good.data, amountCents: '1000' } }],
      ['fractional amount', { ...good, data: { ...good.data, amountCents: 10.5 } }],
      ['missing paymentId', { ...good, data: { invoiceId: invoice.id, amountCents: 1000 } }],
    ];
    for (const [label, body] of variants) await expectStatus(await deliver(anon, org.id, secret, body), 422, label);
    await expectStatus(await deliver(anon, org.id, secret, null, { raw: '{"id": "evt_broken", ' }), 422, 'invalid JSON');
    expect(await payments(owner, org.id, invoice.id)).toHaveLength(0);
  });

  test('[cp3.29][R3.10][C2] webhook business rules: other organization\'s invoice, overpayment or void invoice -> 422; a rejected event is not considered processed', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(2500)]);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const other = await ownerWithOrg(playwright);
    const theirs = await issuedInvoice(other.owner, other.org.id, [line(2500)]);
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.succeeded', theirs.invoice.id, 100)), 422, "another organization's invoice");
    expect(await payments(other.owner, other.org.id, theirs.invoice.id)).toHaveLength(0);

    const over = payflowEvent('payment.succeeded', invoice.id, 2501);
    const res = await deliver(anon, org.id, secret, over);
    await expectStatus(res, 422, 'overpayment');
    // Not processed: the same event id with a valid amount is accepted later (it is not a "reused id").
    const retry = { ...over, data: { ...over.data, amountCents: 2500 } };
    await expectStatus(await deliver(anon, org.id, secret, retry), 200, 'same id, now valid');
    expect((await getInvoice(owner, org.id, invoice.id)).balanceCents).toBe(0);

    const c = await createCustomer(owner, org.id);
    const v = await createDraft(owner, org.id, c.id);
    await issue(owner, org.id, v.id);
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices/${v.id}/void`), 200, 'void');
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.succeeded', v.id, 100)), 422, 'void invoice');
  });

  test('[cp3.30][R3.11][C2] payment.refunded marks the payment refunded, restores the balance and moves "paid" back to "issued"', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(4000)]);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const paid = payflowEvent('payment.succeeded', invoice.id, 4000);
    await expectStatus(await deliver(anon, org.id, secret, paid), 200, 'succeeded');
    expect((await getInvoice(owner, org.id, invoice.id)).status).toBe('paid');
    const refund = payflowEvent('payment.refunded', invoice.id, 4000, { paymentId: paid.data.paymentId });
    await expectStatus(await deliver(anon, org.id, secret, refund), 200, 'refunded');
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ status: 'issued', paidCents: 0, balanceCents: 4000 });
    const list = await payments(owner, org.id, invoice.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ refunded: true, providerPaymentId: paid.data.paymentId });
    // With every payment refunded, the invoice can be voided again.
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices/${invoice.id}/void`), 200, 'void after full refund');
  });

  test('[cp3.31][R3.11][C2] other event types are acknowledged with 200 and change nothing', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(4000)]);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    for (const type of ['payment.created', 'customer.updated', 'payout.paid']) {
      expect(await expectStatus(await deliver(anon, org.id, secret, payflowEvent(type, invoice.id, 4000)), 200, type)).toEqual({ received: true });
    }
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ status: 'issued', paidCents: 0 });
    expect(await payments(owner, org.id, invoice.id)).toHaveLength(0);
  });

  test('[cp3.32][R3.12][C2] redelivering the same event returns 200 every time and applies it once', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const ev = payflowEvent('payment.succeeded', invoice.id, 3000);
    for (let i = 0; i < 3; i++) await expectStatus(await deliver(anon, org.id, secret, ev), 200, `delivery ${i + 1}`);
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ paidCents: 3000, balanceCents: 7000 });
    expect(await payments(owner, org.id, invoice.id)).toHaveLength(1);
  });

  test('[cp3.33][R3.12][C2] an already processed event id with a different type or data -> 409 and nothing changes', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const ev = payflowEvent('payment.succeeded', invoice.id, 3000);
    await expectStatus(await deliver(anon, org.id, secret, ev), 200, 'first');
    await expectStatus(await deliver(anon, org.id, secret, { ...ev, data: { ...ev.data, amountCents: 5000 } }), 409, 'same id, other amount');
    await expectStatus(await deliver(anon, org.id, secret, { ...ev, type: 'payment.refunded' }), 409, 'same id, other type');
    await expectStatus(await deliver(anon, org.id, secret, { ...ev, data: { ...ev.data, paymentId: uniq('pay') } }), 409, 'same id, other payment');
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ paidCents: 3000 });
    expect((await payments(owner, org.id, invoice.id))[0].refunded).toBe(false);
  });

  test('[cp3.34][R3.12][C2] a refund delivered before its success ends as if delivered in order; one provider payment under two event ids counts once', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(10_000)]);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const paymentId = uniq('pay');
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.refunded', invoice.id, 6000, { paymentId })), 200, 'refund first');
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.succeeded', invoice.id, 6000, { paymentId })), 200, 'success second');
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ status: 'issued', paidCents: 0, balanceCents: 10_000 });
    const list = await payments(owner, org.id, invoice.id);
    expect(list.filter((p) => p.providerPaymentId === paymentId).every((p) => p.refunded === true)).toBe(true);

    const twice = uniq('pay');
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.succeeded', invoice.id, 2000, { paymentId: twice })), 200, 'success, event A');
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.succeeded', invoice.id, 2000, { paymentId: twice })), 200, 'success, event B');
    expect((await getInvoice(owner, org.id, invoice.id)).paidCents).toBe(2000);
    expect((await payments(owner, org.id, invoice.id)).filter((p) => p.providerPaymentId === twice)).toHaveLength(1);
  });
});

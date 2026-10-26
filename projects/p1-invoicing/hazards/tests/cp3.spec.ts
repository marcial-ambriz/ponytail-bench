/** Hazard tests, checkpoint 3 (payments, balances, PayFlow webhook). See hazards/PROOF.md. */
import { expect, test } from '@playwright/test';
import {
  anonApi,
  deliver,
  expectStatus,
  getInvoice,
  issuedInvoice,
  line,
  nowSeconds,
  ownerWithOrg,
  pay,
  payflowEvent,
  payments,
  signPayflow,
  team,
  uniq,
  webhookSecret,
} from '../../support';

async function setup(playwright: Parameters<typeof ownerWithOrg>[0], totalCents = 10_000) {
  const { owner, org } = await ownerWithOrg(playwright);
  const { invoice } = await issuedInvoice(owner, org.id, [line(totalCents)]);
  const secret = await webhookSecret(owner, org.id);
  const anon = await anonApi(playwright);
  return { owner, org, invoice, secret, anon };
}

test.describe('Hazards CP3 - webhook idempotency', () => {
  test('[hz3.01][R3.12][H:idempotency:3] 50 identical webhook deliveries at the same moment record one payment', async ({ playwright }) => {
    const { owner, org, invoice, secret, anon } = await setup(playwright);
    const ev = payflowEvent('payment.succeeded', invoice.id, 2500);
    const results = await Promise.all(Array.from({ length: 50 }, () => deliver(anon, org.id, secret, ev)));
    expect(results.filter((r) => r.status() >= 500), 'no server errors').toHaveLength(0);
    expect(results.filter((r) => r.status() === 200).length, 'every delivery is acknowledged').toBe(50);
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ paidCents: 2500, balanceCents: 7500 });
    expect(await payments(owner, org.id, invoice.id)).toHaveLength(1);
  });

  test('[hz3.02][R3.12][H:idempotency:3] 5 sequential redeliveries of the same event apply it once', async ({ playwright }) => {
    const { owner, org, invoice, secret, anon } = await setup(playwright);
    const ev = payflowEvent('payment.succeeded', invoice.id, 1000);
    for (let i = 0; i < 5; i++) await expectStatus(await deliver(anon, org.id, secret, ev), 200, `delivery ${i + 1}`);
    expect((await getInvoice(owner, org.id, invoice.id)).balanceCents).toBe(9000);
  });

  test('[hz3.03][R3.12][H:idempotency:3] reusing a processed event id with another amount is rejected (409) and changes nothing', async ({ playwright }) => {
    const { owner, org, invoice, secret, anon } = await setup(playwright);
    const ev = payflowEvent('payment.succeeded', invoice.id, 1000);
    await expectStatus(await deliver(anon, org.id, secret, ev), 200, 'original');
    await expectStatus(await deliver(anon, org.id, secret, { ...ev, data: { ...ev.data, amountCents: 9000 } }), 409, 'tampered amount');
    expect((await getInvoice(owner, org.id, invoice.id)).paidCents).toBe(1000);
    expect((await payments(owner, org.id, invoice.id)).map((p) => p.amountCents)).toEqual([1000]);
  });

  test('[hz3.04][R3.12][H:idempotency:2] a refund that arrives before its payment leaves the balance unchanged', async ({ playwright }) => {
    const { owner, org, invoice, secret, anon } = await setup(playwright);
    const paymentId = uniq('pay');
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.refunded', invoice.id, 4000, { paymentId })), 200, 'refund first');
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.succeeded', invoice.id, 4000, { paymentId })), 200, 'success later');
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ paidCents: 0, balanceCents: 10_000, status: 'issued' });
  });

  test('[hz3.05][R3.12][H:idempotency:2] one provider payment reported under several event ids (also simultaneously) is recorded once', async ({ playwright }) => {
    const { owner, org, invoice, secret, anon } = await setup(playwright);
    const paymentId = uniq('pay');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => deliver(anon, org.id, secret, payflowEvent('payment.succeeded', invoice.id, 3000, { paymentId }))),
    );
    expect(results.filter((r) => r.status() >= 500)).toHaveLength(0);
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.succeeded', invoice.id, 3000, { paymentId })), 200, 'one more, later');
    expect((await getInvoice(owner, org.id, invoice.id)).paidCents).toBe(3000);
    expect((await payments(owner, org.id, invoice.id)).filter((p) => p.providerPaymentId === paymentId)).toHaveLength(1);
  });
});

test.describe('Hazards CP3 - webhook authenticity', () => {
  test('[hz3.06][R3.8][H:authz:3] unsigned, wrongly signed, tampered or replayed (stale) deliveries -> 401 and nothing is recorded', async ({ playwright }) => {
    const { owner, org, invoice, secret, anon } = await setup(playwright);
    const ev = () => payflowEvent('payment.succeeded', invoice.id, 5000);
    await expectStatus(await deliver(anon, org.id, secret, ev(), { header: null }), 401, 'no signature');
    await expectStatus(await deliver(anon, org.id, secret, ev(), { header: 't=1,v1=00' }), 401, 'malformed signature');
    await expectStatus(await deliver(anon, org.id, 'whsec_guess', ev()), 401, 'guessed secret');
    const e = ev();
    const t = nowSeconds();
    const original = JSON.stringify(e);
    const tampered = original.replace('"amountCents":5000', '"amountCents":10000');
    await expectStatus(await deliver(anon, org.id, secret, e, { raw: tampered, header: `t=${t},v1=${signPayflow(secret, t, original)}` }), 401, 'tampered body');
    await expectStatus(await deliver(anon, org.id, secret, ev(), { t: nowSeconds() - 3600 }), 401, 'replayed an hour later');
    await expectStatus(await deliver(anon, org.id, secret, e, { header: `t=${t},v1=${signPayflow(secret, t, original).toUpperCase()}x` }), 401, 'garbled hex');
    expect(await payments(owner, org.id, invoice.id)).toHaveLength(0);
    expect((await getInvoice(owner, org.id, invoice.id)).paidCents).toBe(0);
  });

  test('[hz3.07][R3.10][H:authz:3] webhooks cannot cross tenants: another organization\'s secret -> 401; another organization\'s invoice -> 422', async ({ playwright }) => {
    const a = await setup(playwright);
    const b = await setup(playwright);
    // Signed with B's secret, sent to A's URL, targeting A's invoice.
    await expectStatus(await deliver(a.anon, a.org.id, b.secret, payflowEvent('payment.succeeded', a.invoice.id, 1000)), 401, "B's secret on A's URL");
    // Correctly signed for A but naming B's invoice.
    await expectStatus(await deliver(a.anon, a.org.id, a.secret, payflowEvent('payment.succeeded', b.invoice.id, 1000)), 422, "A's webhook, B's invoice");
    // A refund through A's URL must not touch B's payments.
    const bPay = payflowEvent('payment.succeeded', b.invoice.id, 2000);
    await expectStatus(await deliver(b.anon, b.org.id, b.secret, bPay), 200, 'B pays');
    const crossRefund = payflowEvent('payment.refunded', b.invoice.id, 2000, { paymentId: bPay.data.paymentId });
    const res = await deliver(a.anon, a.org.id, a.secret, crossRefund);
    expect([200, 422], `cross refund -> ${res.status()}`).toContain(res.status());
    expect(await getInvoice(b.owner, b.org.id, b.invoice.id)).toMatchObject({ paidCents: 2000 });
    expect(await getInvoice(a.owner, a.org.id, a.invoice.id)).toMatchObject({ paidCents: 0 });
  });

  test('[hz3.08][R3.7][H:authz:3] after rotating the secret, deliveries signed with the old one are rejected (401)', async ({ playwright }) => {
    const { owner, org, invoice, secret, anon } = await setup(playwright);
    await expectStatus(await owner.post(`/api/orgs/${org.id}/settings/webhook/rotate`), 200, 'rotate');
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.succeeded', invoice.id, 1000)), 401, 'old secret');
    const fresh = await webhookSecret(owner, org.id);
    await expectStatus(await deliver(anon, org.id, fresh, payflowEvent('payment.succeeded', invoice.id, 1000)), 200, 'new secret');
    expect((await getInvoice(owner, org.id, invoice.id)).paidCents).toBe(1000);
  });

  test('[hz3.09][R3.7][H:authz:2] only owners see or rotate the webhook secret; viewers cannot record payments; outsiders cannot read payments', async ({ playwright }) => {
    const t = await team(playwright);
    const { invoice } = await issuedInvoice(t.owner, t.org.id);
    for (const who of [t.accountant, t.viewer]) {
      const res = await who.get(`/api/orgs/${t.org.id}/settings/webhook`);
      await expectStatus(res, 403, 'read secret');
      expect(await res.text()).not.toContain((await webhookSecret(t.owner, t.org.id)).slice(6));
      await expectStatus(await who.post(`/api/orgs/${t.org.id}/settings/webhook/rotate`), 403, 'rotate');
    }
    await expectStatus(await pay(t.viewer, t.org.id, invoice.id, 100), 403, 'viewer pays');
    const { owner: stranger } = await ownerWithOrg(playwright);
    await expectStatus(await stranger.get(`/api/orgs/${t.org.id}/invoices/${invoice.id}/payments`), 404, 'outsider reads payments');
    await expectStatus(await pay(stranger, t.org.id, invoice.id, 100), 404, 'outsider pays');
    expect((await getInvoice(t.owner, t.org.id, invoice.id)).paidCents).toBe(0);
  });
});

test.describe('Hazards CP3 - balances', () => {
  test('[hz3.10][R3.5][H:concurrency:3] 50 simultaneous $10.00 payments on a $95.00 invoice: exactly 9 succeed and the balance ends at $5.00', async ({ playwright }) => {
    const { owner, org, invoice } = await setup(playwright, 9500);
    const results = await Promise.all(Array.from({ length: 50 }, () => pay(owner, org.id, invoice.id, 1000)));
    const codes = results.map((r) => r.status());
    expect(codes.filter((s) => s === 201).length, codes.join(',')).toBe(9);
    expect(codes.filter((s) => s === 422).length).toBe(41);
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ paidCents: 9000, balanceCents: 500 });
  });

  test('[hz3.11][R3.1][H:concurrency:2] simultaneous webhook payments (different provider payments) never push the balance below zero', async ({ playwright }) => {
    const { owner, org, invoice, secret, anon } = await setup(playwright, 10_000);
    const results = await Promise.all(Array.from({ length: 30 }, () => deliver(anon, org.id, secret, payflowEvent('payment.succeeded', invoice.id, 700))));
    expect(results.filter((r) => r.status() >= 500)).toHaveLength(0);
    const after = await getInvoice(owner, org.id, invoice.id);
    expect(after.balanceCents).toBeGreaterThanOrEqual(0);
    expect(after.paidCents).toBe(14 * 700);
    expect(results.filter((r) => r.status() === 200)).toHaveLength(14);
  });

  test('[hz3.12][R3.4][H:validation:3] payment amounts must be positive integer cents within the balance -> 422 otherwise', async ({ playwright }) => {
    const { owner, org, invoice } = await setup(playwright, 5000);
    for (const [label, amount] of [
      ['zero', 0],
      ['negative (would raise the balance)', -5000],
      ['fractional', 10.5],
      ['string', '100'],
      ['above the balance', 5001],
      ['far above 2^53', 1e17],
    ] as const) {
      await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices/${invoice.id}/payments`, { amountCents: amount, method: 'cash' }), 422, label);
    }
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ paidCents: 0, balanceCents: 5000 });
  });

  test('[hz3.13][R3.3][H:data-loss:3] an invoice with payments cannot be voided; the payments and balance survive', async ({ playwright }) => {
    const { owner, org, invoice, secret, anon } = await setup(playwright, 8000);
    await expectStatus(await pay(owner, org.id, invoice.id, 1000), 201, 'manual');
    await expectStatus(await deliver(anon, org.id, secret, payflowEvent('payment.succeeded', invoice.id, 2000)), 200, 'webhook');
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices/${invoice.id}/void`), 422, 'void');
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ status: 'issued', paidCents: 3000, balanceCents: 5000 });
    expect(await payments(owner, org.id, invoice.id)).toHaveLength(2);
  });
});

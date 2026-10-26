/** Hazard tests, checkpoint 2 (customers, invoices, money, numbering). See hazards/PROOF.md. */
import { expect, test } from '@playwright/test';
import {
  createCustomer,
  createDraft,
  expectStatus,
  getInvoice,
  invoiceBody,
  issue,
  issuedInvoice,
  line,
  ownerWithOrg,
  team,
  uniqEmail,
} from '../../support';

test.describe('Hazards CP2', () => {
  test('[hz2.01][R1.1][H:authz:3] another organization\'s invoice is 404 for every read and write, through either organization\'s path, and stays unchanged', async ({ playwright }) => {
    const victim = await ownerWithOrg(playwright);
    const c = await createCustomer(victim.owner, victim.org.id);
    const draft = await createDraft(victim.owner, victim.org.id, c.id, [line(5000)]);
    const issued = await issuedInvoice(victim.owner, victim.org.id, [line(7000)]);
    const { owner: attacker, org: attackerOrg } = await ownerWithOrg(playwright);
    for (const orgId of [victim.org.id, attackerOrg.id]) {
      const base = `/api/orgs/${orgId}/invoices`;
      await expectStatus(await attacker.get(`${base}/${draft.id}`), 404, `GET via ${orgId}`);
      await expectStatus(await attacker.patch(`${base}/${draft.id}`, { notes: 'pwned', lines: [line(1)] }), 404, `PATCH via ${orgId}`);
      await expectStatus(await attacker.post(`${base}/${draft.id}/issue`), 404, `issue via ${orgId}`);
      await expectStatus(await attacker.post(`${base}/${issued.invoice.id}/void`), 404, `void via ${orgId}`);
      await expectStatus(await attacker.delete(`${base}/${draft.id}`), 404, `DELETE via ${orgId}`);
      await expectStatus(await attacker.patch(`/api/orgs/${orgId}/customers/${c.id}`, { name: 'pwned' }), 404, `PATCH customer via ${orgId}`);
      await expectStatus(await attacker.delete(`/api/orgs/${orgId}/customers/${c.id}`), 404, `DELETE customer via ${orgId}`);
    }
    const after = await getInvoice(victim.owner, victim.org.id, draft.id);
    expect(after).toMatchObject({ status: 'draft', totalCents: 5000 });
    expect(after.notes ?? null).toBeNull();
    expect((await getInvoice(victim.owner, victim.org.id, issued.invoice.id)).status).toBe('issued');
    expect((await expectStatus(await victim.owner.get(`/api/orgs/${victim.org.id}/customers/${c.id}`), 200, 'customer')).name).toBe(c.name);
  });

  test('[hz2.02][R2.5][H:authz:3] an invoice cannot reference another organization\'s customer (422 on create and edit; nothing stored)', async ({ playwright }) => {
    const victim = await ownerWithOrg(playwright);
    const theirs = await createCustomer(victim.owner, victim.org.id);
    const { owner, org } = await ownerWithOrg(playwright);
    const mine = await createCustomer(owner, org.id);
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices`, invoiceBody(theirs.id, [line(100)])), 422, 'create');
    const draft = await createDraft(owner, org.id, mine.id);
    await expectStatus(await owner.patch(`/api/orgs/${org.id}/invoices/${draft.id}`, { customerId: theirs.id }), 422, 'edit');
    const list = (await (await owner.get(`/api/orgs/${org.id}/invoices`)).json()) as any[];
    expect(list).toHaveLength(1);
    expect(String(list[0].customerId)).toBe(mine.id);
    expect(await (await victim.owner.get(`/api/orgs/${victim.org.id}/invoices`)).json()).toEqual([]);
  });

  test('[hz2.03][R1.2][H:authz:3] a viewer cannot create, edit, issue, void or delete anything (403) and nothing changes', async ({ playwright }) => {
    const t = await team(playwright);
    const base = `/api/orgs/${t.org.id}`;
    const c = await createCustomer(t.owner, t.org.id);
    const draft = await createDraft(t.owner, t.org.id, c.id);
    const { invoice } = await issuedInvoice(t.owner, t.org.id);
    await expectStatus(await t.viewer.post(`${base}/customers`, { name: 'V', email: uniqEmail() }), 403, 'create customer');
    await expectStatus(await t.viewer.post(`${base}/invoices`, invoiceBody(c.id, [line(100)])), 403, 'create invoice');
    await expectStatus(await t.viewer.patch(`${base}/invoices/${draft.id}`, { lines: [line(1)] }), 403, 'edit');
    await expectStatus(await t.viewer.post(`${base}/invoices/${draft.id}/issue`), 403, 'issue');
    await expectStatus(await t.viewer.post(`${base}/invoices/${invoice.id}/void`), 403, 'void');
    await expectStatus(await t.viewer.delete(`${base}/invoices/${draft.id}`), 403, 'delete');
    await expectStatus(await t.viewer.delete(`${base}/customers/${c.id}`), 403, 'delete customer');
    expect((await getInvoice(t.owner, t.org.id, draft.id)).status).toBe('draft');
    expect((await getInvoice(t.owner, t.org.id, invoice.id)).status).toBe('issued');
    expect(((await (await t.owner.get(`${base}/customers`)).json()) as any[]).length).toBe(2);
  });

  test('[hz2.04][R2.6][H:validation:3] amounts must be integer cents in range: negative, 10.005, above 2^53 or numeric strings -> 422', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const ok = { description: 'Item', quantity: 1, unitPriceCents: 100, taxRateBps: 0 };
    const post = (l: object) => owner.post(`/api/orgs/${org.id}/invoices`, invoiceBody(c.id, [l as any]));
    for (const [label, l] of [
      ['negative price', { ...ok, unitPriceCents: -100 }],
      ['10.005 cents', { ...ok, unitPriceCents: 10.005 }],
      ['2^53 + 2 cents', { ...ok, unitPriceCents: 9007199254740994 }],
      ['1e20 cents', { ...ok, unitPriceCents: 1e20 }],
      ['price as string', { ...ok, unitPriceCents: '100' }],
      ['negative quantity', { ...ok, quantity: -3 }],
      ['huge quantity', { ...ok, quantity: 1e9 }],
      ['negative tax', { ...ok, taxRateBps: -1600 }],
      ['fractional tax', { ...ok, taxRateBps: 1600.5 }],
    ] as const) {
      await expectStatus(await post(l), 422, label);
    }
    const draft = await createDraft(owner, org.id, c.id);
    await expectStatus(await owner.patch(`/api/orgs/${org.id}/invoices/${draft.id}`, { lines: [{ ...ok, unitPriceCents: -1 }] }), 422, 'edit to negative');
    expect(((await (await owner.get(`/api/orgs/${org.id}/invoices`)).json()) as any[]).map((i) => i.totalCents)).toEqual([10_000]);
  });

  test('[hz2.05][R2.10][H:concurrency:3] 20 drafts issued at the same moment get INV-0001..INV-0020 with no gaps or duplicates', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const drafts = [];
    for (let i = 0; i < 20; i++) drafts.push(await createDraft(owner, org.id, c.id, [line(100 + i)]));
    const results = await Promise.all(drafts.map((d) => owner.post(`/api/orgs/${org.id}/invoices/${d.id}/issue`)));
    expect(results.map((r) => r.status())).toEqual(Array(20).fill(200));
    const numbers = await Promise.all(drafts.map(async (d) => (await getInvoice(owner, org.id, d.id)).number));
    const expected = Array.from({ length: 20 }, (_, i) => `INV-${String(i + 1).padStart(4, '0')}`);
    expect([...numbers].sort()).toEqual(expected);
  });

  test('[hz2.06][R2.10][H:concurrency:2] the same draft issued by 10 simultaneous requests: exactly one succeeds and one number is consumed', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const draft = await createDraft(owner, org.id, c.id);
    const results = await Promise.all(Array.from({ length: 10 }, () => owner.post(`/api/orgs/${org.id}/invoices/${draft.id}/issue`)));
    const statuses = results.map((r) => r.status()).sort();
    expect(statuses).toEqual([200, ...Array(9).fill(422)]);
    expect((await getInvoice(owner, org.id, draft.id)).number).toBe('INV-0001');
    const next = await issue(owner, org.id, (await createDraft(owner, org.id, c.id)).id);
    expect(next.number).toBe('INV-0002');
  });

  test('[hz2.07][R2.10][H:concurrency:2] simultaneous issuing in two organizations keeps two independent gap-free sequences', async ({ playwright }) => {
    const a = await ownerWithOrg(playwright);
    const b = await ownerWithOrg(playwright);
    const ca = await createCustomer(a.owner, a.org.id);
    const cb = await createCustomer(b.owner, b.org.id);
    const da = [];
    const db = [];
    for (let i = 0; i < 8; i++) {
      da.push(await createDraft(a.owner, a.org.id, ca.id));
      db.push(await createDraft(b.owner, b.org.id, cb.id));
    }
    await Promise.all([
      ...da.map((d) => a.owner.post(`/api/orgs/${a.org.id}/invoices/${d.id}/issue`)),
      ...db.map((d) => b.owner.post(`/api/orgs/${b.org.id}/invoices/${d.id}/issue`)),
    ]);
    const expected = Array.from({ length: 8 }, (_, i) => `INV-${String(i + 1).padStart(4, '0')}`);
    const numsA = ((await (await a.owner.get(`/api/orgs/${a.org.id}/invoices`)).json()) as any[]).map((i) => i.number).sort();
    const numsB = ((await (await b.owner.get(`/api/orgs/${b.org.id}/invoices`)).json()) as any[]).map((i) => i.number).sort();
    expect(numsA).toEqual(expected);
    expect(numsB).toEqual(expected);
  });

  test('[hz2.08][R2.9][H:data-loss:2] an issued invoice cannot be edited or deleted: its number, lines and totals survive', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(1234, 2, 1600), line(99)]);
    const base = `/api/orgs/${org.id}/invoices/${invoice.id}`;
    await expectStatus(await owner.patch(base, { lines: [line(1)] }), 422, 'replace lines');
    await expectStatus(await owner.patch(base, { dueDate: '2020-01-01' }), 422, 'change due date');
    await expectStatus(await owner.delete(base), 422, 'delete');
    const after = await getInvoice(owner, org.id, invoice.id);
    expect(after).toMatchObject({ number: invoice.number, status: 'issued', totalCents: invoice.totalCents, dueDate: invoice.dueDate });
    expect(after.lines).toHaveLength(2);
  });

  test('[hz2.09][R2.3][H:data-loss:2] deleting a customer that has invoices is refused and its invoices stay intact', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { customer, invoice } = await issuedInvoice(owner, org.id, [line(4200)]);
    const draft = await createDraft(owner, org.id, customer.id);
    await expectStatus(await owner.delete(`/api/orgs/${org.id}/customers/${customer.id}`), 409, 'delete customer');
    expect(await getInvoice(owner, org.id, invoice.id)).toMatchObject({ customerName: customer.name, totalCents: 4200 });
    expect((await getInvoice(owner, org.id, draft.id)).status).toBe('draft');
    await expectStatus(await owner.get(`/api/orgs/${org.id}/customers/${customer.id}`), 200, 'customer remains');
  });
});

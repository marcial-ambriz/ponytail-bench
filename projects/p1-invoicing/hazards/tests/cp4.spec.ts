/** Hazard tests, checkpoint 4 (CSV import, audit log). See hazards/PROOF.md. */
import { expect, test } from '@playwright/test';
import {
  auditEntries,
  createCustomer,
  expectOneOf,
  expectStatus,
  issuedInvoice,
  line,
  ownerWithOrg,
  pay,
  team,
  uniqEmail,
} from '../../support';

const INVOICE_HEADER = 'invoice_ref,customer_email,due_date,description,quantity,unit_price,tax_rate';

test.describe('Hazards CP4 - import', () => {
  test('[hz4.01][R4.3][H:data-loss:3] a customers file with one bad row imports nothing and reports that row', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const rows = Array.from({ length: 50 }, (_, i) => `Customer ${i},${uniqEmail(`c${i}`)}`);
    rows.splice(37, 0, 'Broken,not-an-email'); // file line 39
    const res = await owner.postText(`/api/orgs/${org.id}/imports/customers`, ['name,email', ...rows].join('\n'));
    const body = await expectStatus(res, 422, 'import');
    expect((body.rows as any[]).map((r) => Number(r.row))).toEqual([39]);
    expect(await (await owner.get(`/api/orgs/${org.id}/customers`)).json()).toEqual([]);
  });

  test('[hz4.02][R4.3][H:data-loss:3] an invoices file whose last row is bad creates no invoice at all', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const rows = Array.from({ length: 30 }, (_, i) => `REF${i % 10},${c.email},2031-01-31,Line ${i},1,${i + 1}.00,16`);
    rows.push(`REF9,${c.email},2031-01-31,Bad line,0,1.00,16`); // quantity 0, file line 32
    const res = await owner.postText(`/api/orgs/${org.id}/imports/invoices`, [INVOICE_HEADER, ...rows].join('\n'));
    const body = await expectStatus(res, 422, 'import');
    expect((body.rows as any[]).map((r) => Number(r.row))).toEqual([32]);
    expect(await (await owner.get(`/api/orgs/${org.id}/invoices`)).json()).toEqual([]);
  });

  test('[hz4.03][R4.5][H:validation:2] CSV amounts are validated like API amounts: 3 decimals, negatives, exponents and garbage are row errors', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const bad = ['10.005', '-5', '1e3', 'abc', '12.5.0', '$10', '1,000.00', ''];
    const rows = bad.map((p, i) => `R${i},${c.email},2031-01-31,Item,1,"${p}",0`);
    rows.push(`T,${c.email},2031-01-31,Tax,1,10,-1`, `U,${c.email},2031-01-31,Tax,1,10,16.255`);
    const res = await owner.postText(`/api/orgs/${org.id}/imports/invoices`, [INVOICE_HEADER, ...rows].join('\n'));
    const body = await expectStatus(res, 422, 'import');
    expect((body.rows as any[]).map((r) => Number(r.row)).sort((a, b) => a - b)).toEqual(Array.from({ length: bad.length + 2 }, (_, i) => i + 2));
    expect(await (await owner.get(`/api/orgs/${org.id}/invoices`)).json()).toEqual([]);
  });

  test('[hz4.04][R4.3][H:concurrency:2] the same customers file imported twice at the same moment creates each customer once', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const csv = ['name,email', ...Array.from({ length: 40 }, (_, i) => `Twin ${i},${uniqEmail(`twin${i}`)}`)].join('\n');
    const results = await Promise.all([1, 2, 3].map(() => owner.postText(`/api/orgs/${org.id}/imports/customers`, csv)));
    const codes = results.map((r) => r.status()).sort();
    expect(codes.filter((s) => s === 201), codes.join(',')).toHaveLength(1);
    const list = (await (await owner.get(`/api/orgs/${org.id}/customers`)).json()) as any[];
    expect(list).toHaveLength(40);
    expect(new Set(list.map((c) => c.email.toLowerCase())).size).toBe(40);
  });

  test('[hz4.05][R4.5][H:authz:3] an invoices import cannot reference another organization\'s customer', async ({ playwright }) => {
    const victim = await ownerWithOrg(playwright);
    const theirs = await createCustomer(victim.owner, victim.org.id);
    const { owner, org } = await ownerWithOrg(playwright);
    const res = await owner.postText(`/api/orgs/${org.id}/imports/invoices`, `${INVOICE_HEADER}\nX,${theirs.email},2031-01-31,Item,1,10,0\n`);
    await expectStatus(res, 422, 'import with a foreign customer');
    expect(await (await owner.get(`/api/orgs/${org.id}/invoices`)).json()).toEqual([]);
    expect(await (await victim.owner.get(`/api/orgs/${victim.org.id}/invoices`)).json()).toEqual([]);
  });
});

test.describe('Hazards CP4 - audit log', () => {
  test('[hz4.06][R4.8][H:data-loss:3] no request can edit or delete audit entries', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    await expectStatus(await owner.patch(`/api/orgs/${org.id}/customers/${c.id}`, { name: 'Changed' }), 200, 'PATCH');
    const before = await auditEntries(owner, org.id);
    expect(before.length).toBeGreaterThanOrEqual(2);
    for (const e of before) {
      for (const method of ['DELETE', 'PATCH', 'PUT'] as const) {
        const res = await owner.send(method, `/api/orgs/${org.id}/audit/${e.id}`, method === 'DELETE' ? undefined : { action: 'nothing.happened' });
        await expectOneOf(res, [404, 405], `${method} entry`);
      }
    }
    await expectOneOf(await owner.delete(`/api/orgs/${org.id}/audit`), [404, 405], 'DELETE log');
    await expectOneOf(await owner.delete(`/api/orgs/${org.id}/audit?entityType=customer`), [404, 405], 'DELETE filtered log');
    expect(await auditEntries(owner, org.id)).toEqual(before);
  });

  test('[hz4.07][R4.7][H:data-loss:2] every successful change leaves exactly one audit entry for its entity', async ({ playwright }) => {
    const t = await team(playwright);
    const { customer, invoice } = await issuedInvoice(t.accountant, t.org.id, [line(3000)]);
    const p = await expectStatus(await pay(t.accountant, t.org.id, invoice.id, 1000), 201, 'pay');
    await expectStatus(await t.accountant.patch(`/api/orgs/${t.org.id}/customers/${customer.id}`, { name: 'New name' }), 200, 'rename');
    const entries = await auditEntries(t.owner, t.org.id);
    const forEntity = (type: string, id: string) => entries.filter((e) => e.entityType === type && String(e.entityId) === id).map((e) => e.action);
    expect(forEntity('customer', customer.id).sort()).toEqual(['customer.created', 'customer.updated']);
    expect(forEntity('invoice', invoice.id).sort()).toEqual(['invoice.created', 'invoice.issued']);
    expect(forEntity('payment', String(p.id))).toEqual(['payment.recorded']);
    for (const e of entries.filter((x) => ['customer', 'invoice', 'payment'].includes(x.entityType))) {
      expect(String(e.actorId)).toBe(t.accountant.user!.id);
    }
  });

  test('[hz4.08][R4.9][H:authz:2] viewers cannot read the audit log or import; outsiders get 404 for both', async ({ playwright }) => {
    const t = await team(playwright);
    await createCustomer(t.owner, t.org.id);
    await expectStatus(await t.viewer.get(`/api/orgs/${t.org.id}/audit`), 403, 'viewer audit');
    await expectStatus(await t.viewer.postText(`/api/orgs/${t.org.id}/imports/customers`, `name,email\nV,${uniqEmail()}\n`), 403, 'viewer import');
    const { owner: stranger } = await ownerWithOrg(playwright);
    await expectStatus(await stranger.get(`/api/orgs/${t.org.id}/audit`), 404, 'outsider audit');
    await expectStatus(await stranger.postText(`/api/orgs/${t.org.id}/imports/customers`, `name,email\nS,${uniqEmail()}\n`), 404, 'outsider import');
    expect(((await (await t.owner.get(`/api/orgs/${t.org.id}/customers`)).json()) as any[]).length).toBe(1);
  });
});

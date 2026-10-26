/** C2 API probes for checkpoint 4: CSV import (all or nothing) and the append-only audit log (spec/cp4.md). */
import { expect, test } from '@playwright/test';
import {
  addMember,
  anonApi,
  auditEntries,
  createCustomer,
  createDraft,
  deliver,
  expectOneOf,
  expectStatus,
  invite,
  issue,
  issuedInvoice,
  line,
  ownerWithOrg,
  pay,
  payflowEvent,
  signUp,
  team,
  uniq,
  uniqEmail,
  webhookSecret,
  type Api,
  type Json,
} from '../../support';

const customersCsv = (rows: string[][], header = 'name,email') => [header, ...rows.map((r) => r.join(','))].join('\n') + '\n';
const INVOICE_HEADER = 'invoice_ref,customer_email,due_date,description,quantity,unit_price,tax_rate';

async function customers(api: Api, orgId: string): Promise<Json[]> {
  return expectStatus(await api.get(`/api/orgs/${orgId}/customers`), 200, 'GET customers');
}
async function invoices(api: Api, orgId: string): Promise<Json[]> {
  return expectStatus(await api.get(`/api/orgs/${orgId}/invoices`), 200, 'GET invoices');
}
const importCustomers = (api: Api, orgId: string, csv: string) => api.postText(`/api/orgs/${orgId}/imports/customers`, csv);
const importInvoices = (api: Api, orgId: string, csv: string) => api.postText(`/api/orgs/${orgId}/imports/invoices`, csv);

/** The `rows` report of a rejected import, as { line: messages[] }. */
async function rowReport(res: Awaited<ReturnType<typeof importCustomers>>, label: string): Promise<Map<number, string[]>> {
  const body = await expectStatus(res, 422, label);
  expect(Array.isArray(body.rows), `${label}: 422 body has rows[]`).toBe(true);
  const map = new Map<number, string[]>();
  for (const r of body.rows) {
    expect(Array.isArray(r.errors) && r.errors.length > 0, `${label}: row ${r.row} has errors`).toBe(true);
    map.set(Number(r.row), r.errors);
  }
  return map;
}

test.describe('Probes CP4 - CSV import', () => {
  test('[cp4.20][R4.4][C2] customers import -> 201 { imported }; quoted fields, CRLF, BOM, blank lines and any column order are accepted', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const e1 = uniqEmail('imp');
    const e2 = uniqEmail('imp');
    const e3 = uniqEmail('imp');
    const csv = `﻿email,name\r\n${e1},"Doe, Jane"\r\n\r\n${e2},"The ""Best"" Co"\r\n${e3},Plain Name\r\n`;
    const body = await expectStatus(await importCustomers(owner, org.id, csv), 201, 'import customers');
    expect(body).toEqual({ imported: 3 });
    const names = Object.fromEntries((await customers(owner, org.id)).map((c) => [c.email, c.name]));
    expect(names).toEqual({ [e1]: 'Doe, Jane', [e2]: 'The "Best" Co', [e3]: 'Plain Name' });
  });

  test('[cp4.21][R4.3][C2] one invalid row rejects the whole file: 422 lists every invalid row by file line number and nothing is stored', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const csv = customersCsv([
      ['Good One', uniqEmail()], // line 2
      ['', uniqEmail()], // line 3: empty name
      ['Good Two', uniqEmail()], // line 4
      ['Bad Email', 'not-an-email'], // line 5
      ['x'.repeat(121), uniqEmail()], // line 6: name too long
    ]);
    const report = await rowReport(await importCustomers(owner, org.id, csv), 'import with bad rows');
    expect([...report.keys()].sort((a, b) => a - b)).toEqual([3, 5, 6]);
    expect(await customers(owner, org.id)).toHaveLength(0);
  });

  test('[cp4.22][R4.4][C2] an email already in the organization or repeated in the file makes each such row invalid', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const existing = await createCustomer(owner, org.id);
    const twice = uniqEmail('twice');
    const csv = customersCsv([
      ['A', uniqEmail()], // 2
      ['B', existing.email.toUpperCase()], // 3: exists (case-insensitive)
      ['C', twice], // 4
      ['D', twice.toUpperCase()], // 5: repeated
    ]);
    const report = await rowReport(await importCustomers(owner, org.id, csv), 'duplicates');
    expect([...report.keys()].sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(await customers(owner, org.id)).toHaveLength(1);
  });

  test('[cp4.23][R4.2][C2] file-level problems -> 422: empty file, header only, missing or unknown column, more than 1000 rows', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    await expectStatus(await importCustomers(owner, org.id, ''), 422, 'empty file');
    await expectStatus(await importCustomers(owner, org.id, 'name,email\n'), 422, 'header only');
    await expectStatus(await importCustomers(owner, org.id, `name\nSolo\n`), 422, 'missing column');
    await expectStatus(await importCustomers(owner, org.id, `name,email,phone\nA,${uniqEmail()},1\n`), 422, 'unknown column');
    const many = customersCsv(Array.from({ length: 1001 }, (_, i) => [`Bulk ${i}`, uniqEmail(`bulk${i}`)]));
    await expectStatus(await importCustomers(owner, org.id, many), 422, '1001 rows');
    expect(await customers(owner, org.id)).toHaveLength(0);
    const max = customersCsv(Array.from({ length: 1000 }, (_, i) => [`Bulk ${i}`, uniqEmail(`max${i}`)]));
    expect(await expectStatus(await importCustomers(owner, org.id, max), 201, '1000 rows')).toEqual({ imported: 1000 });
  });

  test('[cp4.24][R4.5][C2] invoices import: rows sharing invoice_ref become one draft with lines in file order; decimals convert exactly', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const a = await createCustomer(owner, org.id, { name: 'Import A' });
    const b = await createCustomer(owner, org.id, { name: 'Import B' });
    const csv = [
      INVOICE_HEADER,
      `R1,${a.email},2031-01-31,Design,3,19.99,8.25`,
      `R2,${b.email.toUpperCase()},2031-02-28,"Hosting, yearly",1,0.29,16`,
      `R1,${a.email},2031-01-31,Support,1,5,0`,
      `R1,${a.email},2031-01-31,Extra,2,0.5,0.5`,
    ].join('\n');
    expect(await expectStatus(await importInvoices(owner, org.id, csv), 201, 'import invoices')).toEqual({ imported: 2 });
    const list = await invoices(owner, org.id);
    expect(list).toHaveLength(2);
    const full = await Promise.all(list.map(async (i) => expectStatus(await owner.get(`/api/orgs/${org.id}/invoices/${i.id}`), 200, 'GET invoice')));
    const r1 = full.find((i) => i.customerName === 'Import A');
    const r2 = full.find((i) => i.customerName === 'Import B');
    expect(r1).toMatchObject({ status: 'draft', number: null, dueDate: '2031-01-31' });
    expect(r1.lines.map((l: Json) => [l.description, l.quantity, l.unitPriceCents, l.taxRateBps])).toEqual([
      ['Design', 3, 1999, 825],
      ['Support', 1, 500, 0],
      ['Extra', 2, 50, 50],
    ]);
    // 5997 + 495 tax (494.7525) ; 500 ; 100 + 1 tax (0.5)
    expect(r1).toMatchObject({ subtotalCents: 6597, taxCents: 496, totalCents: 7093 });
    expect(r2.lines.map((l: Json) => [l.description, l.unitPriceCents, l.taxRateBps])).toEqual([['Hosting, yearly', 29, 1600]]);
    expect(r2).toMatchObject({ dueDate: '2031-02-28', totalCents: 34 });
  });

  test('[cp4.25][R4.5][C2] invalid invoice rows are all reported (unknown customer, bad decimals, bad quantity, mismatched ref) and nothing is stored', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const a = await createCustomer(owner, org.id);
    const b = await createCustomer(owner, org.id);
    const other = await ownerWithOrg(playwright);
    const theirs = await createCustomer(other.owner, other.org.id);
    const csv = [
      INVOICE_HEADER,
      `OK,${a.email},2031-01-31,Fine,1,10.00,16`, // 2 valid
      `X1,${uniqEmail('ghost')},2031-01-31,Ghost,1,10,0`, // 3 unknown customer
      `X2,${a.email},2031-01-31,Fraction,1,10.005,0`, // 4 three decimals
      `X3,${a.email},2031-01-31,Negative,1,-5,0`, // 5 negative price
      `X4,${a.email},2031-01-31,Words,abc,10,0`, // 6 quantity not a number
      `X5,${a.email},2031-01-31,Half,1.5,10,0`, // 7 fractional quantity
      `X6,${a.email},2031-01-31,Tax,1,10,100.01`, // 8 tax above 100%
      `X7,${a.email},2031-02-30,Date,1,10,0`, // 9 impossible date
      `M,${a.email},2031-01-31,Mixed one,1,10,0`, // 10 \ same ref,
      `M,${b.email},2031-01-31,Mixed two,1,10,0`, // 11 / different customer
      `X8,${theirs.email},2031-01-31,Foreign,1,10,0`, // 12 customer of another organization
      `X9,${a.email},2031-01-31,Huge,1,1000000.01,0`, // 13 unit price above 1,000,000.00
    ].join('\r\n');
    const report = await rowReport(await importInvoices(owner, org.id, csv), 'bad invoice rows');
    expect([...report.keys()].sort((x, y) => x - y)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(await invoices(owner, org.id)).toHaveLength(0);
  });

  test('[cp4.26][R4.1][C2] imports need owner or accountant: viewers -> 403 (nothing stored); outsiders -> 404', async ({ playwright }) => {
    const t = await team(playwright);
    const csv = customersCsv([['Role Test', uniqEmail()]]);
    await expectStatus(await importCustomers(t.viewer, t.org.id, csv), 403, 'viewer customers');
    await expectStatus(await importInvoices(t.viewer, t.org.id, `${INVOICE_HEADER}\nR,${uniqEmail()},2031-01-01,x,1,1,0\n`), 403, 'viewer invoices');
    const stranger = await signUp(playwright);
    await expectStatus(await importCustomers(stranger, t.org.id, csv), 404, 'outsider');
    expect(await customers(t.owner, t.org.id)).toHaveLength(0);
    await expectStatus(await importCustomers(t.accountant, t.org.id, csv), 201, 'accountant');
  });
});

test.describe('Probes CP4 - audit log', () => {
  const actions = (entries: Json[]) => entries.map((e) => e.action);

  test('[cp4.27][R4.7][C2] customer and invoice mutations append one entry each { id, at, actorId, actorName, action, entityType, entityId }', async ({ playwright }) => {
    const t = await team(playwright);
    const before = (await auditEntries(t.owner, t.org.id)).length;
    const c = await createCustomer(t.accountant, t.org.id);
    await expectStatus(await t.accountant.patch(`/api/orgs/${t.org.id}/customers/${c.id}`, { name: 'Renamed' }), 200, 'PATCH customer');
    const d = await createDraft(t.accountant, t.org.id, c.id);
    await expectStatus(await t.accountant.patch(`/api/orgs/${t.org.id}/invoices/${d.id}`, { notes: 'n' }), 200, 'PATCH invoice');
    await issue(t.accountant, t.org.id, d.id);
    await expectStatus(await t.accountant.post(`/api/orgs/${t.org.id}/invoices/${d.id}/void`), 200, 'void');
    const d2 = await createDraft(t.accountant, t.org.id, c.id);
    await expectStatus(await t.accountant.delete(`/api/orgs/${t.org.id}/invoices/${d2.id}`), 200, 'DELETE draft');
    const c2 = await createCustomer(t.accountant, t.org.id);
    await expectStatus(await t.accountant.delete(`/api/orgs/${t.org.id}/customers/${c2.id}`), 200, 'DELETE customer');
    const { invoice } = await issuedInvoice(t.owner, t.org.id, [line(1000)]);
    const p = await expectStatus(await pay(t.owner, t.org.id, invoice.id, 400), 201, 'payment');

    const entries = await auditEntries(t.owner, t.org.id);
    const fresh = entries.slice(0, entries.length - before);
    expect(actions(fresh).reverse()).toEqual([
      'customer.created',
      'customer.updated',
      'invoice.created',
      'invoice.updated',
      'invoice.issued',
      'invoice.voided',
      'invoice.created',
      'invoice.deleted',
      'customer.created',
      'customer.deleted',
      'customer.created',
      'invoice.created',
      'invoice.issued',
      'payment.recorded',
    ]);
    const newest = fresh[0];
    expect(newest).toMatchObject({ action: 'payment.recorded', entityType: 'payment', actorName: t.owner.user!.name });
    expect(String(newest.entityId)).toBe(String(p.id));
    expect(String(newest.actorId)).toBe(t.owner.user!.id);
    expect(newest.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(newest.at))).toBe(false);
    const voided = fresh.find((e) => e.action === 'invoice.voided')!;
    expect(voided).toMatchObject({ entityType: 'invoice', actorName: t.accountant.user!.name });
    expect(String(voided.entityId)).toBe(d.id);
  });

  test('[cp4.28][R4.7][C2] webhook changes are logged with a null actor; repeated deliveries append nothing', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { invoice } = await issuedInvoice(owner, org.id, [line(5000)]);
    const secret = await webhookSecret(owner, org.id);
    const anon = await anonApi(playwright);
    const before = (await auditEntries(owner, org.id)).length;
    const ok = payflowEvent('payment.succeeded', invoice.id, 5000);
    for (let i = 0; i < 3; i++) await expectStatus(await deliver(anon, org.id, secret, ok), 200, `deliver ${i}`);
    const refund = payflowEvent('payment.refunded', invoice.id, 5000, { paymentId: ok.data.paymentId });
    await expectStatus(await deliver(anon, org.id, secret, refund), 200, 'refund');
    await expectStatus(await deliver(anon, org.id, secret, refund), 200, 'refund again');
    const entries = await auditEntries(owner, org.id);
    const fresh = entries.slice(0, entries.length - before);
    expect(actions(fresh)).toEqual(['payment.refunded', 'payment.recorded']);
    for (const e of fresh) {
      expect(e.actorId).toBeNull();
      expect(e.actorName).toBeNull();
      expect(e.entityType).toBe('payment');
    }
  });

  test('[cp4.29][R4.7][C2] failed requests (403, 404, 409, 422) and rejected imports append nothing', async ({ playwright }) => {
    const t = await team(playwright);
    const { customer: c, invoice } = await issuedInvoice(t.owner, t.org.id, [line(1000)]);
    const before = await auditEntries(t.owner, t.org.id);
    const base = `/api/orgs/${t.org.id}`;
    await expectStatus(await t.viewer.post(`${base}/customers`, { name: 'No', email: uniqEmail() }), 403, 'viewer');
    await expectStatus(await t.owner.post(`${base}/customers`, { name: 'Dup', email: c.email }), 409, 'duplicate');
    await expectStatus(await t.owner.post(`${base}/customers`, { name: '', email: 'bad' }), 422, 'invalid');
    await expectStatus(await pay(t.owner, t.org.id, invoice.id, 5000), 422, 'overpay');
    await expectStatus(await t.owner.post(`${base}/invoices/${invoice.id}/issue`), 422, 'issue twice');
    await expectStatus(await t.owner.delete(`${base}/customers/${c.id}`), 409, 'delete customer with invoices');
    await expectStatus(await t.owner.patch(`${base}/members/${t.owner.user!.id}`, { role: 'viewer' }), 422, 'last owner');
    await expectStatus(await importCustomers(t.owner, t.org.id, customersCsv([['A', uniqEmail()], ['', 'x']])), 422, 'bad import');
    await expectStatus(await t.owner.get(`${base}/invoices/${invoice.id}x`), 404, 'unknown');
    expect(await auditEntries(t.owner, t.org.id)).toEqual(before);
  });

  test('[cp4.30][R4.7][C2] member, invitation, settings and import changes are logged with their documented actions', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const before = (await auditEntries(owner, org.id)).length;
    const invitee = await signUp(playwright);
    const inv = await invite(owner, org.id, invitee.user!.email, 'viewer');
    await expectStatus(await invitee.post(`/api/invitations/${inv.token}/accept`), 200, 'accept');
    await expectStatus(await owner.patch(`/api/orgs/${org.id}/members/${invitee.user!.id}`, { role: 'accountant' }), 200, 'role');
    await expectStatus(await owner.delete(`/api/orgs/${org.id}/members/${invitee.user!.id}`), 200, 'remove');
    await expectStatus(await owner.post(`/api/orgs/${org.id}/settings/webhook/rotate`), 200, 'rotate');
    const c = await createCustomer(owner, org.id);
    await expectStatus(await importCustomers(owner, org.id, customersCsv([['One', uniqEmail()], ['Two', uniqEmail()]])), 201, 'import customers');
    await expectStatus(await importInvoices(owner, org.id, `${INVOICE_HEADER}\nA,${c.email},2031-01-01,x,1,1,0\nB,${c.email},2031-01-01,y,1,1,0\n`), 201, 'import invoices');
    const entries = await auditEntries(owner, org.id);
    const fresh = entries.slice(0, entries.length - before).reverse();
    expect(actions(fresh)).toEqual([
      'invitation.created',
      'invitation.accepted',
      'member.role_changed',
      'member.removed',
      'webhook.secret_rotated',
      'customer.created',
      'import.customers',
      'import.invoices',
    ]);
    expect(fresh.map((e) => e.entityType)).toEqual(['invitation', 'invitation', 'member', 'member', 'organization', 'customer', 'import', 'import']);
    expect(fresh[1].actorName).toBe(invitee.user!.name);
    expect(String(fresh[2].entityId)).toBe(invitee.user!.id);
    expect(String(fresh[4].entityId)).toBe(org.id);
  });

  test('[cp4.31][R4.9][C2] GET audit: newest first, filters entityType/entityId; viewers -> 403; other organizations\' entries never appear', async ({ playwright }) => {
    const t = await team(playwright);
    const c = await createCustomer(t.owner, t.org.id);
    await expectStatus(await t.owner.patch(`/api/orgs/${t.org.id}/customers/${c.id}`, { name: 'Again' }), 200, 'PATCH');
    const other = await ownerWithOrg(playwright);
    await createCustomer(other.owner, other.org.id);
    await expectStatus(await t.viewer.get(`/api/orgs/${t.org.id}/audit`), 403, 'viewer');
    const all = await auditEntries(t.accountant, t.org.id);
    const ats = all.map((e) => Date.parse(e.at));
    expect([...ats].sort((a, b) => b - a)).toEqual(ats);
    const forCustomer = await auditEntries(t.accountant, t.org.id, `?entityType=customer&entityId=${c.id}`);
    expect(actions(forCustomer)).toEqual(['customer.updated', 'customer.created']);
    const invitations = await auditEntries(t.accountant, t.org.id, '?entityType=invitation');
    expect(invitations.every((e) => e.entityType === 'invitation')).toBe(true);
    const otherIds = new Set((await auditEntries(other.owner, other.org.id)).map((e) => e.id));
    expect(all.some((e) => otherIds.has(e.id))).toBe(false);
    await expectStatus(await t.owner.get(`/api/orgs/${other.org.id}/audit`), 404, 'other organization');
  });

  test('[cp4.32][R4.8][C2] the log is append-only: PUT/PATCH/DELETE on the log or an entry -> 404 or 405 and entries are unchanged', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    await createCustomer(owner, org.id);
    const before = await auditEntries(owner, org.id);
    const id = before[0].id;
    for (const path of [`/api/orgs/${org.id}/audit`, `/api/orgs/${org.id}/audit/${id}`]) {
      await expectOneOf(await owner.delete(path), [404, 405], `DELETE ${path}`);
      await expectOneOf(await owner.patch(path, { action: 'x' }), [404, 405], `PATCH ${path}`);
      await expectOneOf(await owner.put(path, { action: 'x' }), [404, 405], `PUT ${path}`);
    }
    await expectOneOf(await owner.post(`/api/orgs/${org.id}/audit`, { action: 'customer.created', entityType: 'customer', entityId: uniq('fake') }), [404, 405], 'POST audit');
    expect(await auditEntries(owner, org.id)).toEqual(before);
    expect(addMember).toBeTruthy();
  });
});

/** C2 API probes for checkpoint 2: customers, invoices, money, numbering, statuses (spec/cp2.md). */
import { expect, test } from '@playwright/test';
import {
  addDays,
  createCustomer,
  createDraft,
  errorOf,
  expectStatus,
  getInvoice,
  invoiceBody,
  issue,
  line,
  missingId,
  ownerWithOrg,
  team,
  todayUtc,
  uniq,
  uniqEmail,
} from '../../support';

test.describe('Probes CP2 - customers', () => {
  test('[cp2.20][R2.2][C2] customers: POST -> 201 { id, name, email }, GET one, PATCH partial update, list ordered by name', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const base = `/api/orgs/${org.id}/customers`;
    const zed = await expectStatus(await owner.post(base, { name: '  Zed Corp ', email: uniqEmail('zed') }), 201, 'POST customer');
    expect(zed.name).toBe('Zed Corp');
    expect(zed.id).toBeTruthy();
    const alpha = await createCustomer(owner, org.id, { name: 'Alpha Inc' });
    expect(await expectStatus(await owner.get(`${base}/${zed.id}`), 200, 'GET customer')).toMatchObject({ name: 'Zed Corp', email: zed.email });
    const patched = await expectStatus(await owner.patch(`${base}/${alpha.id}`, { name: 'Beta Inc' }), 200, 'PATCH name only');
    expect(patched).toMatchObject({ name: 'Beta Inc', email: alpha.email });
    const list = (await expectStatus(await owner.get(base), 200, 'GET customers')) as any[];
    expect(list.map((c) => c.name)).toEqual(['Beta Inc', 'Zed Corp']);
    await expectStatus(await owner.get(`${base}/${missingId(String(zed.id))}`), 404, 'unknown customer');
  });

  test('[cp2.21][R2.1][C2] customer validation: name 1-120 trimmed characters and a valid email -> else 422', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const base = `/api/orgs/${org.id}/customers`;
    await expectStatus(await owner.post(base, { name: 'x'.repeat(120), email: uniqEmail() }), 201, '120 chars');
    await expectStatus(await owner.post(base, { name: 'Q', email: uniqEmail() }), 201, '1 char');
    for (const [label, body] of [
      ['empty name', { name: '   ', email: uniqEmail() }],
      ['121 chars', { name: 'x'.repeat(121), email: uniqEmail() }],
      ['missing name', { email: uniqEmail() }],
      ['bad email', { name: 'Bad', email: 'nope' }],
      ['missing email', { name: 'Bad' }],
    ] as const) {
      await expectStatus(await owner.post(base, body), 422, label);
    }
    const c = await createCustomer(owner, org.id);
    await expectStatus(await owner.patch(`${base}/${c.id}`, { email: 'still not an email' }), 422, 'PATCH bad email');
  });

  test('[cp2.22][R2.1][C2] customer emails are unique per organization, case-insensitively (409 on POST and PATCH); other organizations may reuse them', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const base = `/api/orgs/${org.id}/customers`;
    const email = uniqEmail('dup');
    const first = await createCustomer(owner, org.id, { email });
    await expectStatus(await owner.post(base, { name: 'Copy', email: email.toUpperCase() }), 409, 'duplicate POST');
    const second = await createCustomer(owner, org.id);
    await expectStatus(await owner.patch(`${base}/${second.id}`, { email: email.toUpperCase() }), 409, 'duplicate PATCH');
    await expectStatus(await owner.patch(`${base}/${first.id}`, { email }), 200, 'PATCH keeping its own email');
    const other = await ownerWithOrg(playwright);
    await createCustomer(other.owner, other.org.id, { email });
    expect(((await (await owner.get(base)).json()) as any[]).length).toBe(2);
  });

  test('[cp2.23][R2.3][C2] a customer with invoices cannot be deleted (409 "has invoices"); one without invoices -> 200, then 404', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const base = `/api/orgs/${org.id}/customers`;
    const busy = await createCustomer(owner, org.id);
    await createDraft(owner, org.id, busy.id);
    const res = await owner.delete(`${base}/${busy.id}`);
    await expectStatus(res, 409, 'DELETE customer with a draft');
    expect((await errorOf(res)).toLowerCase()).toContain('has invoices');
    await expectStatus(await owner.get(`${base}/${busy.id}`), 200, 'still there');
    const free = await createCustomer(owner, org.id);
    await expectStatus(await owner.delete(`${base}/${free.id}`), 200, 'DELETE free customer');
    await expectStatus(await owner.get(`${base}/${free.id}`), 404, 'gone');
  });

  test('[cp2.24][R1.2][C2] viewers read customers and invoices but every write is 403; accountants may write', async ({ playwright }) => {
    const t = await team(playwright);
    const base = `/api/orgs/${t.org.id}`;
    const c = await createCustomer(t.accountant, t.org.id);
    const draft = await createDraft(t.accountant, t.org.id, c.id);
    await expectStatus(await t.viewer.get(`${base}/customers`), 200, 'viewer GET customers');
    await expectStatus(await t.viewer.get(`${base}/invoices`), 200, 'viewer GET invoices');
    await expectStatus(await t.viewer.get(`${base}/invoices/${draft.id}`), 200, 'viewer GET invoice');
    await expectStatus(await t.viewer.post(`${base}/customers`, { name: 'V', email: uniqEmail() }), 403, 'viewer POST customer');
    await expectStatus(await t.viewer.patch(`${base}/customers/${c.id}`, { name: 'V' }), 403, 'viewer PATCH customer');
    await expectStatus(await t.viewer.delete(`${base}/customers/${c.id}`), 403, 'viewer DELETE customer');
    await expectStatus(await t.viewer.post(`${base}/invoices`, invoiceBody(c.id, [line(100)])), 403, 'viewer POST invoice');
    await expectStatus(await t.viewer.patch(`${base}/invoices/${draft.id}`, { notes: 'x' }), 403, 'viewer PATCH invoice');
    await expectStatus(await t.viewer.post(`${base}/invoices/${draft.id}/issue`), 403, 'viewer issue');
    await expectStatus(await t.viewer.delete(`${base}/invoices/${draft.id}`), 403, 'viewer DELETE invoice');
    await expectStatus(await t.viewer.post(`${base}/customers`, { name: '' }), 403, 'invalid AND unauthorized -> 403');
    expect((await getInvoice(t.owner, t.org.id, draft.id)).status).toBe('draft');
  });
});

test.describe('Probes CP2 - invoices', () => {
  test('[cp2.25][R2.12][C2] POST invoice -> 201 draft with number/issueDate null, computed lines and totals, paidCents 0 and balance = total', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id, { name: 'Shape Co' });
    const due = addDays(todayUtc(), 14);
    const body = { customerId: c.id, dueDate: due, notes: 'Thanks', lines: [line(1250, 2, 1600, 'Consulting'), line(999, 1, 0, 'Book')] };
    const inv = await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices`, body), 201, 'POST invoice');
    expect(inv).toMatchObject({
      status: 'draft',
      number: null,
      issueDate: null,
      dueDate: due,
      notes: 'Thanks',
      customerName: 'Shape Co',
      subtotalCents: 3499,
      taxCents: 400,
      totalCents: 3899,
      paidCents: 0,
      balanceCents: 3899,
    });
    expect(String(inv.customerId)).toBe(c.id);
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines[0]).toMatchObject({ description: 'Consulting', quantity: 2, unitPriceCents: 1250, taxRateBps: 1600, subtotalCents: 2500, taxCents: 400, totalCents: 2900 });
    expect(inv.lines[1]).toMatchObject({ description: 'Book', quantity: 1, unitPriceCents: 999, taxRateBps: 0, subtotalCents: 999, taxCents: 0, totalCents: 999 });
    expect(await getInvoice(owner, org.id, String(inv.id))).toMatchObject({ totalCents: 3899, status: 'draft' });
  });

  test('[cp2.26][R2.7][C2] tax is rounded half up per line and the invoice tax is the sum of the rounded line taxes', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const cases: Array<{ lines: ReturnType<typeof line>[]; subtotal: number; tax: number; lineTaxes: number[] }> = [
      // 0.5 + 0.5 -> 1 + 1 = 2 (a tax on the 10-cent subtotal would be 1)
      { lines: [line(5, 1, 1000), line(5, 1, 1000)], subtotal: 10, tax: 2, lineTaxes: [1, 1] },
      // 2.5 -> 3 and 0.25 -> 0 (half up, not half-to-even)
      { lines: [line(25, 1, 1000), line(25, 1, 100)], subtotal: 50, tax: 3, lineTaxes: [3, 0] },
      // 999 x 16.5% = 164.835 -> 165 ; 1.5 -> 2
      { lines: [line(333, 3, 1650), line(15, 1, 1000)], subtotal: 1014, tax: 167, lineTaxes: [165, 2] },
      // 7 x 1.49 at 8.25% = 86.0475 -> 86 ; 3 x 0.29 at 16% = 13.92 -> 14
      { lines: [line(149, 7, 825), line(29, 3, 1600)], subtotal: 1130, tax: 100, lineTaxes: [86, 14] },
    ];
    for (const k of cases) {
      const inv = await createDraft(owner, org.id, c.id, k.lines);
      expect(inv.lines.map((l: any) => l.taxCents), JSON.stringify(k.lines)).toEqual(k.lineTaxes);
      expect(inv.subtotalCents).toBe(k.subtotal);
      expect(inv.taxCents).toBe(k.tax);
      expect(inv.totalCents).toBe(k.subtotal + k.tax);
      for (const l of inv.lines) expect(l.totalCents).toBe(l.subtotalCents + l.taxCents);
    }
    // The extremes stay exact: 1000 x $1,000,000.00 at 100%.
    const big = await createDraft(owner, org.id, c.id, [line(100_000_000, 1000, 10_000), line(100_000_000, 1000, 10_000)]);
    expect(big.subtotalCents).toBe(200_000_000_000);
    expect(big.taxCents).toBe(200_000_000_000);
    expect(big.totalCents).toBe(400_000_000_000);
  });

  test('[cp2.27][R2.6][C2] line values must be integers in range: negative, fractional, numeric-string or out-of-range values -> 422', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const post = (l: Record<string, unknown>) => owner.post(`/api/orgs/${org.id}/invoices`, invoiceBody(c.id, [l as any]));
    const ok = { description: 'Item', quantity: 1, unitPriceCents: 100, taxRateBps: 0 };
    for (const [label, l] of [
      ['quantity 1000', { ...ok, quantity: 1000 }],
      ['unit price 0', { ...ok, unitPriceCents: 0 }],
      ['unit price 100000000', { ...ok, unitPriceCents: 100_000_000 }],
      ['tax 10000 bps', { ...ok, taxRateBps: 10_000 }],
      ['description 200 chars', { ...ok, description: 'd'.repeat(200) }],
    ] as const) {
      await expectStatus(await post(l), 201, label);
    }
    for (const [label, l] of [
      ['quantity 0', { ...ok, quantity: 0 }],
      ['quantity 1001', { ...ok, quantity: 1001 }],
      ['quantity 1.5', { ...ok, quantity: 1.5 }],
      ['quantity "2"', { ...ok, quantity: '2' }],
      ['negative unit price', { ...ok, unitPriceCents: -1 }],
      ['fractional cents 10.005', { ...ok, unitPriceCents: 10.005 }],
      ['unit price 100000001', { ...ok, unitPriceCents: 100_000_001 }],
      ['unit price above 2^53', { ...ok, unitPriceCents: 9007199254740993 }],
      ['unit price "100"', { ...ok, unitPriceCents: '100' }],
      ['tax -1', { ...ok, taxRateBps: -1 }],
      ['tax 10001', { ...ok, taxRateBps: 10_001 }],
      ['tax 12.5', { ...ok, taxRateBps: 12.5 }],
      ['empty description', { ...ok, description: '   ' }],
      ['description 201 chars', { ...ok, description: 'd'.repeat(201) }],
      ['missing unit price', { description: 'Item', quantity: 1, taxRateBps: 0 }],
    ] as const) {
      await expectStatus(await post(l), 422, label);
    }
  });

  test('[cp2.28][R2.5][C2] invoice validation: 1-100 lines, a real calendar due date (past dates allowed), notes <= 1000, a customer of this organization', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const base = `/api/orgs/${org.id}/invoices`;
    await expectStatus(await owner.post(base, invoiceBody(c.id, Array.from({ length: 100 }, () => line(1)))), 201, '100 lines');
    await expectStatus(await owner.post(base, invoiceBody(c.id, [line(100)], '2020-01-15')), 201, 'past due date');
    await expectStatus(await owner.post(base, { ...invoiceBody(c.id, [line(100)]), notes: 'n'.repeat(1000) }), 201, '1000-char notes');
    const foreign = await ownerWithOrg(playwright);
    const theirs = await createCustomer(foreign.owner, foreign.org.id);
    for (const [label, body] of [
      ['no lines', invoiceBody(c.id, [])],
      ['101 lines', invoiceBody(c.id, Array.from({ length: 101 }, () => line(1)))],
      ['Feb 30', invoiceBody(c.id, [line(100)], '2030-02-30')],
      ['not zero-padded', invoiceBody(c.id, [line(100)], '2030-1-5')],
      ['timestamp', invoiceBody(c.id, [line(100)], '2030-01-05T00:00:00Z')],
      ['missing due date', { customerId: c.id, lines: [line(100)] }],
      ['1001-char notes', { ...invoiceBody(c.id, [line(100)]), notes: 'n'.repeat(1001) }],
      ['missing customer', { dueDate: '2030-01-05', lines: [line(100)] }],
      ['unknown customer', invoiceBody(missingId(c.id), [line(100)])],
      ["another organization's customer", invoiceBody(theirs.id, [line(100)])],
    ] as const) {
      await expectStatus(await owner.post(base, body), 422, label);
    }
  });

  test('[cp2.29][R2.10][C2] issuing assigns INV-0001, INV-0002, ... in issue order, sets issueDate to today, per-organization sequences', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const a = await createDraft(owner, org.id, c.id);
    const b = await createDraft(owner, org.id, c.id);
    const d = await createDraft(owner, org.id, c.id);
    const ib = await issue(owner, org.id, b.id);
    expect(ib).toMatchObject({ number: 'INV-0001', status: 'issued', issueDate: todayUtc() });
    expect((await issue(owner, org.id, a.id)).number).toBe('INV-0002');
    expect((await issue(owner, org.id, d.id)).number).toBe('INV-0003');
    expect((await getInvoice(owner, org.id, b.id)).number).toBe('INV-0001');
    const other = await ownerWithOrg(playwright);
    const oc = await createCustomer(other.owner, other.org.id);
    expect((await issue(other.owner, other.org.id, (await createDraft(other.owner, other.org.id, oc.id)).id)).number).toBe('INV-0001');
  });

  test('[cp2.30][R2.10][C2] issuing a non-draft or a zero-total draft -> 422 and consumes no number', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const a = await createDraft(owner, org.id, c.id);
    expect((await issue(owner, org.id, a.id)).number).toBe('INV-0001');
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices/${a.id}/issue`), 422, 'issue twice');
    const zero = await createDraft(owner, org.id, c.id, [line(0, 3, 1600)]);
    expect(zero.totalCents).toBe(0);
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices/${zero.id}/issue`), 422, 'zero total');
    expect((await getInvoice(owner, org.id, zero.id)).status).toBe('draft');
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invoices/${missingId(a.id)}/issue`), 404, 'unknown invoice');
    const b = await createDraft(owner, org.id, c.id);
    expect((await issue(owner, org.id, b.id)).number).toBe('INV-0002');
  });

  test('[cp2.31][R2.9][C2] drafts can be edited (lines replaced, totals recomputed) and deleted; issued invoices cannot (422, unchanged)', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const c2 = await createCustomer(owner, org.id, { name: 'Second' });
    const base = `/api/orgs/${org.id}/invoices`;
    const draft = await createDraft(owner, org.id, c.id, [line(1000), line(2000)]);
    const edited = await expectStatus(
      await owner.patch(`${base}/${draft.id}`, { customerId: c2.id, dueDate: '2031-03-01', notes: 'Edited', lines: [line(500, 2, 1000, 'Only line')] }),
      200,
      'PATCH draft',
    );
    expect(edited).toMatchObject({ customerName: 'Second', dueDate: '2031-03-01', notes: 'Edited', subtotalCents: 1000, taxCents: 100, totalCents: 1100 });
    expect(edited.lines).toHaveLength(1);
    await expectStatus(await owner.patch(`${base}/${draft.id}`, { lines: [{ ...line(1), quantity: -1 }] }), 422, 'PATCH invalid line');
    expect((await getInvoice(owner, org.id, draft.id)).totalCents).toBe(1100);

    const issued = await issue(owner, org.id, draft.id);
    await expectStatus(await owner.patch(`${base}/${draft.id}`, { notes: 'late change' }), 422, 'PATCH issued');
    await expectStatus(await owner.patch(`${base}/${draft.id}`, { lines: [line(1)] }), 422, 'PATCH issued lines');
    await expectStatus(await owner.delete(`${base}/${draft.id}`), 422, 'DELETE issued');
    const after = await getInvoice(owner, org.id, draft.id);
    expect(after).toMatchObject({ status: 'issued', number: issued.number, notes: 'Edited', totalCents: 1100 });

    const gone = await createDraft(owner, org.id, c.id);
    await expectStatus(await owner.delete(`${base}/${gone.id}`), 200, 'DELETE draft');
    await expectStatus(await owner.get(`${base}/${gone.id}`), 404, 'deleted draft');
  });

  test('[cp2.32][R2.11][C2] void: only issued invoices (draft or void -> 422); a voided invoice keeps its number, lines and amounts', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const base = `/api/orgs/${org.id}/invoices`;
    const draft = await createDraft(owner, org.id, c.id, [line(4321, 2, 500)]);
    await expectStatus(await owner.post(`${base}/${draft.id}/void`), 422, 'void draft');
    const issued = await issue(owner, org.id, draft.id);
    const voided = await expectStatus(await owner.post(`${base}/${draft.id}/void`), 200, 'void issued');
    expect(voided).toMatchObject({ status: 'void', number: issued.number, totalCents: issued.totalCents, subtotalCents: 8642 });
    expect(voided.lines ?? (await getInvoice(owner, org.id, draft.id)).lines).toHaveLength(1);
    await expectStatus(await owner.post(`${base}/${draft.id}/void`), 422, 'void twice');
    await expectStatus(await owner.post(`${base}/${draft.id}/issue`), 422, 'issue void');
    await expectStatus(await owner.patch(`${base}/${draft.id}`, { notes: 'x' }), 422, 'edit void');
    const next = await issue(owner, org.id, (await createDraft(owner, org.id, c.id)).id);
    expect(next.number).toBe('INV-0002');
  });

  test('[cp2.33][R2.12][C2] GET invoices: newest first, filtered by status and by customerId', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c1 = await createCustomer(owner, org.id);
    const c2 = await createCustomer(owner, org.id);
    const first = await createDraft(owner, org.id, c1.id);
    const second = await createDraft(owner, org.id, c2.id);
    const third = await createDraft(owner, org.id, c1.id);
    await issue(owner, org.id, second.id);
    const base = `/api/orgs/${org.id}/invoices`;
    const all = (await expectStatus(await owner.get(base), 200, 'GET invoices')) as any[];
    expect(all.map((i) => String(i.id))).toEqual([third.id, second.id, first.id]);
    expect(all[1]).toMatchObject({ status: 'issued', number: 'INV-0001', totalCents: 10_000, balanceCents: 10_000 });
    const drafts = (await (await owner.get(`${base}?status=draft`)).json()) as any[];
    expect(drafts.map((i) => String(i.id))).toEqual([third.id, first.id]);
    const issued = (await (await owner.get(`${base}?status=issued`)).json()) as any[];
    expect(issued.map((i) => String(i.id))).toEqual([second.id]);
    const ofC1 = (await (await owner.get(`${base}?customerId=${c1.id}`)).json()) as any[];
    expect(ofC1.map((i) => String(i.id))).toEqual([third.id, first.id]);
  });

  test('[cp2.34][R1.1][C2] customers and invoices of another organization are 404 for non-members', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const c = await createCustomer(owner, org.id);
    const inv = await createDraft(owner, org.id, c.id);
    const stranger = await ownerWithOrg(playwright);
    for (const path of [`/api/orgs/${org.id}/customers`, `/api/orgs/${org.id}/customers/${c.id}`, `/api/orgs/${org.id}/invoices`, `/api/orgs/${org.id}/invoices/${inv.id}`]) {
      await expectStatus(await stranger.owner.get(path), 404, `stranger GET ${path}`);
    }
    // The stranger's own organization does not expose them either.
    await expectStatus(await stranger.owner.get(`/api/orgs/${stranger.org.id}/invoices/${inv.id}`), 404, 'invoice through own org');
    await expectStatus(await stranger.owner.get(`/api/orgs/${stranger.org.id}/customers/${c.id}`), 404, 'customer through own org');
    expect(uniq('x')).toBeTruthy();
  });
});

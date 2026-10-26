/** Hazard tests, checkpoint 5 (dashboard, export). See hazards/PROOF.md. */
import { expect, test } from '@playwright/test';
import { expectStatus, issuedInvoice, line, ownerWithOrg, readCsv } from '../../support';

test.describe('Hazards CP5', () => {
  test('[hz5.01][R5.6][H:authz:3] the export contains only the caller\'s organization; another organization\'s export -> 404', async ({ playwright }) => {
    const a = await ownerWithOrg(playwright);
    const b = await ownerWithOrg(playwright);
    const mine = await issuedInvoice(a.owner, a.org.id, [line(1111)]);
    const theirs = await issuedInvoice(b.owner, b.org.id, [line(2222)]);
    const text = await (await a.owner.get(`/api/orgs/${a.org.id}/exports/invoices.csv`)).text();
    const rows = readCsv(text).slice(1);
    expect(rows.map((r) => r[1])).toEqual([mine.customer.name]);
    expect(text).not.toContain(theirs.customer.name);
    expect(text).not.toContain('22.22');
    await expectStatus(await a.owner.get(`/api/orgs/${b.org.id}/exports/invoices.csv`), 404, "B's export as A");
  });

  test('[hz5.02][R5.7][H:validation:2] customer names that look like spreadsheet formulas are exported neutralized', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const payloads = ['=cmd|\' /C calc\'!A0', '+SUM(1,2)', '-2+3', '@IMPORTXML("http://x.test")', '=1+1'];
    for (const name of payloads) {
      const { customer } = await issuedInvoice(owner, org.id, [line(100)]);
      await expectStatus(await owner.patch(`/api/orgs/${org.id}/customers/${customer.id}`, { name }), 200, 'rename');
    }
    const cells = readCsv(await (await owner.get(`/api/orgs/${org.id}/exports/invoices.csv`)).text())
      .slice(1)
      .map((r) => r[1]);
    expect(cells).toHaveLength(payloads.length);
    for (const cell of cells) expect(/^[=+\-@]/.test(cell), `cell ${cell} starts with a formula character`).toBe(false);
    expect(cells).toEqual(payloads.map((p) => `'${p}`));
  });

  test('[hz5.03][R5.2][H:authz:2] the dashboard counts only the caller\'s organization; another organization\'s dashboard -> 404', async ({ playwright }) => {
    const a = await ownerWithOrg(playwright);
    const b = await ownerWithOrg(playwright);
    await issuedInvoice(a.owner, a.org.id, [line(1000)]);
    await issuedInvoice(b.owner, b.org.id, [line(50_000)]);
    const d = await expectStatus(await a.owner.get(`/api/orgs/${a.org.id}/dashboard`), 200, 'dashboard');
    expect(d.receivableCents).toBe(1000);
    await expectStatus(await a.owner.get(`/api/orgs/${b.org.id}/dashboard`), 404, "B's dashboard as A");
  });
});

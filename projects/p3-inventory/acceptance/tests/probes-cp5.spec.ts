import { expect, test } from '@playwright/test';

import {
  addDaysYmd,
  adminApi,
  anonApi,
  clerkApi,
  createOrder,
  createProduct,
  createVariant,
  createWarehouse,
  expectStatus,
  firstVariant,
  issue,
  adjust,
  mainWarehouse,
  postTransfer,
  receive,
  shipOrder,
  todayYmd,
  uniq,
  type Api,
  type Json,
} from './support';

async function valuation(api: Api, warehouseId?: string): Promise<any> {
  return expectStatus(await api.get(`/api/reports/valuation${warehouseId ? `?warehouseId=${warehouseId}` : ''}`), 200, 'GET valuation');
}

async function periodReport(api: Api, from: string, to: string, warehouseId?: string): Promise<any> {
  const w = warehouseId ? `&warehouseId=${warehouseId}` : '';
  return expectStatus(await api.get(`/api/reports/movements?from=${from}&to=${to}${w}`), 200, `GET movements ${from}..${to}`);
}

const rowFor = (report: any, variantId: unknown) => (report.rows as Json[]).find((r) => r.variantId === variantId);

/** Parses RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

test.describe('Checkpoint 5 - API probes', () => {
  test('[cp5.20][R5.2,R5.3,R5.4][C2] report endpoints: 401 without a session, 403 for clerks', async ({ playwright }) => {
    const anon = await anonApi(playwright);
    const c = await clerkApi(playwright);
    const t = todayYmd();
    for (const path of ['/api/reports/valuation', `/api/reports/movements?from=${t}&to=${t}`, '/api/reports/valuation.csv', `/api/reports/movements.csv?from=${t}&to=${t}`]) {
      await expectStatus(await anon.get(path), 401, `anon ${path}`);
      await expectStatus(await c.api.get(path), 403, `clerk ${path}`);
    }
    await Promise.all([anon.dispose(), c.api.dispose()]);
  });

  test('[cp5.21][R5.1,R5.2][C2] moving average cost follows the worked example (500/4 -> 375/3 -> 375/6 -> 62/1)', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const v = firstVariant(p).id;
    await receive(admin, p.id, 3, 100);
    await receive(admin, p.id, 1, 200);
    expect(rowFor(await valuation(admin), v)).toMatchObject({ sku: p.sku, productName: p.name, variantName: 'Default', onHand: 4, averageCostCents: 125, valueCents: 500 });
    await issue(admin, p.id, 1);
    expect(rowFor(await valuation(admin), v)).toMatchObject({ onHand: 3, averageCostCents: 125, valueCents: 375 });
    await receive(admin, p.id, 3, 0);
    expect(rowFor(await valuation(admin), v)).toMatchObject({ onHand: 6, averageCostCents: 63, valueCents: 375 });
    await issue(admin, p.id, 5);
    expect(rowFor(await valuation(admin), v)).toMatchObject({ onHand: 1, averageCostCents: 62, valueCents: 62 });
    await admin.dispose();
  });

  test('[cp5.22][R5.1][C2] adjustments and shipments use the average; transfers change nothing; an empty variant restarts at 0 and is not listed', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    const p = await createProduct(admin);
    const v = firstVariant(p).id;
    await receive(admin, p.id, 4, 250); // V 1000 Q 4
    await adjust(admin, p.id, 2); // +round(1000*2/4)=500 -> V 1500 Q 6
    expect(rowFor(await valuation(admin), v)).toMatchObject({ onHand: 6, averageCostCents: 250, valueCents: 1500 });
    await expectStatus(await postTransfer(admin, { variantId: v, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 3 }), 201, 'transfer');
    expect(rowFor(await valuation(admin), v), 'transfers keep V and Q').toMatchObject({ onHand: 6, valueCents: 1500 });
    const o = await createOrder(admin, [{ productId: p.id, quantity: 1 }]);
    await shipOrder(admin, o.id); // -round(1500/6)=250 -> V 1250 Q 5
    await adjust(admin, p.id, -2); // -round(1250*2/5)=500 -> V 750 Q 3
    expect(rowFor(await valuation(admin), v)).toMatchObject({ onHand: 3, averageCostCents: 250, valueCents: 750 });
    await expectStatus(await postTransfer(admin, { variantId: v, fromWarehouseId: east.id, toWarehouseId: main.id, quantity: 3 }), 201, 'transfer back');
    await issue(admin, p.id, 3); // empties: V 0
    expect(rowFor(await valuation(admin), v), 'onHand 0 is not listed').toBeUndefined();
    await adjust(admin, p.id, 5); // Q 0 -> enters at 0
    expect(rowFor(await valuation(admin), v)).toMatchObject({ onHand: 5, averageCostCents: 0, valueCents: 0 });
    await receive(admin, p.id, 5, 100); // V 500 Q 10
    expect(rowFor(await valuation(admin), v)).toMatchObject({ onHand: 10, averageCostCents: 50, valueCents: 500 });
    await admin.dispose();
  });

  test('[cp5.23][R5.2][C2] valuation by warehouse: units in that warehouse, value = round(V x units / Q), total = sum of rows, ordered by SKU', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    const p = await createProduct(admin);
    const v1 = firstVariant(p).id;
    const v2 = await createVariant(admin, p.id);
    await receive(admin, p.id, 3, 100); // V 300 Q 3
    await expectStatus(await postTransfer(admin, { variantId: v1, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 1 }), 201, 'transfer 1');
    await receive(admin, p.id, 2, 333, { variantId: v2.id, warehouseId: east.id });
    const q = await createProduct(admin);
    await receive(admin, q.id, 1, 50); // only in MAIN
    const report = await valuation(admin, String(east.id));
    expect(report.rows.map((r: Json) => r.variantId), 'rows with units in east only, ordered by SKU').toEqual(
      [
        { id: v1, sku: p.sku },
        { id: v2.id, sku: v2.sku },
      ]
        .sort((a, b) => (a.sku < b.sku ? -1 : 1))
        .map((x) => x.id),
    );
    expect(rowFor(report, v1)).toMatchObject({ onHand: 1, averageCostCents: 100, valueCents: 100 });
    expect(rowFor(report, v2.id)).toMatchObject({ onHand: 2, averageCostCents: 333, valueCents: 666 });
    expect(report.totalValueCents).toBe(766);
    const inMain = await valuation(admin, String(main.id));
    expect(rowFor(inMain, v1)).toMatchObject({ onHand: 2, valueCents: 200 });
    expect(rowFor(inMain, firstVariant(q).id)).toMatchObject({ onHand: 1, valueCents: 50 });
    const all = await valuation(admin);
    expect(all.totalValueCents, 'total = sum of rows').toBe((all.rows as Json[]).reduce((n, r) => n + Number(r.valueCents), 0));
    const skus = (all.rows as Json[]).map((r) => String(r.sku));
    expect(skus).toEqual([...skus].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    await expectStatus(await admin.get('/api/reports/valuation?warehouseId=nope-does-not-exist'), 422, 'unknown warehouse');
    // Uneven split: V 1000 over 3 units, 1 unit elsewhere -> round(333.33) = 333.
    const r = await createProduct(admin);
    await receive(admin, r.id, 2, 333);
    await receive(admin, r.id, 1, 334);
    await expectStatus(await postTransfer(admin, { variantId: firstVariant(r).id, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 1 }), 201, 'transfer');
    expect(rowFor(await valuation(admin, String(east.id)), firstVariant(r).id)).toMatchObject({ onHand: 1, averageCostCents: 333, valueCents: 333 });
    expect(rowFor(await valuation(admin, String(main.id)), firstVariant(r).id)).toMatchObject({ onHand: 2, valueCents: 667 });
    await admin.dispose();
  });

  test('[cp5.24][R5.3][C2] movements by period: received, shipped, adjusted, transferred and closing per variant (transfers net 0 without a warehouse)', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    const p = await createProduct(admin);
    const v = firstVariant(p).id;
    await receive(admin, p.id, 10, 100);
    await issue(admin, p.id, 2);
    const o = await createOrder(admin, [{ productId: p.id, quantity: 1 }]);
    await shipOrder(admin, o.id);
    await adjust(admin, p.id, 3);
    await adjust(admin, p.id, -1);
    await expectStatus(await postTransfer(admin, { variantId: v, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 4 }), 201, 'transfer');
    const t = todayYmd();
    const report = await periodReport(admin, t, t);
    expect(report).toMatchObject({ from: t, to: t });
    expect(rowFor(report, v)).toMatchObject({ sku: p.sku, productName: p.name, variantName: 'Default', opening: 0, received: 10, shipped: 3, adjusted: 2, transferred: 0, closing: 9 });
    expect(rowFor(await periodReport(admin, t, t, String(main.id)), v)).toMatchObject({ opening: 0, received: 10, shipped: 3, adjusted: 2, transferred: -4, closing: 5 });
    expect(rowFor(await periodReport(admin, t, t, String(east.id)), v)).toMatchObject({ opening: 0, received: 0, shipped: 0, adjusted: 0, transferred: 4, closing: 4 });
    await admin.dispose();
  });

  test('[cp5.25][R5.3][C2] period boundaries are inclusive UTC days; invalid parameters -> 422', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin);
    const v = firstVariant(p).id;
    await receive(admin, p.id, 6, 100);
    const t = todayYmd();
    const later = await periodReport(admin, addDaysYmd(t, 1), addDaysYmd(t, 3));
    expect(rowFor(later, v), 'after today: everything is opening').toMatchObject({ opening: 6, received: 0, shipped: 0, adjusted: 0, transferred: 0, closing: 6 });
    expect(rowFor(await periodReport(admin, addDaysYmd(t, -3), addDaysYmd(t, -1)), v), 'before today: no row').toBeUndefined();
    expect(rowFor(await periodReport(admin, addDaysYmd(t, -1), t), v), 'to = today includes today').toMatchObject({ received: 6, closing: 6 });
    for (const [label, query] of [
      ['missing from', `to=${t}`],
      ['missing to', `from=${t}`],
      ['bad format', `from=${t.replace(/-/g, '/')}&to=${t}`],
      ['impossible date', `from=2030-02-30&to=2030-03-01`],
      ['from after to', `from=${addDaysYmd(t, 1)}&to=${t}`],
      ['unknown warehouse', `from=${t}&to=${t}&warehouseId=nope-does-not-exist`],
    ]) {
      await expectStatus(await admin.get(`/api/reports/movements?${query}`), 422, label);
      await expectStatus(await admin.get(`/api/reports/movements.csv?${query}`), 422, `csv ${label}`);
    }
    await admin.dispose();
  });

  test('[cp5.26][R5.4][C2] valuation.csv: text/csv attachment, exact header, RFC 4180 quoting, money with two decimals', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const east = await createWarehouse(admin);
    const main = await mainWarehouse(admin);
    const name = `Washer "flat", ${uniq('8 mm')}`;
    const p = await createProduct(admin, { name });
    await receive(admin, p.id, 1000, 12345);
    await expectStatus(await postTransfer(admin, { variantId: firstVariant(p).id, fromWarehouseId: main.id, toWarehouseId: east.id, quantity: 1000 }), 201, 'move all to east');
    const res = await admin.get(`/api/reports/valuation.csv?warehouseId=${east.id}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^text\/csv/);
    expect(res.headers()['content-disposition'] ?? '').toMatch(/attachment/i);
    const rows = parseCsv(await res.text()).filter((r) => r.some((f) => f !== ''));
    expect(rows[0]).toEqual(['SKU', 'Product', 'Variant', 'On hand', 'Average cost', 'Value']);
    expect(rows.find((r) => r[0] === p.sku)).toEqual([p.sku, name, 'Default', '1000', '123.45', '123450.00']);
    const json = await valuation(admin, String(east.id));
    expect(rows.length - 1, 'same rows as the JSON report').toBe(json.rows.length);
    await expectStatus(await admin.get('/api/reports/valuation.csv?warehouseId=nope-does-not-exist'), 422, 'unknown warehouse');
    await admin.dispose();
  });

  test('[cp5.27][R5.4][C2] movements.csv: exact header and the same values as the JSON report', async ({ playwright }) => {
    const admin = await adminApi(playwright);
    const p = await createProduct(admin, { name: uniq('Spring, steel') });
    await receive(admin, p.id, 8, 100);
    await issue(admin, p.id, 3);
    const t = todayYmd();
    const res = await admin.get(`/api/reports/movements.csv?from=${t}&to=${t}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^text\/csv/);
    expect(res.headers()['content-disposition'] ?? '').toMatch(/attachment/i);
    const rows = parseCsv(await res.text()).filter((r) => r.some((f) => f !== ''));
    expect(rows[0]).toEqual(['SKU', 'Product', 'Variant', 'Opening', 'Received', 'Shipped', 'Adjusted', 'Transferred', 'Closing']);
    expect(rows.find((r) => r[0] === p.sku)).toEqual([p.sku, p.name, 'Default', '0', '8', '3', '0', '0', '5']);
    await admin.dispose();
  });
});

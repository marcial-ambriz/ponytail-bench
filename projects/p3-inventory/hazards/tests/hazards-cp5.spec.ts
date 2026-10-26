import { expect, test } from '@playwright/test';

import { adminApi, clerkApi, todayYmd } from '../../acceptance/tests/support';

test('[H19][authz:2][cp5][R5.2,R5.3,R5.4] clerks cannot read any report (JSON or CSV)', async ({ playwright }) => {
  const c = await clerkApi(playwright);
  const t = todayYmd();
  for (const path of ['/api/reports/valuation', '/api/reports/valuation.csv', `/api/reports/movements?from=${t}&to=${t}`, `/api/reports/movements.csv?from=${t}&to=${t}`]) {
    const res = await c.api.get(path);
    expect(res.status(), path).toBe(403);
    expect(await res.text(), `${path} leaks no report data`).not.toMatch(/SKU,|totalValueCents|"rows"/);
  }
  await c.api.dispose();
  const admin = await adminApi(playwright);
  expect((await admin.get('/api/reports/valuation')).status()).toBe(200);
  await admin.dispose();
});

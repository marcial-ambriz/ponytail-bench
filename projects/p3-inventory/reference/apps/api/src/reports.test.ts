import { describe, expect, it } from "vitest";

import { applyToValue, csvField, money, type VariantValue } from "./domain/reports.js";
import { body, createTestContext } from "./test-helpers.js";

describe("moving average cost", () => {
  it("follows the worked example of the spec", () => {
    const s: VariantValue = { q: 0n, v: 0n, byWarehouse: new Map() };
    const m = (type: "receipt" | "issue", quantity: number, cost: number | null = null) =>
      applyToValue(s, {
        variant_id: "v",
        warehouse_id: "w",
        type,
        quantity,
        unit_cost_cents: cost,
      });
    m("receipt", 3, 100);
    m("receipt", 1, 200);
    expect([s.q, s.v]).toEqual([4n, 500n]);
    m("issue", -1);
    expect([s.q, s.v]).toEqual([3n, 375n]);
    m("receipt", 3, 0);
    m("issue", -5);
    expect([s.q, s.v]).toEqual([1n, 62n]);
  });

  it("formats CSV fields and money", () => {
    expect(csvField('Washer "flat", 8 mm')).toBe('"Washer ""flat"", 8 mm"');
    expect(csvField("plain")).toBe("plain");
    expect(money(123450)).toBe("1234.50");
    expect(money(7)).toBe("0.07");
  });
});

describe("report endpoints", () => {
  it("values stock per warehouse and is admin only", async () => {
    const t = await createTestContext();
    const admin = await t.adminCookie();
    const clerk = await t.signUp("Clerk", "c@example.test");
    const p = await body(
      await t.request("/api/products", { cookie: admin, body: { sku: "VAL-1", name: "Valued" } }),
    );
    await t.request(`/api/products/${p.id}/movements`, {
      cookie: admin,
      body: { type: "receipt", quantity: 3, unitCostCents: 100 },
    });
    expect((await t.request("/api/reports/valuation", { cookie: clerk })).status).toBe(403);
    const report = await body(await t.request("/api/reports/valuation", { cookie: admin }));
    expect(report).toMatchObject({
      totalValueCents: 300,
      rows: [{ sku: "VAL-1", onHand: 3, averageCostCents: 100 }],
    });
    const bad = await t.request("/api/reports/movements?from=2030-01-08&to=2030-01-07", {
      cookie: admin,
    });
    expect(bad.status).toBe(422);
  });
});

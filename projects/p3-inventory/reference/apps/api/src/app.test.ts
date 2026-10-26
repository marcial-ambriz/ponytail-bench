import { describe, expect, it } from "vitest";

import { body, createTestContext } from "./test-helpers.js";

async function setup() {
  const t = await createTestContext();
  const admin = await t.adminCookie();
  const clerk = await t.signUp("Clerk", "clerk@example.test");
  const product = await body(
    await t.request("/api/products", { cookie: admin, body: { sku: "ab-1", name: "Widget" } }),
  );
  const move = (payload: object, cookie = admin) =>
    t.request(`/api/products/${product.id}/movements`, { cookie, body: payload });
  return { t, admin, clerk, product, move };
}

describe("auth and catalog", () => {
  it("health is public and the API needs a session", async () => {
    const t = await createTestContext();
    expect((await t.request("/api/health")).status).toBe(200);
    expect((await t.request("/api/products")).status).toBe(401);
  });

  it("new users are clerks and cannot write the catalog", async () => {
    const { t, clerk, product } = await setup();
    expect((await body(await t.request("/api/me", { cookie: clerk }))).role).toBe("clerk");
    expect(product.sku).toBe("AB-1");
    const res = await t.request("/api/products", {
      cookie: clerk,
      body: { sku: "X-11", name: "No" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects duplicate SKUs case-insensitively and SKU changes", async () => {
    const { t, admin, product } = await setup();
    const dup = await t.request("/api/products", {
      cookie: admin,
      body: { sku: "AB-1", name: "Again" },
    });
    expect(dup.status).toBe(409);
    const patch = await t.request(`/api/products/${product.id}`, {
      cookie: admin,
      method: "PATCH",
      body: { sku: "ZZ-9" },
    });
    expect(patch.status).toBe(422);
  });
});

describe("movements", () => {
  it("keeps a signed history with balances and never goes negative", async () => {
    const { move, t, product, admin } = await setup();
    expect((await move({ type: "receipt", quantity: 5, unitCostCents: 250 })).status).toBe(201);
    expect((await move({ type: "issue", quantity: 6 })).status).toBe(409);
    const issue = await body(await move({ type: "issue", quantity: 2 }));
    expect(issue).toMatchObject({ quantity: -2, balanceAfter: 3, unitCostCents: null });
    const history = await body(
      await t.request(`/api/products/${product.id}/movements`, { cookie: admin }),
    );
    expect(history.map((m: { quantity: number }) => m.quantity)).toEqual([-2, 5]);
  });

  it("validates quantities and costs", async () => {
    const { move } = await setup();
    const bad = [
      { type: "receipt", quantity: 1.5, unitCostCents: 1 },
      { type: "receipt", quantity: "3", unitCostCents: 1 },
      { type: "receipt", quantity: 3 },
      { type: "issue", quantity: -1 },
      { type: "adjustment", quantity: 0, reason: "count" },
      { type: "adjustment", quantity: 2 },
      { type: "transfer", quantity: 2 },
    ];
    const statuses = await Promise.all(
      bad.map(async (b) => ({ b, status: (await move(b)).status })),
    );
    expect(statuses).toEqual(bad.map((b) => ({ b, status: 422 })));
  });

  it("adjustments are admin only", async () => {
    const { move, clerk } = await setup();
    expect((await move({ type: "adjustment", quantity: 3, reason: "found" }, clerk)).status).toBe(
      403,
    );
    expect((await move({ type: "adjustment", quantity: 3, reason: "found" })).status).toBe(201);
  });
});

describe("orders", () => {
  it("reserves atomically, ships once and releases on cancel", async () => {
    const { t, admin, move, product } = await setup();
    await move({ type: "receipt", quantity: 3, unitCostCents: 100 });
    const order = (lines: object[]) =>
      t.request("/api/orders", { cookie: admin, body: { customer: "ACME", lines } });

    expect((await order([{ productId: product.id, quantity: 4 }])).status).toBe(409);
    const created = await body(await order([{ productId: product.id, quantity: 2 }]));
    expect(created.status).toBe("reserved");
    expect((await move({ type: "issue", quantity: 2 })).status).toBe(409);

    const ship = () => t.request(`/api/orders/${created.id}/ship`, { cookie: admin, body: {} });
    expect((await ship()).status).toBe(200);
    expect((await ship()).status).toBe(409);
    const after = await body(await t.request(`/api/products/${product.id}`, { cookie: admin }));
    expect(after).toMatchObject({ onHand: 1, reserved: 0, available: 1 });

    const second = await body(await order([{ productId: product.id, quantity: 1 }]));
    const cancel = () => t.request(`/api/orders/${second.id}/cancel`, { cookie: admin, body: {} });
    expect((await cancel()).status).toBe(200);
    expect((await cancel()).status).toBe(200);
    const final = await body(await t.request(`/api/products/${product.id}`, { cookie: admin }));
    expect(final).toMatchObject({ onHand: 1, reserved: 0 });
  });
});

describe("low-stock alerts", () => {
  it("compare available units, so reservations count", async () => {
    const { t, admin, move, product } = await setup();
    await t.request(`/api/products/${product.id}`, {
      cookie: admin,
      method: "PATCH",
      body: { reorderPoint: 4 },
    });
    await move({ type: "receipt", quantity: 5, unitCostCents: 100 });
    const alerts = async () => body(await t.request("/api/alerts/low-stock", { cookie: admin }));
    expect(await alerts()).toEqual([]);
    await t.request("/api/orders", {
      cookie: admin,
      body: { customer: "ACME", lines: [{ productId: product.id, quantity: 1 }] },
    });
    expect(await alerts()).toMatchObject([{ sku: "AB-1", available: 4, reorderPoint: 4 }]);
  });
});

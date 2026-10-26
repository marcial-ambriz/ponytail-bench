import { describe, expect, it } from "vitest";

import { createTestContext, json } from "./test-helpers.js";

async function orgWithInvoice() {
  const t = await createTestContext();
  const cookie = await t.signUp("Owner", "owner@example.test");
  const org = await json(await t.request("/api/orgs", { cookie, body: { name: "Acme" } }));
  const customer = await json(
    await t.request(`/api/orgs/${org.id}/customers`, {
      cookie,
      body: { name: "Client", email: "c@example.test" },
    }),
  );
  const create = (lines: unknown[]) =>
    t.request(`/api/orgs/${org.id}/invoices`, {
      cookie,
      body: { customerId: customer.id, dueDate: "2030-01-31", lines },
    });
  return { t, cookie, org, customer, create };
}

describe("API", () => {
  it("GET /api/health returns ok", async () => {
    const t = await createTestContext();
    expect(await json(await t.request("/api/health"))).toEqual({ ok: true });
  });

  it("rounds tax half up per line and sums line values", async () => {
    const { create } = await orgWithInvoice();
    const line = { description: "Pen", quantity: 1, unitPriceCents: 5, taxRateBps: 1000 };
    const invoice = await json(await create([line, line]));
    expect(invoice.taxCents).toBe(2);
    expect(invoice.totalCents).toBe(12);
  });

  it("rejects fractional cents", async () => {
    const { create } = await orgWithInvoice();
    const res = await create([
      { description: "Pen", quantity: 1, unitPriceCents: 10.005, taxRateBps: 0 },
    ]);
    expect(res.status).toBe(422);
  });

  it("numbers issued invoices consecutively and hides other tenants", async () => {
    const { t, cookie, org, create } = await orgWithInvoice();
    const line = { description: "Work", quantity: 1, unitPriceCents: 100, taxRateBps: 0 };
    const a = await json(await create([line]));
    const b = await json(await create([line]));
    const issue = async (id: string) =>
      json(await t.request(`/api/orgs/${org.id}/invoices/${id}/issue`, { cookie, method: "POST" }));
    expect((await issue(b.id)).number).toBe("INV-0001");
    expect((await issue(a.id)).number).toBe("INV-0002");

    const other = await t.signUp("Other", "other@example.test");
    const res = await t.request(`/api/orgs/${org.id}/invoices/${a.id}`, { cookie: other });
    expect(res.status).toBe(404);
  });

  it("never records more than the balance", async () => {
    const { t, cookie, org, create } = await orgWithInvoice();
    const invoice = await json(
      await create([{ description: "Work", quantity: 1, unitPriceCents: 1000, taxRateBps: 0 }]),
    );
    await t.request(`/api/orgs/${org.id}/invoices/${invoice.id}/issue`, { cookie, method: "POST" });
    const pay = (amountCents: number) =>
      t.request(`/api/orgs/${org.id}/invoices/${invoice.id}/payments`, {
        cookie,
        body: { amountCents, method: "cash" },
      });
    expect((await pay(600)).status).toBe(201);
    expect((await pay(600)).status).toBe(422);
    expect((await pay(400)).status).toBe(201);
  });
});

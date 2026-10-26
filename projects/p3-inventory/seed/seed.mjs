#!/usr/bin/env node
/**
 * P3 (Stockly) seed script. Talks only to the documented API through BASE_URL (spec cp1-cp3), so it works against
 * any implementation.
 *
 *   node seed/seed.mjs --stage cp3 --manifest <path> [--result <path>]
 *
 * --stage cp3   CP3-era business data (users, products, receipts, issues, adjustments, reserved/shipped/cancelled
 *               orders, low-stock products), then a snapshot of what the app returned. The cp4 migration test and the
 *               data-loss hazard compare the CP4 app against this snapshot, so it records the app's OWN answers.
 * --stage screens  (default) fixed demo data for screenshots and the UX agent (project.json visual.seed): the same
 *               CP3-era data with fixed names and users clerk@stockly.test / Clerk-pass-123 and
 *               manager@stockly.test / Manager-pass-123, plus a second warehouse, a variant and a transfer when the
 *               app already supports them (checkpoint 4+). Calls the app does not support yet just fail as steps.
 *
 * Env: BASE_URL (web origin; /api is proxied). Exit 0 when the seed ran (even if some steps failed: each step is
 * recorded), 2 on runner errors.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error('BASE_URL is required');
  process.exit(2);
}
const stage = args.stage ?? 'screens';
const DEMO = stage === 'screens';
const manifestPath = args.manifest;
if (!['cp3', 'screens'].includes(stage)) {
  console.error(`unknown --stage ${stage}`);
  process.exit(2);
}
if (!manifestPath && stage === 'cp3') {
  console.error('--manifest is required for --stage cp3');
  process.exit(2);
}

const ADMIN = { email: 'admin@stockly.test', password: 'Admin1234!' };
const TAG = DEMO ? 'DEMO' : `${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
const steps = [];

class Client {
  constructor(label) {
    this.label = label;
    this.cookie = '';
  }
  async call(method, path, body) {
    const headers = { origin: BASE_URL };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(new URL(path, BASE_URL), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) {
      const jar = new Map(this.cookie.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
      for (const c of set) {
        const pair = c.split(';')[0];
        jar.set(pair.split('=')[0], pair);
      }
      this.cookie = [...jar.values()].join('; ');
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }
}

/** Runs one documented call; records it as a step. Returns the JSON body or null. */
async function step(name, client, method, path, body, expected) {
  try {
    const { status, json } = await client.call(method, path, body);
    const ok = status === expected;
    steps.push({ name, ok, status, error: ok ? null : JSON.stringify(json).slice(0, 300) });
    return ok ? json : null;
  } catch (e) {
    steps.push({ name, ok: false, status: 0, error: String(e).slice(0, 300) });
    return null;
  }
}

async function signIn(label, email, password) {
  const c = new Client(label);
  await step(`sign in ${label}`, c, 'POST', '/api/auth/sign-in/email', { email, password }, 200);
  return c;
}

async function signUp(label, name, email, password) {
  const c = new Client(label);
  await step(`sign up ${label}`, c, 'POST', '/api/auth/sign-up/email', { name, email, password }, 200);
  const me = await step(`me ${label}`, c, 'GET', '/api/me', undefined, 200);
  return { client: c, id: me?.id, name, email, password };
}

async function mainId(client) {
  const { json } = await client.call('GET', '/api/warehouses');
  return Array.isArray(json) ? json.find((w) => w.code === 'MAIN')?.id : undefined;
}

async function main() {
  const admin = await signIn('admin', ADMIN.email, ADMIN.password);
  const lower = TAG.toLowerCase();
  const clerk = DEMO
    ? await signUp('clerk', 'Carla Clerk', 'clerk@stockly.test', 'Clerk-pass-123')
    : await signUp('clerk', `Carla Clerk ${TAG}`, `carla-${lower}@example.test`, 'Clerk-pass-123');
  const manager = DEMO
    ? await signUp('manager', 'Manny Manager', 'manager@stockly.test', 'Manager-pass-123')
    : await signUp('manager', `Manny Manager ${TAG}`, `manny-${lower}@example.test`, 'Manager-pass-123');
  if (manager.id !== undefined) await step('promote manager', admin, 'PATCH', `/api/users/${manager.id}`, { role: 'admin' }, 200);

  const defs = [
    { key: 'bolt', sku: `${DEMO ? 'HW' : `MIG-${TAG}`}-BOLT`, name: 'Hex bolt M8, zinc', description: 'Box of 100, "DIN 933"', reorderPoint: 20 },
    { key: 'washer', sku: `${DEMO ? 'HW' : `MIG-${TAG}`}-WASH`, name: 'Washer "flat" 8 mm', reorderPoint: 0 },
    { key: 'tie', sku: `${DEMO ? 'HW' : `MIG-${TAG}`}-TIE`, name: 'Cable tie 200 mm', reorderPoint: 50 },
    { key: 'label', sku: `${DEMO ? 'HW' : `MIG-${TAG}`}-LBL`, name: 'Bin label', reorderPoint: 5 },
    { key: 'gone', sku: `${DEMO ? 'HW' : `MIG-${TAG}`}-GONE`, name: 'Discontinued gasket', reorderPoint: 0 },
  ];
  const products = {};
  for (const d of defs) {
    const body = { sku: d.sku, name: d.name, reorderPoint: d.reorderPoint };
    if (d.description) body.description = d.description;
    products[d.key] = await step(`create ${d.key}`, admin, 'POST', '/api/products', body, 201);
  }
  const pid = (k) => products[k]?.id ?? `missing-${k}`;
  const move = (name, who, k, body) => step(name, who, 'POST', `/api/products/${pid(k)}/movements`, body, 201);

  await move('bolt receipt 100@12', admin, 'bolt', { type: 'receipt', quantity: 100, unitCostCents: 1200 });
  await move('bolt receipt 50@15', clerk.client, 'bolt', { type: 'receipt', quantity: 50, unitCostCents: 1500 });
  await move('bolt issue 30', clerk.client, 'bolt', { type: 'issue', quantity: 30, reason: 'Workshop, line 2' });
  await move('bolt adjustment -2', admin, 'bolt', { type: 'adjustment', quantity: -2, reason: 'Damaged in storage' });
  await move('washer receipt 500@3', manager.client, 'washer', { type: 'receipt', quantity: 500, unitCostCents: 3 });
  await move('washer adjustment +5', manager.client, 'washer', { type: 'adjustment', quantity: 5, reason: 'Found during count' });
  await move('tie receipt 40@8', clerk.client, 'tie', { type: 'receipt', quantity: 40, unitCostCents: 8 });
  await move('gone receipt 10@100', admin, 'gone', { type: 'receipt', quantity: 10, unitCostCents: 100 });
  await move('gone issue 10', admin, 'gone', { type: 'issue', quantity: 10 });

  const order = (name, who, customer, lines) =>
    step(name, who, 'POST', '/api/orders', { customer, lines: lines.map(([k, quantity]) => ({ productId: pid(k), quantity })) }, 201);
  const open = await order('order open', clerk.client, `Northwind ${TAG}`, [
    ['bolt', 10],
    ['tie', 5],
  ]);
  const shipped = await order('order shipped', clerk.client, `Contoso, Ltd ${TAG}`, [
    ['bolt', 20],
    ['washer', 120],
  ]);
  if (shipped) await step('ship order', manager.client, 'POST', `/api/orders/${shipped.id}/ship`, {}, 200);
  const cancelled = await order('order cancelled', admin, `Fabrikam ${TAG}`, [['tie', 10]]);
  if (cancelled) await step('cancel order', admin, 'POST', `/api/orders/${cancelled.id}/cancel`, {}, 200);
  // A late receipt after the shipment, so history order matters (balances are not monotonic).
  await move('bolt receipt 5@14', clerk.client, 'bolt', { type: 'receipt', quantity: 5, unitCostCents: 1400 });

  if (DEMO) {
    // Checkpoint 4+ data (fails harmlessly on earlier checkpoints).
    const east = await step('demo warehouse', admin, 'POST', '/api/warehouses', { code: 'EAST', name: 'East depot' }, 201);
    const variant = await step('demo variant', admin, 'POST', `/api/products/${pid('bolt')}/variants`, { sku: 'HW-BOLT-SS', name: 'Stainless', reorderPoint: 10 }, 201);
    const first = products.bolt?.variants?.[0]?.id;
    if (east && first) await step('demo transfer', clerk.client, 'POST', '/api/transfers', { variantId: first, fromWarehouseId: (await mainId(admin)), toWarehouseId: east.id, quantity: 25 }, 201);
    if (east && variant) await move('demo variant receipt', admin, 'bolt', { type: 'receipt', quantity: 8, unitCostCents: 2100, variantId: variant.id, warehouseId: east.id });
  }

  // ---- snapshot: the app's own answers after seeding
  const snapshot = { products: [], orders: [], lowStock: [] };
  for (const d of defs) {
    if (!products[d.key]) continue;
    const product = await step(`snapshot product ${d.key}`, admin, 'GET', `/api/products/${pid(d.key)}`, undefined, 200);
    const movements = await step(`snapshot movements ${d.key}`, admin, 'GET', `/api/products/${pid(d.key)}/movements`, undefined, 200);
    snapshot.products.push({ key: d.key, product, movements });
  }
  for (const o of [open, shipped, cancelled]) {
    if (!o) continue;
    snapshot.orders.push(await step(`snapshot order ${o.customer}`, admin, 'GET', `/api/orders/${o.id}`, undefined, 200));
  }
  const alerts = await step('snapshot low-stock', admin, 'GET', '/api/alerts/low-stock', undefined, 200);
  const ids = new Set(Object.values(products).filter(Boolean).map((p) => String(p.id)));
  snapshot.lowStock = Array.isArray(alerts) ? alerts.filter((a) => ids.has(String(a.productId))) : [];

  const users = [
    { key: 'clerk', email: clerk.email, password: clerk.password, name: clerk.name, role: 'clerk' },
    { key: 'manager', email: manager.email, password: manager.password, name: manager.name, role: 'admin' },
  ];
  return { users, snapshot };
}

try {
  const { users, snapshot } = await main();
  const failed = steps.filter((s) => !s.ok);
  const manifest = { stage, tag: TAG, createdAt: new Date().toISOString(), baseUrl: BASE_URL, complete: failed.length === 0, steps, users, ...snapshot };
  if (manifestPath) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  if (args.result) {
    mkdirSync(dirname(args.result), { recursive: true });
    const tests = steps.map((s, i) => ({ id: `seed.${String(i + 1).padStart(2, '0')}`, requirement: null, category: 'seed', status: s.ok ? 'pass' : 'fail', message: s.ok ? '' : `${s.name}: HTTP ${s.status} ${s.error ?? ''}` }));
    writeFileSync(args.result, JSON.stringify({ suite: `seed-${stage}`, passed: steps.length - failed.length, total: steps.length, error: null, tests }, null, 2) + '\n');
  }
  console.log(`seed ${stage}: ${steps.length - failed.length}/${steps.length} steps ok${manifestPath ? ` -> ${manifestPath}` : ''}`);
  for (const f of failed.slice(0, 10)) console.log(`  failed: ${f.name} (HTTP ${f.status}) ${f.error ?? ''}`);
} catch (e) {
  console.error(e);
  process.exit(2);
}

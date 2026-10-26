/**
 * Direct API client for probes, hazards and test setup (Ledgerly, project P1).
 *
 * Every request goes through BASE_URL, i.e. the web dev server, which proxies `/api` to the API (cp1.md "Fixed
 * constraints"). Sessions come from better-auth's default email endpoints under `/api/auth/*` (cp1.md contracts);
 * each Api instance keeps its own cookie jar. Nothing here depends on the reference implementation: only on the
 * routes, bodies and status codes the spec fixes.
 */
import { createHmac } from 'crypto';
import { expect, type APIRequest, type APIRequestContext, type APIResponse, type Browser, type BrowserContext } from '@playwright/test';

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
export const DEFAULT_PASSWORD = 'Passw0rd!long';

export interface PlaywrightLike {
  request: APIRequest;
}

// ---------------------------------------------------------------- identifiers and dates

let seq = 0;
export function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

export function uniqEmail(prefix = 'user'): string {
  return `${uniq(prefix).toLowerCase()}@example.test`;
}

export const DAY = 86_400_000;
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export function todayUtc(): string {
  return ymd(new Date());
}
export function addDays(date: string, days: number): string {
  return ymd(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY));
}

/** "$1,234.56" for an integer number of cents (cp1.md R1.3). */
export function usd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- client

export type Json = Record<string, any>;

export class Api {
  constructor(readonly ctx: APIRequestContext, public user?: User) {}

  send(method: string, path: string, data?: unknown, headers: Record<string, string> = {}): Promise<APIResponse> {
    const raw = typeof data === 'string';
    return this.ctx.fetch(path, {
      method,
      data: data === undefined ? undefined : raw ? Buffer.from(data as string, 'utf8') : JSON.stringify(data),
      headers: data === undefined ? headers : { 'content-type': 'application/json', ...headers },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
  }

  get(path: string) {
    return this.send('GET', path);
  }
  post(path: string, data?: unknown) {
    return this.send('POST', path, data ?? {});
  }
  patch(path: string, data: unknown) {
    return this.send('PATCH', path, data);
  }
  put(path: string, data: unknown) {
    return this.send('PUT', path, data);
  }
  delete(path: string) {
    return this.send('DELETE', path);
  }
  /** POST with a raw text body (CSV imports). */
  postText(path: string, text: string, contentType = 'text/csv') {
    return this.send('POST', path, text, { 'content-type': contentType });
  }

  storageState() {
    return this.ctx.storageState();
  }
  dispose() {
    return this.ctx.dispose();
  }
}

export async function anonApi(playwright: PlaywrightLike): Promise<Api> {
  const ctx = await playwright.request.newContext({
    baseURL: BASE_URL,
    // better-auth rejects cookie-carrying POSTs whose Origin is not trusted; the web origin is.
    extraHTTPHeaders: { origin: BASE_URL },
  });
  return new Api(ctx);
}

export interface Creds {
  name: string;
  email: string;
  password: string;
}
export interface User extends Creds {
  id: string;
}

/** Registers a new account through better-auth's sign-up endpoint (auto sign-in) and returns its client. */
export async function signUp(playwright: PlaywrightLike, overrides: Partial<Creds> = {}): Promise<Api> {
  const creds: Creds = {
    name: overrides.name ?? uniq('User'),
    email: overrides.email ?? uniqEmail('user'),
    password: overrides.password ?? DEFAULT_PASSWORD,
  };
  const api = await anonApi(playwright);
  const res = await api.post('/api/auth/sign-up/email', creds);
  expect(res.status(), `sign-up ${creds.email}: ${await res.text()}`).toBe(200);
  const me = await expectStatus(await api.get('/api/me'), 200, 'GET /api/me after sign-up');
  expect(me.email).toBe(creds.email);
  api.user = { ...creds, id: String(me.id) };
  return api;
}

export async function signIn(playwright: PlaywrightLike, email: string, password = DEFAULT_PASSWORD): Promise<Api> {
  const api = await anonApi(playwright);
  const res = await api.post('/api/auth/sign-in/email', { email, password });
  expect(res.status(), `sign-in ${email}: ${await res.text()}`).toBe(200);
  const me = await expectStatus(await api.get('/api/me'), 200, 'GET /api/me after sign-in');
  api.user = { name: String(me.name), email, password, id: String(me.id) };
  return api;
}

export async function browserContextFor(browser: Browser, api: Api): Promise<BrowserContext> {
  return browser.newContext({ baseURL: BASE_URL, timezoneId: 'UTC', locale: 'en-US', storageState: await api.storageState() });
}

// ---------------------------------------------------------------- assertions

/** Asserts the status and, for 4xx, the documented `{ "error": "<readable message>" }` body. Returns the JSON body. */
export async function expectStatus(res: APIResponse, status: number, label: string): Promise<any> {
  const text = await res.text();
  expect(res.status(), `${label} -> ${res.status()} ${text.slice(0, 300)}`).toBe(status);
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    if (status >= 400 || res.headers()['content-type']?.includes('json')) throw new Error(`${label}: body is not JSON: ${text.slice(0, 200)}`);
    return text;
  }
  if (status >= 400) {
    const err = (body as Json | null)?.error;
    expect(typeof err === 'string' && err.trim().length > 0, `${label}: error body must be { error: "<message>" }, got ${text.slice(0, 200)}`).toBe(true);
  }
  return body;
}

/** Any of the given statuses (used where the spec allows e.g. 404 or 405). */
export async function expectOneOf(res: APIResponse, statuses: number[], label: string): Promise<void> {
  expect(statuses, `${label} -> ${res.status()} ${(await res.text()).slice(0, 200)}`).toContain(res.status());
}

export async function errorOf(res: APIResponse): Promise<string> {
  try {
    return String(((await res.json()) as Json).error ?? '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- organizations and members

export type Role = 'owner' | 'accountant' | 'viewer';

export interface Org {
  id: string;
  name: string;
}

export async function createOrg(owner: Api, name = uniq('Org')): Promise<Org> {
  const body = await expectStatus(await owner.post('/api/orgs', { name }), 201, 'POST /api/orgs');
  expect(body.id, 'POST /api/orgs returns { id }').toBeTruthy();
  return { id: String(body.id), name };
}

export async function invite(owner: Api, orgId: string, email: string, role: Role): Promise<Json> {
  return expectStatus(await owner.post(`/api/orgs/${orgId}/invitations`, { email, role }), 201, `invite ${email} as ${role}`);
}

/** Signs up a new user and makes them a member with `role` (invitation + accept, R1.18/R1.21). */
export async function addMember(playwright: PlaywrightLike, owner: Api, orgId: string, role: Role): Promise<Api> {
  const member = await signUp(playwright, { name: uniq(role[0]!.toUpperCase() + role.slice(1)) });
  const inv = await invite(owner, orgId, member.user!.email, role);
  await expectStatus(await member.post(`/api/invitations/${inv.token}/accept`), 200, `accept invitation as ${role}`);
  return member;
}

/** An owner with a fresh organization. */
export async function ownerWithOrg(playwright: PlaywrightLike): Promise<{ owner: Api; org: Org }> {
  const owner = await signUp(playwright, { name: uniq('Owner') });
  const org = await createOrg(owner);
  return { owner, org };
}

/** A fresh organization with one member per role. */
export async function team(playwright: PlaywrightLike) {
  const { owner, org } = await ownerWithOrg(playwright);
  const accountant = await addMember(playwright, owner, org.id, 'accountant');
  const viewer = await addMember(playwright, owner, org.id, 'viewer');
  return { owner, accountant, viewer, org };
}

/** A signed-in user that is not a member of `org` (with their own organization). */
export async function outsider(playwright: PlaywrightLike) {
  return ownerWithOrg(playwright);
}

// ---------------------------------------------------------------- customers and invoices

export async function createCustomer(api: Api, orgId: string, input: { name?: string; email?: string } = {}): Promise<Json> {
  const body = { name: input.name ?? uniq('Customer'), email: input.email ?? uniqEmail('customer') };
  const created = await expectStatus(await api.post(`/api/orgs/${orgId}/customers`, body), 201, 'POST customers');
  return { ...body, ...created, id: String(created.id) };
}

export interface LineBody {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateBps: number;
}

export const line = (unitPriceCents: number, quantity = 1, taxRateBps = 0, description = uniq('Item')): LineBody => ({
  description,
  quantity,
  unitPriceCents,
  taxRateBps,
});

export function invoiceBody(customerId: string, lines: LineBody[], dueDate = addDays(todayUtc(), 30)): Json {
  return { customerId, dueDate, lines };
}

export async function createDraft(api: Api, orgId: string, customerId: string, lines: LineBody[] = [line(10_000)], dueDate?: string): Promise<Json> {
  const body = await expectStatus(await api.post(`/api/orgs/${orgId}/invoices`, invoiceBody(customerId, lines, dueDate)), 201, 'POST invoices');
  return { ...body, id: String(body.id) };
}

export async function issue(api: Api, orgId: string, invoiceId: string): Promise<Json> {
  return expectStatus(await api.post(`/api/orgs/${orgId}/invoices/${invoiceId}/issue`), 200, 'POST issue');
}

export async function getInvoice(api: Api, orgId: string, invoiceId: string): Promise<Json> {
  return expectStatus(await api.get(`/api/orgs/${orgId}/invoices/${invoiceId}`), 200, 'GET invoice');
}

/** Customer + issued invoice with the given lines (default one $100.00 line, no tax). */
export async function issuedInvoice(api: Api, orgId: string, lines: LineBody[] = [line(10_000)], dueDate?: string): Promise<{ customer: Json; invoice: Json }> {
  const customer = await createCustomer(api, orgId);
  const draft = await createDraft(api, orgId, customer.id, lines, dueDate);
  const invoice = await issue(api, orgId, draft.id);
  return { customer, invoice: { ...invoice, id: String(invoice.id) } };
}

export function pay(api: Api, orgId: string, invoiceId: string, amountCents: number, extra: Json = {}) {
  return api.post(`/api/orgs/${orgId}/invoices/${invoiceId}/payments`, { amountCents, method: 'bank_transfer', ...extra });
}

export async function payments(api: Api, orgId: string, invoiceId: string): Promise<Json[]> {
  return expectStatus(await api.get(`/api/orgs/${orgId}/invoices/${invoiceId}/payments`), 200, 'GET payments');
}

// ---------------------------------------------------------------- webhook (R3.7-R3.12)

export async function webhookSecret(owner: Api, orgId: string): Promise<string> {
  const body = await expectStatus(await owner.get(`/api/orgs/${orgId}/settings/webhook`), 200, 'GET settings/webhook');
  expect(typeof body.secret === 'string' && body.secret.length > 0, 'webhook secret').toBe(true);
  return String(body.secret);
}

export const signPayflow = (secret: string, t: number, raw: string) => createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
export const nowSeconds = () => Math.floor(Date.now() / 1000);

export interface PayflowEvent {
  id: string;
  type: string;
  created: number;
  data: { paymentId: string; invoiceId: string; amountCents: number };
}

export function payflowEvent(type: string, invoiceId: string, amountCents: number, overrides: Partial<PayflowEvent> & { paymentId?: string } = {}): PayflowEvent {
  return {
    id: overrides.id ?? uniq('evt'),
    type,
    created: overrides.created ?? nowSeconds(),
    data: { paymentId: overrides.paymentId ?? uniq('pay'), invoiceId, amountCents },
  };
}

export interface DeliveryOptions {
  /** Override the signed timestamp. */
  t?: number;
  /** Override the whole signature header (null = omit it). */
  header?: string | null;
  /** Send this exact raw body instead of JSON.stringify(event). */
  raw?: string;
}

/** Delivers one event to `POST /api/webhooks/payflow/:orgId`, signed like PayFlow does (R3.8). */
export async function deliver(anon: Api, orgId: string, secret: string, event: unknown, opts: DeliveryOptions = {}): Promise<APIResponse> {
  const raw = opts.raw ?? JSON.stringify(event);
  const t = opts.t ?? nowSeconds();
  const header = opts.header === undefined ? `t=${t},v1=${signPayflow(secret, t, raw)}` : opts.header;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (header !== null) headers['PayFlow-Signature'] = header;
  // A Buffer is sent byte for byte (a string with a JSON content type would be re-encoded when it is not valid JSON).
  return anon.ctx.fetch(`/api/webhooks/payflow/${orgId}`, { method: 'POST', data: Buffer.from(raw, 'utf8'), headers, failOnStatusCode: false, maxRedirects: 0 });
}

// ---------------------------------------------------------------- audit (R4.7)

export async function auditEntries(api: Api, orgId: string, query = ''): Promise<Json[]> {
  return expectStatus(await api.get(`/api/orgs/${orgId}/audit${query}`), 200, 'GET audit');
}

// ---------------------------------------------------------------- CSV helpers (tests only)

/** Minimal RFC 4180 reader for checking exports. */
export function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
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
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** A non-existent id shaped like `sample`. */
export function missingId(sample: string): string {
  if (/^\d+$/.test(sample)) return '999999999';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sample)) return '00000000-0000-4000-8000-000000000000';
  return `${sample.slice(0, Math.max(1, sample.length - 6))}zzzzzz`;
}

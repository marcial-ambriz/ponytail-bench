/**
 * Direct API client for probes and for test setup (Stockly, P3).
 *
 * Every request goes through BASE_URL (the web dev server, which proxies `/api` to the API). Sessions come from
 * better-auth's default email endpoints under `/api/auth/*` (spec cp1 "Contracts"); the session cookie is kept by
 * the APIRequestContext and reused for every later call. Nothing here depends on the implementation: only on the
 * documented paths, bodies, status codes and the seeded admin.
 */
import {
  expect,
  type APIRequest,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from '@playwright/test';

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
export const ADMIN = { email: 'admin@stockly.test', password: 'Admin1234!', name: 'Admin' } as const;
export const DEFAULT_PASSWORD = 'Passw0rd!long';

export interface PlaywrightLike {
  request: APIRequest;
}

// ---------------------------------------------------------------- identifiers

let seq = 0;
const RUN_TAG = Math.random().toString(36).slice(2, 6).toUpperCase();

/** Unique, readable token: `<prefix>-<base36 time><seq><rand>`. */
export function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}${seq}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Unique SKU (valid per R1.7: A-Z, 0-9, "-", 3-32 chars). Fixed length, so one SKU is never a substring of
 * another SKU made here (option texts are matched by SKU substring).
 */
export function uniqSku(prefix = 'T'): string {
  seq += 1;
  const n = (Date.now() % 1e9).toString(36).toUpperCase().padStart(6, '0');
  return `${prefix}-${RUN_TAG}${n}${String(seq).padStart(4, '0')}`.slice(0, 32);
}

export function uniqEmail(prefix = 'user'): string {
  return `${uniq(prefix).toLowerCase()}@example.test`;
}

export function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- client

export type Json = Record<string, unknown>;

export class Api {
  constructor(readonly ctx: APIRequestContext) {}

  send(method: string, path: string, data?: unknown, headers?: Record<string, string>): Promise<APIResponse> {
    return this.ctx.fetch(path, {
      method,
      data: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
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

export interface Session {
  api: Api;
  user: Creds & { id: string; role: string };
}

export async function signIn(playwright: PlaywrightLike, email: string, password: string): Promise<Api> {
  const api = await anonApi(playwright);
  const res = await api.post('/api/auth/sign-in/email', { email, password });
  expect(res.status(), `sign-in ${email}: ${await res.text()}`).toBe(200);
  await expectMe(api, email);
  return api;
}

export function adminApi(playwright: PlaywrightLike): Promise<Api> {
  return signIn(playwright, ADMIN.email, ADMIN.password);
}

/** Registers a new user through better-auth's sign-up endpoint (auto sign-in): a clerk (R1.2). */
export async function clerkApi(playwright: PlaywrightLike, overrides: Partial<Creds> = {}): Promise<Session> {
  const creds: Creds = {
    name: overrides.name ?? uniq('Clerk'),
    email: overrides.email ?? uniqEmail('clerk'),
    password: overrides.password ?? DEFAULT_PASSWORD,
  };
  const api = await anonApi(playwright);
  const res = await api.post('/api/auth/sign-up/email', creds);
  expect(res.status(), `sign-up ${creds.email}: ${await res.text()}`).toBe(200);
  const me = await expectMe(api, creds.email);
  return { api, user: { ...creds, id: String(me.id), role: String(me.role) } };
}

/** A second admin: a new user promoted by the seeded admin (R1.6). */
export async function extraAdminApi(playwright: PlaywrightLike): Promise<Session> {
  const s = await clerkApi(playwright, { name: uniq('Boss') });
  const admin = await adminApi(playwright);
  await expectStatus(await admin.patch(`/api/users/${s.user.id}`, { role: 'admin' }), 200, 'promote to admin');
  await admin.dispose();
  return { api: s.api, user: { ...s.user, role: 'admin' } };
}

async function expectMe(api: Api, email: string): Promise<Json> {
  const me = await api.get('/api/me');
  expect(me.status(), `GET /api/me after auth: ${await me.text()}`).toBe(200);
  const body = (await me.json()) as Json;
  expect(body.email).toBe(email);
  return body;
}

export async function browserContextFor(browser: Browser, api: Api): Promise<BrowserContext> {
  return browser.newContext({ baseURL: BASE_URL, timezoneId: 'UTC', locale: 'en-US', storageState: await api.storageState() });
}

// ---------------------------------------------------------------- assertions

/** Asserts the status and, for 4xx, the documented `{ "error": "<readable message>" }` body. Returns the JSON body. */
export async function expectStatus(res: APIResponse, status: number, label: string): Promise<any> {
  const text = await res.text();
  expect(res.status(), `${label} -> ${res.status()} ${text.slice(0, 300)}`).toBe(status);
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label}: body is not JSON: ${text.slice(0, 200)}`);
  }
  if (status >= 400) {
    const err = (body as Json | null)?.error;
    expect(typeof err === 'string' && err.trim().length > 0, `${label}: error body must be { error: "<message>" }, got ${text.slice(0, 200)}`).toBe(true);
  }
  return body;
}

/** Asserts a 4xx status with an error message that contains `fragment` (case-insensitive). */
export async function expectError(res: APIResponse, status: number, fragment: string | null, label: string): Promise<string> {
  const body = await expectStatus(res, status, label);
  const message = String(body.error);
  if (fragment) expect(message.toLowerCase(), `${label}: error should contain "${fragment}"`).toContain(fragment.toLowerCase());
  return message;
}

export const idOf = (x: unknown): string => String((x as Json).id);

/** An id shaped like `sample` (numeric, UUID or opaque string) that does not exist. */
export function missingId(sample: string): string {
  if (/^\d+$/.test(sample)) return '999999999';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sample)) return '00000000-0000-4000-8000-000000000000';
  return `${sample.slice(0, Math.max(1, sample.length - 6))}zzzzzz`;
}

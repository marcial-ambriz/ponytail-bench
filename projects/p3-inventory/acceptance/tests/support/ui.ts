/**
 * UI helpers. Locators use only role + accessible name, labels, routes and quoted texts from the spec.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

import {
  ADMIN,
  BASE_URL,
  DEFAULT_PASSWORD,
  adminApi,
  browserContextFor,
  clerkApi,
  uniq,
  uniqEmail,
  type Api,
  type Creds,
  type PlaywrightLike,
} from './api';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Form control whose accessible label is exactly `label` (a trailing required `*` is tolerated). */
export function field(scope: Page | Locator, label: string): Locator {
  // A select wrapped in its <label> gets the selected option's text appended to its accessible name; accept it.
  const exact = scope.getByLabel(new RegExp(`^\\s*${escapeRe(label)}\\s*\\*?\\s*$`));
  const wrappedSelect = scope.getByRole('combobox', { name: new RegExp(`^\\s*${escapeRe(label)}\\s*\\*?(?![a-z0-9])`, 'i') });
  return exact.or(wrappedSelect).first();
}

export function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

/** A button or a link with this exact name (the spec says "link or button" in a few places). */
export function action(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true }).or(scope.getByRole('link', { name, exact: true })).first();
}

export function navLink(page: Page, name: string): Locator {
  return page.getByRole('link', { name, exact: true });
}

export function dialog(page: Page): Locator {
  return page.getByRole('dialog');
}

export function alerts(scope: Page | Locator): Locator {
  return scope.getByRole('alert');
}

export function rowWith(scope: Page | Locator, text: string): Locator {
  return scope.getByRole('row').filter({ hasText: text });
}

export function cell(row: Locator, text: string): Locator {
  return row.getByRole('cell', { name: text, exact: true });
}

/** Expects each column header (exact name) in the first table of `scope`. */
export async function expectHeaders(scope: Page | Locator, headers: string[], label: string): Promise<Locator> {
  const table = scope.getByRole('table').first();
  await expect(table, `${label}: table`).toBeVisible();
  for (const h of headers) {
    await expect(table.getByRole('columnheader', { name: h, exact: true }), `${label}: column "${h}"`).toBeVisible();
  }
  return table;
}

/** Text of the cell of `row` in the column whose header is `header` (exact), within `table`. */
export async function columnText(table: Locator, row: Locator, header: string): Promise<string> {
  await expect(table.getByRole('columnheader', { name: header, exact: true }), `column "${header}"`).toBeVisible();
  const headers = await table.getByRole('columnheader').evaluateAll((hs) => hs.map((h) => (h.textContent ?? '').trim()));
  const idx = headers.indexOf(header);
  return ((await row.locator('th, td').nth(idx).textContent()) ?? '').trim();
}

/** Polls until the cell of the row containing `rowText` in column `header` has exactly `expected` text. */
export async function expectColumn(table: Locator, rowText: string, header: string, expected: string): Promise<void> {
  const row = table.getByRole('row').filter({ hasText: rowText }).first();
  await expect(row, `row "${rowText}"`).toBeVisible();
  await expect.poll(() => columnText(table, row, header), { message: `"${header}" of row "${rowText}"` }).toBe(expected);
}

/** The table that has a column header named `header` (exact). */
export function tableWithHeader(scope: Page | Locator, header: string): Locator {
  return scope.getByRole('table').filter({ has: scope.getByRole('columnheader', { name: header, exact: true }) }).first();
}

/** Selects the first option of a native <select> whose visible text contains `text`. */
export async function chooseContaining(control: Locator, text: string): Promise<void> {
  await expect(control).toBeVisible();
  await expect
    .poll(async () => control.locator('option').filter({ hasText: text }).count(), {
      message: `an option containing "${text}"`,
    })
    .toBeGreaterThan(0);
  const value = await control.locator('option').filter({ hasText: text }).first().getAttribute('value');
  if (value === null) throw new Error(`option containing "${text}" has no value`);
  await control.selectOption(value);
}

/** Selects an option of a native <select> by its exact visible label. */
export async function chooseLabel(control: Locator, label: string): Promise<void> {
  await expect(control).toBeVisible();
  await control.selectOption({ label });
}

export async function optionLabels(control: Locator): Promise<string[]> {
  await expect(control).toBeVisible();
  await expect.poll(() => control.locator('option').count(), { message: 'select has options' }).toBeGreaterThan(0);
  return control.locator('option').evaluateAll((os) => os.map((o) => (o.textContent ?? '').trim()));
}

/** Turns off native constraint validation on every form on the page. */
export async function disableNativeValidation(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const f of Array.from(document.forms)) f.noValidate = true;
  });
}

/** Records native alert/confirm/prompt use (forbidden for confirmations). */
export function forbidNativeDialogs(page: Page): { readonly used: boolean } {
  const state = { used: false };
  page.on('dialog', async (d) => {
    state.used = true;
    await d.dismiss();
  });
  return state;
}

// ---------------------------------------------------------------- accessibility (C5)

export const NAME_RULES = [
  'label',
  'button-name',
  'link-name',
  'select-name',
  'input-button-name',
  'aria-input-field-name',
  'aria-toggle-field-name',
  'aria-command-name',
  'aria-dialog-name',
];

export async function expectAccessibleNames(page: Page, label: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withRules(NAME_RULES).analyze();
  const summary = violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(summary, `${label}: controls without an accessible name`).toEqual([]);
}

export async function expectDialogFocusAndEscape(page: Page, open: () => Promise<void>, label: string): Promise<void> {
  await open();
  const dlg = dialog(page);
  await expect(dlg, `${label}: dialog visible`).toBeVisible();
  await expect
    .poll(() => dlg.evaluate((el) => el.contains(document.activeElement) && document.activeElement !== document.body), {
      message: `${label}: focus moves inside the dialog`,
    })
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(dlg, `${label}: Escape closes the dialog`).toBeHidden();
}

// ---------------------------------------------------------------- contexts / auth (UI)

export function contextOptions() {
  return { baseURL: BASE_URL, timezoneId: 'UTC', locale: 'en-US' };
}

export async function newPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(contextOptions());
  return { context, page: await context.newPage() };
}

export function signOutButton(page: Page): Locator {
  return button(page, 'Sign out');
}

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await field(page, 'Email').fill(email);
  await field(page, 'Password').fill(password);
  await button(page, 'Sign in').click();
  await expect(signOutButton(page)).toBeVisible();
}

export async function submitRegister(page: Page, u: Creds): Promise<void> {
  await page.goto('/register');
  await field(page, 'Name').fill(u.name);
  await field(page, 'Email').fill(u.email);
  await field(page, 'Password').fill(u.password);
  await button(page, 'Create account').click();
}

export const HOME_URL = /^https?:\/\/[^/]+\/(?:[?#].*)?$/;
export const LOGIN_URL = /^https?:\/\/[^/]+\/login(?:[?#].*)?$/;

export function newCreds(overrides: Partial<Creds> = {}): Creds {
  return {
    name: overrides.name ?? uniq('Clerk'),
    email: overrides.email ?? uniqEmail('clerk'),
    password: overrides.password ?? DEFAULT_PASSWORD,
  };
}

/** A signed-in admin page whose session was created through the API. */
export async function adminPage(browser: Browser, playwright: PlaywrightLike) {
  const api = await adminApi(playwright);
  const context = await browserContextFor(browser, api);
  return { context, page: await context.newPage(), api };
}

/** A signed-in clerk page (fresh clerk) whose session was created through the API. */
export async function clerkPage(browser: Browser, playwright: PlaywrightLike) {
  const s = await clerkApi(playwright);
  const context = await browserContextFor(browser, s.api);
  return { context, page: await context.newPage(), api: s.api, user: s.user };
}

export async function closeAll(...things: Array<{ close(): Promise<void> } | Api | undefined>): Promise<void> {
  for (const t of things) {
    if (!t) continue;
    if ('dispose' in t) await t.dispose();
    else await t.close();
  }
}

export { ADMIN };

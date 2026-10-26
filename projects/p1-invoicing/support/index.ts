/**
 * Shared helpers for the P1 (Ledgerly) hidden suites.
 *
 * Everything relies ONLY on what spec/cp1..cp5.md guarantee: routes, roles + accessible names, labels, quoted texts
 * and the documented API contract. Setup goes through the documented API; UI tests drive the behavior under test
 * through the browser.
 *
 * Title tags (read by support/run-suite.sh):
 *   acceptance  [cpN.MM][R<req>][C2|C5]   (no criterion tag = C1, UI behavior)
 *   hazards     [hzN.MM][R<req>][H:<category>:<severity>]
 *   maintenance [mt.MM][M<req>]
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { BASE_URL, browserContextFor, usd, type Api } from './api';

export * from './api';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Form control whose accessible label is exactly `label` (a trailing required `*` is tolerated). */
export function field(scope: Page | Locator, label: string): Locator {
  const exact = scope.getByLabel(new RegExp(`^\\s*${escapeRe(label)}\\s*\\*?\\s*$`));
  // A select wrapped in its <label> gets the selected option's text appended to its accessible name.
  const wrappedSelect = scope.getByRole('combobox', { name: new RegExp(`^\\s*${escapeRe(label)}\\s*\\*?(?![a-z0-9])`, 'i') });
  return exact.or(wrappedSelect).first();
}

export function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

/** A link or a button with this exact name (where the spec says "link or button"). */
export function action(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('link', { name, exact: true }).or(scope.getByRole('button', { name, exact: true })).first();
}

export function dialog(page: Page): Locator {
  return page.getByRole('dialog');
}

export function alerts(scope: Page | Locator): Locator {
  return scope.getByRole('alert');
}

export function orgNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Organization' });
}

/** Table row containing `text` (scoped to a table when given). */
export function row(scope: Page | Locator, text: string | RegExp): Locator {
  return scope.getByRole('row').filter({ hasText: text });
}

/** The table whose column headers include all of `headers`. */
export function tableWith(page: Page, headers: string[]): Locator {
  let t = page.getByRole('table');
  for (const h of headers) t = t.filter({ has: page.getByRole('columnheader', { name: h, exact: true }) });
  return t.first();
}

export async function expectColumnHeaders(page: Page, headers: string[]): Promise<void> {
  for (const h of headers) await expect(page.getByRole('columnheader', { name: h, exact: true }).first(), `column header "${h}"`).toBeVisible();
}

/** Selects an option of a native <select> (or ARIA combobox) by its exact visible label. */
export async function chooseLabel(control: Locator, label: string): Promise<void> {
  await expect(control).toBeVisible();
  const tag = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') {
    await control.selectOption({ label });
    return;
  }
  await control.click();
  await control.page().getByRole('option', { name: label, exact: true }).click();
}

/** Visible labels of a native <select>'s options. */
export async function optionLabels(control: Locator): Promise<string[]> {
  return control.locator('option').evaluateAll((os) => os.map((o) => (o.textContent ?? '').trim()));
}

/** Text of the selected option of a native <select>. */
export async function selectedLabel(control: Locator): Promise<string> {
  return control.evaluate((el) => (el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.textContent ?? '').trim() : (el.textContent ?? '').trim()));
}

/** Turns off native constraint validation so the test sees what the app does with server-side rejections. */
export async function disableNativeValidation(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const f of Array.from(document.forms)) f.noValidate = true;
  });
}

/** Records whether the page opened a native alert/confirm/prompt (forbidden by cp1.md "Usability"). */
export function forbidNativeDialogs(page: Page): { readonly used: boolean } {
  const state = { used: false };
  page.on('dialog', async (d) => {
    state.used = true;
    await d.dismiss();
  });
  return state;
}

/** Opens a dialog with `opener`, asserts it has no "Cancel" button, clicks `confirm` inside it. */
export async function confirmIn(page: Page, opener: Locator, confirm: string): Promise<void> {
  await opener.click();
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await expect(button(dlg, 'Cancel'), 'dialog close buttons are labeled "Close" (cp1.md)').toHaveCount(0);
  await button(dlg, confirm).click();
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

/** Dialog contract (cp1.md): focus moves inside on open and Escape closes it. */
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

// ---------------------------------------------------------------- pages and sessions

export function contextOptions() {
  return { baseURL: BASE_URL, timezoneId: 'UTC', locale: 'en-US' };
}

export async function newPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(contextOptions());
  return { context, page: await context.newPage() };
}

/** A browser page signed in as `api`'s user (session cookie copied from the API client). */
export async function pageFor(browser: Browser, api: Api): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browserContextFor(browser, api);
  return { context, page: await context.newPage() };
}

export const HOME_URL = /^https?:\/\/[^/]+\/(?:[?#].*)?$/;
export const LOGIN_URL = /^https?:\/\/[^/]+\/login(?:[?#].*)?$/;

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

export async function closeAll(...things: Array<{ close(): Promise<void> } | Api | undefined>): Promise<void> {
  for (const t of things) {
    if (!t) continue;
    if ('dispose' in t) await t.dispose();
    else await t.close();
  }
}

/** Waits for the given money text, e.g. moneyText(page, 'Total', 1234) matches "Total: $12.34". */
export function moneyText(page: Page | Locator, label: string, cents: number): Locator {
  const amount = usd(cents);
  return page.getByText(new RegExp(`${escapeRe(label)}:\\s*${escapeRe(amount)}(?![0-9])`)).first();
}

/** Uploads `content` as a file into the file input labeled `label`. */
export async function uploadText(page: Page, label: string, name: string, content: string): Promise<void> {
  await field(page, label).setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content, 'utf8') });
}

/** UI acceptance, checkpoint 1 (C1 + C5): accounts, organizations, members, invitations (spec/cp1.md). */
import { expect, test } from '@playwright/test';
import {
  DEFAULT_PASSWORD,
  HOME_URL,
  LOGIN_URL,
  addMember,
  alerts,
  button,
  chooseLabel,
  closeAll,
  confirmIn,
  createOrg,
  dialog,
  disableNativeValidation,
  expectAccessibleNames,
  expectColumnHeaders,
  expectDialogFocusAndEscape,
  field,
  forbidNativeDialogs,
  invite,
  login,
  newPage,
  optionLabels,
  orgNav,
  ownerWithOrg,
  pageFor,
  row,
  selectedLabel,
  signOutButton,
  signUp,
  team,
  uniq,
  uniqEmail,
} from '../../support';

const SHORT_PASSWORD_MSG = 'Password must be at least 8 characters';

async function register(page: import('@playwright/test').Page, name: string, email: string, password: string) {
  await page.goto('/register');
  await field(page, 'Name').fill(name);
  await field(page, 'Email').fill(email);
  await field(page, 'Password').fill(password);
  await button(page, 'Create account').click();
}

test.describe('Checkpoint 1 - accounts', () => {
  test('[cp1.01][R1.4] without a session, / and organization pages redirect to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(LOGIN_URL);
    await page.goto('/orgs/some-org/members');
    await expect(page).toHaveURL(LOGIN_URL);
  });

  test('[cp1.02][R1.5] "Create account" signs the user in, redirects to / and the header shows "Ledgerly", their name and "Sign out"', async ({ browser }) => {
    const { context, page } = await newPage(browser);
    const name = uniq('Reg');
    await register(page, name, uniqEmail('reg'), DEFAULT_PASSWORD);
    await expect(page).toHaveURL(HOME_URL);
    const header = page.getByRole('banner');
    await expect(header.getByText('Ledgerly', { exact: true }).first()).toBeVisible();
    await expect(header.getByText(name)).toBeVisible();
    await expect(signOutButton(page)).toBeVisible();
    await context.close();
  });

  test('[cp1.03][R1.5] a short password shows "Password must be at least 8 characters" and creates no account', async ({ browser, playwright }) => {
    const { context, page } = await newPage(browser);
    const email = uniqEmail('short');
    await page.goto('/register');
    await disableNativeValidation(page);
    await field(page, 'Name').fill('Shorty');
    await field(page, 'Email').fill(email);
    await field(page, 'Password').fill('abc12');
    await button(page, 'Create account').click();
    await expect(page.getByText(SHORT_PASSWORD_MSG)).toBeVisible();
    await expect(field(page, 'Email'), 'input kept after the error').toHaveValue(email);
    const probe = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? 'http://localhost:5173', extraHTTPHeaders: { origin: process.env.BASE_URL ?? 'http://localhost:5173' } });
    const res = await probe.post('/api/auth/sign-in/email', { data: { email, password: 'abc12' }, failOnStatusCode: false });
    expect(res.status()).not.toBe(200);
    await probe.dispose();
    await context.close();
  });

  test('[cp1.04][R1.5] registering an email that already exists shows an error containing "already"', async ({ browser, playwright }) => {
    const existing = await signUp(playwright);
    const { context, page } = await newPage(browser);
    await register(page, 'Copycat', existing.user!.email, DEFAULT_PASSWORD);
    await expect(page.getByText(/already/i)).toBeVisible();
    await expect(page).not.toHaveURL(HOME_URL);
    await context.close();
  });

  test('[cp1.05][R1.6] signing in with wrong credentials shows an error containing "Invalid"', async ({ browser, playwright }) => {
    const u = await signUp(playwright);
    const { context, page } = await newPage(browser);
    await page.goto('/login');
    await field(page, 'Email').fill(u.user!.email);
    await field(page, 'Password').fill('wrong-password-123');
    await button(page, 'Sign in').click();
    await expect(page.getByText(/Invalid/)).toBeVisible();
    await expect(signOutButton(page)).toHaveCount(0);
    await context.close();
  });

  test('[cp1.06][R1.6] an existing user signs in with "Sign in" and sees their name', async ({ browser, playwright }) => {
    const u = await signUp(playwright);
    const { context, page } = await newPage(browser);
    await login(page, u.user!.email, DEFAULT_PASSWORD);
    await expect(page).toHaveURL(HOME_URL);
    await expect(page.getByRole('banner').getByText(u.user!.name)).toBeVisible();
    await context.close();
  });

  test('[cp1.07][R1.7] "Sign out" returns to /login and the session is gone', async ({ browser, playwright }) => {
    const u = await signUp(playwright);
    const { context, page } = await newPage(browser);
    await login(page, u.user!.email, DEFAULT_PASSWORD);
    await signOutButton(page).click();
    await expect(page).toHaveURL(LOGIN_URL);
    await page.goto('/');
    await expect(page).toHaveURL(LOGIN_URL);
    const me = await page.request.get('/api/me', { failOnStatusCode: false });
    expect(me.status()).toBe(401);
    await context.close();
  });

  test('[cp1.08][R1.4] a signed-in user visiting /login or /register is sent to /', async ({ browser, playwright }) => {
    const u = await signUp(playwright);
    const { context, page } = await pageFor(browser, u);
    await page.goto('/login');
    await expect(page).toHaveURL(HOME_URL);
    await page.goto('/register');
    await expect(page).toHaveURL(HOME_URL);
    await context.close();
  });
});

test.describe('Checkpoint 1 - organizations', () => {
  test('[cp1.09][R1.11] / shows the empty state, then "Create organization" creates one, opens it and lists it under "Your organizations"', async ({ browser, playwright }) => {
    const u = await signUp(playwright);
    const { context, page } = await pageFor(browser, u);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
    await expect(page.getByText('You are not a member of any organization yet')).toBeVisible();
    const name = uniq('Studio');
    await field(page, 'Organization name').fill(name);
    await button(page, 'Create organization').click();
    await expect(page).toHaveURL(/\/orgs\/[^/]+\/?$/);
    await expect(page.getByRole('heading', { name })).toBeVisible();
    const orgId = new URL(page.url()).pathname.split('/')[2];
    const orgs = (await (await u.get('/api/orgs')).json()) as any[];
    expect(orgs.map((o) => String(o.id))).toContain(orgId);
    await page.goto('/');
    const link = page.getByRole('link', { name, exact: true });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${orgId}/?$`));
    await context.close();
  });

  test('[cp1.10][R1.12] organization pages have an "Organization" navigation with "Members" and an "All organizations" link back to /', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}`);
    await expect(page.getByRole('heading', { name: org.name })).toBeVisible();
    await orgNav(page).getByRole('link', { name: 'Members', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/members/?$`));
    await expect(page.getByRole('heading', { name: org.name })).toBeVisible();
    await page.getByRole('link', { name: 'All organizations', exact: true }).click();
    await expect(page).toHaveURL(HOME_URL);
    await context.close();
  });

  test('[cp1.11][R1.12] a non-member visiting an organization sees "Organization not found" and none of its data', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const stranger = await signUp(playwright);
    const { context, page } = await pageFor(browser, stranger);
    for (const path of [`/orgs/${org.id}`, `/orgs/${org.id}/members`]) {
      await page.goto(path);
      await expect(page.getByText('Organization not found')).toBeVisible();
      await expect(page.getByText(org.name)).toHaveCount(0);
      await expect(page.getByText(owner.user!.email)).toHaveCount(0);
    }
    await context.close();
  });
});

test.describe('Checkpoint 1 - members and invitations', () => {
  test('[cp1.12][R1.17] members table ("Name", "Email", "Role"); an owner changes a role with the "Role" select, sees "Role updated", and it persists', async ({ browser, playwright }) => {
    const t = await team(playwright);
    const { context, page } = await pageFor(browser, t.owner);
    await page.goto(`/orgs/${t.org.id}/members`);
    await expectColumnHeaders(page, ['Name', 'Email', 'Role']);
    for (const who of [t.owner, t.accountant, t.viewer]) await expect(row(page, who.user!.email)).toBeVisible();
    const select = field(row(page, t.viewer.user!.email), 'Role');
    expect(await optionLabels(select)).toEqual(['Owner', 'Accountant', 'Viewer']);
    expect(await selectedLabel(select)).toBe('Viewer');
    await chooseLabel(select, 'Accountant');
    await expect(page.getByText('Role updated')).toBeVisible();
    const members = (await (await t.owner.get(`/api/orgs/${t.org.id}/members`)).json()) as any[];
    expect(members.find((m) => m.email === t.viewer.user!.email).role).toBe('accountant');
    await page.reload();
    expect(await selectedLabel(field(row(page, t.viewer.user!.email), 'Role'))).toBe('Accountant');
    await context.close();
  });

  test('[cp1.13][R1.17] demoting the last owner shows the server error and the select returns to "Owner"', async ({ browser, playwright }) => {
    const t = await team(playwright);
    const { context, page } = await pageFor(browser, t.owner);
    await page.goto(`/orgs/${t.org.id}/members`);
    const select = field(row(page, t.owner.user!.email), 'Role');
    await chooseLabel(select, 'Viewer');
    await expect(page.getByText(/at least one owner/i)).toBeVisible();
    await expect.poll(() => selectedLabel(select)).toBe('Owner');
    const members = (await (await t.owner.get(`/api/orgs/${t.org.id}/members`)).json()) as any[];
    expect(members.find((m) => m.email === t.owner.user!.email).role).toBe('owner');
    await context.close();
  });

  test('[cp1.14][R1.17] "Remove" opens an in-page dialog; "Confirm remove" removes the member', async ({ browser, playwright }) => {
    const t = await team(playwright);
    const { context, page } = await pageFor(browser, t.owner);
    const native = forbidNativeDialogs(page);
    await page.goto(`/orgs/${t.org.id}/members`);
    await confirmIn(page, button(row(page, t.accountant.user!.email), 'Remove'), 'Confirm remove');
    await expect(row(page, t.accountant.user!.email)).toHaveCount(0);
    expect(native.used, 'no window.confirm').toBe(false);
    await expect.poll(async () => (await t.accountant.get(`/api/orgs/${t.org.id}`)).status()).toBe(404);
    await context.close();
  });

  test('[cp1.15][R1.17] accountants and viewers see the members table read-only: no "Role" selects, no "Remove", no invitation form', async ({ browser, playwright }) => {
    const t = await team(playwright);
    for (const who of [t.accountant, t.viewer]) {
      const { context, page } = await pageFor(browser, who);
      await page.goto(`/orgs/${t.org.id}/members`);
      await expect(row(page, t.owner.user!.email)).toBeVisible();
      await expect(page.getByRole('combobox')).toHaveCount(0);
      await expect(button(page, 'Remove')).toHaveCount(0);
      await expect(button(page, 'Send invitation')).toHaveCount(0);
      await expect(page.getByText('Invite member')).toHaveCount(0);
      await context.close();
    }
  });

  test('[cp1.16][R1.22] "Invite member" with "Email" and "Role" -> "Invitation created" and the pending table shows Email, Role and the full invitation link', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const { context, page } = await pageFor(browser, owner);
    await page.goto(`/orgs/${org.id}/members`);
    const email = uniqEmail('invitee');
    const form = page.getByRole('form', { name: 'Invite member' }).or(page.locator('form').filter({ has: button(page, 'Send invitation') })).first();
    await field(form, 'Email').fill(email);
    const role = field(form, 'Role');
    expect(await optionLabels(role)).toEqual(['Owner', 'Accountant', 'Viewer']);
    await chooseLabel(role, 'Viewer');
    await button(form, 'Send invitation').click();
    await expect(page.getByText('Invitation created')).toBeVisible();
    const pending = (await (await owner.get(`/api/orgs/${org.id}/invitations`)).json()) as any[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ email, role: 'viewer' });
    await expectColumnHeaders(page, ['Email', 'Role', 'Link']);
    const r = row(page, email);
    await expect(r).toBeVisible();
    const origin = new URL(page.url()).origin;
    await expect(r).toContainText(`${origin}/invitations/${pending[0].token}`);
    await context.close();
  });

  test('[cp1.17][R1.23] the invited user opens the link, sees "You have been invited to join <org> as <role>", accepts and lands in the organization', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const invitee = await signUp(playwright);
    const inv = await invite(owner, org.id, invitee.user!.email, 'accountant');
    const { context, page } = await pageFor(browser, invitee);
    await page.goto(`/invitations/${inv.token}`);
    await expect(page.getByText(`You have been invited to join ${org.name} as accountant`)).toBeVisible();
    await button(page, 'Accept invitation').click();
    await expect(page).toHaveURL(new RegExp(`/orgs/${org.id}/?$`));
    await expect(page.getByRole('heading', { name: org.name })).toBeVisible();
    const me = (await (await invitee.get(`/api/orgs/${org.id}`)).json()) as any;
    expect(me.role).toBe('accountant');
    await context.close();
  });

  test('[cp1.18][R1.23] accepting an invitation addressed to someone else shows the server error and does not join', async ({ browser, playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const inv = await invite(owner, org.id, uniqEmail('someone'), 'viewer');
    const intruder = await signUp(playwright);
    const { context, page } = await pageFor(browser, intruder);
    await page.goto(`/invitations/${inv.token}`);
    await button(page, 'Accept invitation').click();
    await expect(alerts(page).first()).toBeVisible();
    expect((await intruder.get(`/api/orgs/${org.id}`)).status()).toBe(404);
    await context.close();
  });

  test('[cp1.40][R1.5][C5] login and register: every control has an accessible name and auth errors are in role="alert"', async ({ browser, playwright }) => {
    const existing = await signUp(playwright);
    const { context, page } = await newPage(browser);
    await page.goto('/login');
    await expectAccessibleNames(page, '/login');
    await field(page, 'Email').fill(existing.user!.email);
    await field(page, 'Password').fill('wrong-password-123');
    await button(page, 'Sign in').click();
    await expect(alerts(page).filter({ hasText: /Invalid/ })).toBeVisible();
    await page.goto('/register');
    await expectAccessibleNames(page, '/register');
    await disableNativeValidation(page);
    await field(page, 'Name').fill('A');
    await field(page, 'Email').fill(uniqEmail());
    await field(page, 'Password').fill('short');
    await button(page, 'Create account').click();
    await expect(alerts(page).filter({ hasText: SHORT_PASSWORD_MSG })).toBeVisible();
    await context.close();
  });

  test('[cp1.41][R1.17][C5] members page: accessible names, errors in role="alert", "Remove" dialog takes focus and closes with Escape', async ({ browser, playwright }) => {
    const t = await team(playwright);
    const other = await createOrg(t.owner);
    expect(other.id).toBeTruthy();
    const { context, page } = await pageFor(browser, t.owner);
    await page.goto(`/orgs/${t.org.id}/members`);
    await expect(row(page, t.viewer.user!.email)).toBeVisible();
    await expectAccessibleNames(page, 'members page');
    await chooseLabel(field(row(page, t.owner.user!.email), 'Role'), 'Viewer');
    await expect(alerts(page).filter({ hasText: /at least one owner/i })).toBeVisible();
    await expectDialogFocusAndEscape(page, () => button(row(page, t.viewer.user!.email), 'Remove').click(), 'Remove dialog');
    await expect(row(page, t.viewer.user!.email), 'Escape does not remove').toBeVisible();
    await button(row(page, t.viewer.user!.email), 'Remove').click();
    await expect(dialog(page)).toBeVisible();
    await expectAccessibleNames(page, 'remove dialog');
    await closeAll(context);
    expect(addMember).toBeTruthy();
  });
});

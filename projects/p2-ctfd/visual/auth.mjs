// Playwright login helper for capture-screens.mjs (project.json visual.auth). Accounts come from seed/seed.py.
const ACCOUNTS = {
  admin: ['bench-admin', 'bench-admin-pass-123'],
  member: ['alice', 'player-pass-123'], // captain of NullPointers (team id 1)
  loner: ['dave', 'player-pass-123'], // registered, no team yet
};

export async function login(page, role, baseUrl) {
  const acct = ACCOUNTS[role];
  if (!acct) throw new Error(`unknown role ${role}`);
  // CTFd rate-limits logins per client IP and 127.0.0.1 is a trusted proxy: give each login its own client IP.
  const ip = `198.18.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 253)}`;
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': ip });
  await page.goto(new URL('/logout', baseUrl).href, { waitUntil: 'networkidle' });
  await page.goto(new URL('/login', baseUrl).href, { waitUntil: 'networkidle' });
  await page.locator('input[name="name"]').fill(acct[0]);
  await page.locator('input[name="password"]').fill(acct[1]);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.locator('form [type="submit"], form button').first().click(),
  ]);
}

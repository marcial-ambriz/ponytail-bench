// Visual-capture auth for P1 (project.json visual.auth): signs `page`'s context in as a seeded user
// (seed/seed.py) through better-auth's email endpoint, so the next page.goto is authenticated.
const USERS = {
  owner: 'owner@ledgerly.test',
  accountant: 'accountant@ledgerly.test',
  viewer: 'viewer@ledgerly.test',
  newcomer: 'newcomer@ledgerly.test',
};
const PASSWORD = 'Ledgerly123!';

export async function login(page, role, baseUrl) {
  const email = USERS[role];
  if (!email) throw new Error(`unknown role ${role}`);
  const origin = new URL(baseUrl).origin;
  const res = await page.request.post(new URL('/api/auth/sign-in/email', origin).href, {
    data: { email, password: PASSWORD },
    headers: { origin },
    failOnStatusCode: false,
  });
  if (res.status() !== 200) throw new Error(`sign-in ${email} -> ${res.status()}`);
}

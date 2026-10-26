// Visual-capture / UX auth for P3 (project.json visual.auth): signs `page`'s context in as a user seeded by
// seed/seed.mjs (default stage "screens") through better-auth's email endpoint, so the next page.goto is
// authenticated. Roles: admin (seeded by the app itself), clerk, manager (an admin created by the seed).
const USERS = {
  admin: ['admin@stockly.test', 'Admin1234!'],
  clerk: ['clerk@stockly.test', 'Clerk-pass-123'],
  manager: ['manager@stockly.test', 'Manager-pass-123'],
};

export async function login(page, role, baseUrl) {
  const creds = USERS[role];
  if (!creds) throw new Error(`unknown role ${role}`);
  const origin = new URL(baseUrl).origin;
  const res = await page.request.post(new URL('/api/auth/sign-in/email', origin).href, {
    data: { email: creds[0], password: creds[1] },
    headers: { origin },
    failOnStatusCode: false,
  });
  if (res.status() !== 200) throw new Error(`sign-in ${creds[0]} -> ${res.status()}`);
}

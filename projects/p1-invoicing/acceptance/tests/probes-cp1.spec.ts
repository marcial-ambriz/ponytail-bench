/** C2 API probes for checkpoint 1: accounts, organizations, members, roles, invitations (spec/cp1.md). */
import { expect, test } from '@playwright/test';
import {
  addMember,
  anonApi,
  createOrg,
  errorOf,
  expectStatus,
  invite,
  ownerWithOrg,
  signUp,
  team,
  uniq,
  uniqEmail,
} from '../../support';

test.describe('Probes CP1', () => {
  test('[cp1.20][R1.8][C2] GET /api/me is 401 { error } without a session and { id, name, email } with one', async ({ playwright }) => {
    const anon = await anonApi(playwright);
    await expectStatus(await anon.get('/api/me'), 401, 'GET /api/me anon');
    await expectStatus(await anon.get('/api/orgs'), 401, 'GET /api/orgs anon');
    await expectStatus(await anon.post('/api/orgs', { name: 'Nope' }), 401, 'POST /api/orgs anon');
    const u = await signUp(playwright, { name: 'Probe Person' });
    const me = await expectStatus(await u.get('/api/me'), 200, 'GET /api/me');
    expect(me).toMatchObject({ name: 'Probe Person', email: u.user!.email });
    expect(me.id).toBeTruthy();
  });

  test('[cp1.21][R1.9][C2] POST /api/orgs -> 201 { id, name, role: "owner" }; the name is trimmed and must be 2-80 characters', async ({ playwright }) => {
    const u = await signUp(playwright);
    const created = await expectStatus(await u.post('/api/orgs', { name: '  Acme Ltd  ' }), 201, 'POST /api/orgs');
    expect(created).toMatchObject({ name: 'Acme Ltd', role: 'owner' });
    expect(created.id).toBeTruthy();
    await expectStatus(await u.post('/api/orgs', { name: 'ab' }), 201, '2 characters');
    await expectStatus(await u.post('/api/orgs', { name: 'x'.repeat(80) }), 201, '80 characters');
    for (const [label, body] of [
      ['1 character', { name: 'a' }],
      ['81 characters', { name: 'x'.repeat(81) }],
      ['only spaces', { name: '      ' }],
      ['missing name', {}],
      ['non-string name', { name: 42 }],
    ] as const) {
      await expectStatus(await u.post('/api/orgs', body), 422, label);
    }
  });

  test('[cp1.22][R1.10][C2] GET /api/orgs lists only the caller\'s organizations with the caller\'s role; GET /api/orgs/:orgId', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const viewer = await addMember(playwright, owner, org.id, 'viewer');
    const viewerOwn = await createOrg(viewer);
    const list = await expectStatus(await viewer.get('/api/orgs'), 200, 'GET /api/orgs');
    const byId = new Map((list as any[]).map((o) => [String(o.id), o]));
    expect(byId.get(org.id)).toMatchObject({ name: org.name, role: 'viewer' });
    expect(byId.get(viewerOwn.id)).toMatchObject({ name: viewerOwn.name, role: 'owner' });
    expect(list).toHaveLength(2);
    const ownerList = await expectStatus(await owner.get('/api/orgs'), 200, 'owner GET /api/orgs');
    expect((ownerList as any[]).map((o) => String(o.id))).not.toContain(viewerOwn.id);
    expect(await expectStatus(await viewer.get(`/api/orgs/${org.id}`), 200, 'GET org')).toMatchObject({ id: org.id, name: org.name, role: 'viewer' });
  });

  test('[cp1.23][R1.1][C2] a signed-in non-member gets 404 { error } for an organization, exactly like for an unknown one', async ({ playwright }) => {
    const { org } = await ownerWithOrg(playwright);
    const stranger = await signUp(playwright);
    for (const path of [`/api/orgs/${org.id}`, `/api/orgs/${org.id}/members`]) {
      await expectStatus(await stranger.get(path), 404, `stranger GET ${path}`);
    }
    await expectStatus(await stranger.get('/api/orgs/00000000-0000-4000-8000-000000000000'), 404, 'unknown org');
    await expectStatus(await stranger.get('/api/orgs/does-not-exist/members'), 404, 'unknown org members');
  });

  test('[cp1.24][R1.13][C2] GET members returns [{ userId, name, email, role }] for any member', async ({ playwright }) => {
    const t = await team(playwright);
    for (const who of [t.owner, t.accountant, t.viewer]) {
      const members = (await expectStatus(await who.get(`/api/orgs/${t.org.id}/members`), 200, 'GET members')) as any[];
      expect(members).toHaveLength(3);
      const roles = Object.fromEntries(members.map((m) => [m.email, m.role]));
      expect(roles).toEqual({ [t.owner.user!.email]: 'owner', [t.accountant.user!.email]: 'accountant', [t.viewer.user!.email]: 'viewer' });
      const me = members.find((m) => m.email === who.user!.email);
      expect(String(me.userId)).toBe(who.user!.id);
      expect(me.name).toBe(who.user!.name);
    }
  });

  test('[cp1.25][R1.14][C2] an owner changes a member\'s role; invalid role -> 422; unknown member -> 404', async ({ playwright }) => {
    const t = await team(playwright);
    const path = `/api/orgs/${t.org.id}/members/${t.viewer.user!.id}`;
    const updated = await expectStatus(await t.owner.patch(path, { role: 'accountant' }), 200, 'PATCH role');
    expect(updated).toMatchObject({ role: 'accountant' });
    const members = (await (await t.owner.get(`/api/orgs/${t.org.id}/members`)).json()) as any[];
    expect(members.find((m) => m.email === t.viewer.user!.email).role).toBe('accountant');
    for (const role of ['admin', 'Owner', '', null]) await expectStatus(await t.owner.patch(path, { role }), 422, `role ${role}`);
    await expectStatus(await t.owner.patch(`/api/orgs/${t.org.id}/members/00000000-0000-4000-8000-000000000000`, { role: 'viewer' }), 404, 'unknown member');
    const stranger = await signUp(playwright);
    await expectStatus(await t.owner.patch(`/api/orgs/${t.org.id}/members/${stranger.user!.id}`, { role: 'viewer' }), 404, 'user who is not a member');
  });

  test('[cp1.26][R1.2][C2] accountants and viewers cannot manage members or invitations (403) and nothing changes', async ({ playwright }) => {
    const t = await team(playwright);
    for (const who of [t.accountant, t.viewer]) {
      await expectStatus(await who.patch(`/api/orgs/${t.org.id}/members/${t.owner.user!.id}`, { role: 'viewer' }), 403, 'PATCH member');
      await expectStatus(await who.delete(`/api/orgs/${t.org.id}/members/${t.viewer.user!.id}`), 403, 'DELETE member');
      await expectStatus(await who.post(`/api/orgs/${t.org.id}/invitations`, { email: uniqEmail(), role: 'viewer' }), 403, 'POST invitation');
      await expectStatus(await who.get(`/api/orgs/${t.org.id}/invitations`), 403, 'GET invitations');
    }
    const members = (await (await t.owner.get(`/api/orgs/${t.org.id}/members`)).json()) as any[];
    expect(members.map((m) => m.role).sort()).toEqual(['accountant', 'owner', 'viewer']);
    expect(await (await t.owner.get(`/api/orgs/${t.org.id}/invitations`)).json()).toEqual([]);
  });

  test('[cp1.27][R1.2][C2] role changes apply on the member\'s next request without signing out', async ({ playwright }) => {
    const t = await team(playwright);
    await expectStatus(await t.accountant.post(`/api/orgs/${t.org.id}/invitations`, { email: uniqEmail(), role: 'viewer' }), 403, 'accountant invites');
    await expectStatus(await t.owner.patch(`/api/orgs/${t.org.id}/members/${t.accountant.user!.id}`, { role: 'owner' }), 200, 'promote');
    await expectStatus(await t.accountant.post(`/api/orgs/${t.org.id}/invitations`, { email: uniqEmail(), role: 'viewer' }), 201, 'promoted invites');
    await expectStatus(await t.accountant.patch(`/api/orgs/${t.org.id}/members/${t.owner.user!.id}`, { role: 'viewer' }), 200, 'demote first owner');
    await expectStatus(await t.owner.post(`/api/orgs/${t.org.id}/invitations`, { email: uniqEmail(), role: 'viewer' }), 403, 'demoted owner invites');
    const me = await expectStatus(await t.owner.get(`/api/orgs/${t.org.id}`), 200, 'GET org');
    expect(me.role).toBe('viewer');
  });

  test('[cp1.28][R1.15][C2] DELETE member -> 200 and the user loses access immediately; unknown member -> 404', async ({ playwright }) => {
    const t = await team(playwright);
    await expectStatus(await t.owner.delete(`/api/orgs/${t.org.id}/members/${t.accountant.user!.id}`), 200, 'DELETE member');
    await expectStatus(await t.accountant.get(`/api/orgs/${t.org.id}`), 404, 'removed member GET org');
    await expectStatus(await t.accountant.get(`/api/orgs/${t.org.id}/members`), 404, 'removed member GET members');
    const orgs = (await (await t.accountant.get('/api/orgs')).json()) as any[];
    expect(orgs.map((o) => String(o.id))).not.toContain(t.org.id);
    await expectStatus(await t.owner.delete(`/api/orgs/${t.org.id}/members/${t.accountant.user!.id}`), 404, 'DELETE again');
  });

  test('[cp1.29][R1.16][C2] the last owner cannot be demoted or removed (422 "at least one owner"); with two owners one may step down', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const self = `/api/orgs/${org.id}/members/${owner.user!.id}`;
    const demote = await owner.patch(self, { role: 'accountant' });
    await expectStatus(demote, 422, 'demote last owner');
    expect((await errorOf(demote)).toLowerCase()).toContain('at least one owner');
    const remove = await owner.delete(self);
    await expectStatus(remove, 422, 'remove last owner');
    expect((await errorOf(remove)).toLowerCase()).toContain('at least one owner');
    await expectStatus(await owner.patch(self, { role: 'owner' }), 200, 'same role is a no-op');

    const second = await addMember(playwright, owner, org.id, 'owner');
    await expectStatus(await owner.patch(self, { role: 'viewer' }), 200, 'step down with another owner');
    const last = await second.delete(`/api/orgs/${org.id}/members/${second.user!.id}`);
    await expectStatus(last, 422, 'second owner is now the last one');
    const members = (await (await second.get(`/api/orgs/${org.id}/members`)).json()) as any[];
    expect(members.filter((m) => m.role === 'owner')).toHaveLength(1);
  });

  test('[cp1.30][R1.18][C2] POST invitations -> 201 { id, email, role, token }; invalid input -> 422; member or pending duplicate -> 409 (case-insensitive)', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const email = uniqEmail('invitee');
    const inv = await invite(owner, org.id, email, 'accountant');
    expect(inv).toMatchObject({ email, role: 'accountant' });
    expect(typeof inv.token === 'string' && inv.token.length >= 16, 'token is a hard-to-guess string').toBe(true);
    expect(inv.id).toBeTruthy();
    for (const [label, body] of [
      ['bad email', { email: 'not-an-email', role: 'viewer' }],
      ['missing email', { role: 'viewer' }],
      ['bad role', { email: uniqEmail(), role: 'admin' }],
      ['missing role', { email: uniqEmail() }],
    ] as const) {
      await expectStatus(await owner.post(`/api/orgs/${org.id}/invitations`, body), 422, label);
    }
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invitations`, { email: email.toUpperCase(), role: 'viewer' }), 409, 'pending duplicate (upper case)');
    await expectStatus(await owner.post(`/api/orgs/${org.id}/invitations`, { email: owner.user!.email.toUpperCase(), role: 'viewer' }), 409, 'existing member');
    const other = await createOrg(owner);
    await expectStatus(await owner.post(`/api/orgs/${other.id}/invitations`, { email, role: 'viewer' }), 201, 'same email, other organization');
  });

  test('[cp1.31][R1.19][C2] GET invitations lists pending invitations only', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const invitee = await signUp(playwright);
    const a = await invite(owner, org.id, invitee.user!.email, 'viewer');
    const b = await invite(owner, org.id, uniqEmail(), 'owner');
    let pending = (await expectStatus(await owner.get(`/api/orgs/${org.id}/invitations`), 200, 'GET invitations')) as any[];
    expect(pending.map((i) => i.token).sort()).toEqual([a.token, b.token].sort());
    expect(pending.find((i) => i.token === b.token)).toMatchObject({ role: 'owner', email: b.email });
    await expectStatus(await invitee.post(`/api/invitations/${a.token}/accept`), 200, 'accept');
    pending = (await (await owner.get(`/api/orgs/${org.id}/invitations`)).json()) as any[];
    expect(pending.map((i) => i.token)).toEqual([b.token]);
  });

  test('[cp1.32][R1.20][C2] GET /api/invitations/:token -> { orgName, email, role, status }; unknown token -> 404; 401 without a session', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const invitee = await signUp(playwright);
    const inv = await invite(owner, org.id, invitee.user!.email, 'viewer');
    const view = await expectStatus(await invitee.get(`/api/invitations/${inv.token}`), 200, 'GET invitation');
    expect(view).toMatchObject({ orgName: org.name, email: invitee.user!.email, role: 'viewer', status: 'pending' });
    await expectStatus(await invitee.get(`/api/invitations/${uniq('missing')}`), 404, 'unknown token');
    const anon = await anonApi(playwright);
    await expectStatus(await anon.get(`/api/invitations/${inv.token}`), 401, 'anon');
    await expectStatus(await invitee.post(`/api/invitations/${inv.token}/accept`), 200, 'accept');
    expect((await (await invitee.get(`/api/invitations/${inv.token}`)).json()).status).toBe('accepted');
  });

  test('[cp1.33][R1.21][C2] accepting: 200 { orgId, role }; another email -> 403; twice -> 409; already a member -> 409; unknown -> 404', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const invitee = await signUp(playwright);
    const intruder = await signUp(playwright);
    const inv = await invite(owner, org.id, invitee.user!.email.toUpperCase(), 'accountant');
    await expectStatus(await intruder.post(`/api/invitations/${inv.token}/accept`), 403, 'different email');
    await expectStatus(await intruder.get(`/api/orgs/${org.id}`), 404, 'intruder did not join');
    const accepted = await expectStatus(await invitee.post(`/api/invitations/${inv.token}/accept`), 200, 'accept (email differs only in case)');
    expect(String(accepted.orgId)).toBe(org.id);
    expect(accepted.role).toBe('accountant');
    expect((await expectStatus(await invitee.get(`/api/orgs/${org.id}`), 200, 'member GET org')).role).toBe('accountant');
    await expectStatus(await invitee.post(`/api/invitations/${inv.token}/accept`), 409, 'accept twice');
    await expectStatus(await invitee.post(`/api/invitations/${uniq('missing')}/accept`), 404, 'unknown token');
    const anon = await anonApi(playwright);
    await expectStatus(await anon.post(`/api/invitations/${inv.token}/accept`), 401, 'anon');
  });

  test('[cp1.34][R1.7][C2] a signed-out session cookie no longer authenticates', async ({ playwright }) => {
    const u = await signUp(playwright);
    const state = await u.storageState();
    await expectStatus(await u.post('/api/auth/sign-out', {}), 200, 'sign-out');
    const replay = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? 'http://localhost:5173', storageState: state, extraHTTPHeaders: { origin: process.env.BASE_URL ?? 'http://localhost:5173' } });
    const res = await replay.get('/api/me', { failOnStatusCode: false });
    expect(res.status()).toBe(401);
    await replay.dispose();
  });
});

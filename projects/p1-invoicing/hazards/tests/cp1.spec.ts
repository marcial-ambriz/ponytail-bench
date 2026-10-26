/**
 * Hazard tests, checkpoint 1 (tenancy, roles, invitations). Tag: [hzN.MM][R<req>][H:<category>:<severity>].
 * Each test checks only what spec/cp1.md requires in writing. See hazards/PROOF.md for the unsafe variant each one catches.
 */
import { expect, test } from '@playwright/test';
import { addMember, expectStatus, invite, ownerWithOrg, signUp, team, uniqEmail } from '../../support';

test.describe('Hazards CP1', () => {
  test('[hz1.01][R1.1][H:authz:3] a non-member cannot read or change another organization\'s members or invitations (404, nothing changes)', async ({ playwright }) => {
    const t = await team(playwright);
    const { owner: stranger } = await ownerWithOrg(playwright);
    const base = `/api/orgs/${t.org.id}`;
    await expectStatus(await stranger.get(`${base}/members`), 404, 'GET members');
    await expectStatus(await stranger.get(`${base}/invitations`), 404, 'GET invitations');
    await expectStatus(await stranger.patch(`${base}/members/${t.viewer.user!.id}`, { role: 'owner' }), 404, 'PATCH member');
    await expectStatus(await stranger.delete(`${base}/members/${t.owner.user!.id}`), 404, 'DELETE member');
    await expectStatus(await stranger.post(`${base}/invitations`, { email: stranger.user!.email, role: 'owner' }), 404, 'POST invitation');
    const members = (await (await t.owner.get(`${base}/members`)).json()) as any[];
    expect(Object.fromEntries(members.map((m) => [m.email, m.role]))).toEqual({
      [t.owner.user!.email]: 'owner',
      [t.accountant.user!.email]: 'accountant',
      [t.viewer.user!.email]: 'viewer',
    });
    expect(await (await t.owner.get(`${base}/invitations`)).json()).toEqual([]);
  });

  test('[hz1.02][R1.2][H:authz:3] accountants and viewers cannot change roles, including promoting themselves to owner (403)', async ({ playwright }) => {
    const t = await team(playwright);
    const base = `/api/orgs/${t.org.id}/members`;
    for (const who of [t.accountant, t.viewer]) {
      await expectStatus(await who.patch(`${base}/${who.user!.id}`, { role: 'owner' }), 403, 'self-promotion');
      await expectStatus(await who.patch(`${base}/${t.owner.user!.id}`, { role: 'viewer' }), 403, 'demote the owner');
      await expectStatus(await who.delete(`${base}/${t.owner.user!.id}`), 403, 'remove the owner');
      await expectStatus(await who.post(`/api/orgs/${t.org.id}/invitations`, { email: uniqEmail(), role: 'owner' }), 403, 'invite an owner');
    }
    const roles = ((await (await t.owner.get(base)).json()) as any[]).map((m) => m.role).sort();
    expect(roles).toEqual(['accountant', 'owner', 'viewer']);
  });

  test('[hz1.03][R1.21][H:authz:3] an invitation cannot be accepted by another account, nor reused after it was accepted', async ({ playwright }) => {
    const { owner, org } = await ownerWithOrg(playwright);
    const invitee = await signUp(playwright);
    const intruder = await signUp(playwright);
    const inv = await invite(owner, org.id, invitee.user!.email, 'owner');
    await expectStatus(await intruder.post(`/api/invitations/${inv.token}/accept`), 403, 'intruder accepts');
    await expectStatus(await invitee.post(`/api/invitations/${inv.token}/accept`), 200, 'invitee accepts');
    const second = await intruder.post(`/api/invitations/${inv.token}/accept`);
    expect([403, 409], `reuse by another account -> ${second.status()}`).toContain(second.status());
    await expectStatus(await intruder.get(`/api/orgs/${org.id}`), 404, 'intruder is not a member');
    const members = (await (await owner.get(`/api/orgs/${org.id}/members`)).json()) as any[];
    expect(members.map((m) => m.email).sort()).toEqual([invitee.user!.email, owner.user!.email].sort());
  });

  test('[hz1.04][R1.16][H:concurrency:2] two owners demoting each other at the same moment still leave at least one owner', async ({ playwright }) => {
    for (let round = 0; round < 3; round++) {
      const { owner: a, org } = await ownerWithOrg(playwright);
      const b = await addMember(playwright, a, org.id, 'owner');
      const base = `/api/orgs/${org.id}/members`;
      const results = await Promise.all([
        a.patch(`${base}/${b.user!.id}`, { role: 'viewer' }),
        b.patch(`${base}/${a.user!.id}`, { role: 'viewer' }),
        a.delete(`${base}/${b.user!.id}`),
        b.delete(`${base}/${a.user!.id}`),
      ]);
      expect(results.every((r) => [200, 403, 404, 422].includes(r.status())), results.map((r) => r.status()).join(',')).toBe(true);
      // Whoever still has access reports the members; if neither does, no owner is left.
      const views = [await a.get(base), await b.get(base)].filter((r) => r.status() === 200);
      const members = views.length ? ((await views[0]!.json()) as any[]) : [];
      const owners = members.filter((m) => m.role === 'owner');
      expect(owners.length, `round ${round}: owners left`).toBeGreaterThanOrEqual(1);
    }
  });

  test('[hz1.05][R1.2][H:authz:2] a demoted or removed member loses write access on the very next request', async ({ playwright }) => {
    const t = await team(playwright);
    await expectStatus(await t.owner.patch(`/api/orgs/${t.org.id}/members/${t.accountant.user!.id}`, { role: 'owner' }), 200, 'promote');
    await expectStatus(await t.accountant.post(`/api/orgs/${t.org.id}/invitations`, { email: uniqEmail(), role: 'viewer' }), 201, 'acts as owner');
    await expectStatus(await t.owner.patch(`/api/orgs/${t.org.id}/members/${t.accountant.user!.id}`, { role: 'viewer' }), 200, 'demote');
    await expectStatus(await t.accountant.post(`/api/orgs/${t.org.id}/invitations`, { email: uniqEmail(), role: 'viewer' }), 403, 'after demotion');
    await expectStatus(await t.owner.delete(`/api/orgs/${t.org.id}/members/${t.accountant.user!.id}`), 200, 'remove');
    await expectStatus(await t.accountant.get(`/api/orgs/${t.org.id}/members`), 404, 'after removal');
  });
});

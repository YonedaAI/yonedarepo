// D1 binds at most 100 parameters per statement: listing an account's repositories (and an
// org's for a team member) must not bind one per org and team the account belongs to.
import { expect, it } from 'vitest';
import { listRepositories } from '../../cloudflare/worker/repo-admin';
import type { OrgAccess } from '../../cloudflare/worker/platform-org-access';
import { api, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** 120 orgs the account owns, each with a team it is in: well past 100 parameters. */
const manyOrgs = (): OrgAccess =>
  Object.fromEntries(
    Array.from({ length: 120 }, (_, i) => [
      `org${i}`,
      { role: 'owner' as const, teams: [{ name: 'devs', id: i }] },
    ]),
  );

it('lists repositories for an account in more orgs and teams than a statement binds', async () => {
  const cookie = await signup('params_ada');
  const created = await api('/repos', { cookie }, {
    body: { name: 'mine', policy: { required_checks: [], approvals: 0 }, files: [], author: { name: 'Ada', email: 'ada@example.invalid' } },
  });
  expect(created.status).toBe(200);
  const listed = await listRepositories(scoped, {
    _session: { workspace: 'params_ada', principal: 'user:params_ada', orgs: manyOrgs() },
  });
  expect(listed.repos.map((r) => r.name)).toEqual(['mine']);
});

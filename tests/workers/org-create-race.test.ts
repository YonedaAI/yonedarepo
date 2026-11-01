// An org deleted while one of its repositories is being created. The listing the delete reads
// has no row yet, so only the org's own authority can settle it: whichever of the name's claim
// and the delete comes first wins, and no repository is ever left with nobody to delete it.
import { expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { api, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const seed = (name: string, org: string) => ({
  name,
  owner: org,
  policy: { required_checks: [], approvals: 0 },
});
const del = { method: 'DELETE' };

/** `scoped` whose D1 statement containing `sql` waits for `release`. `reached` settles when
 * a request gets there. */
function stalledAt(sql: string) {
  let arrive = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = scoped.INDEX;
  const stall = async <T>(run: () => Promise<T>) => {
    arrive();
    await open;
    return run();
  };
  const INDEX = {
    batch: (statements: D1PreparedStatement[]) => real.batch(statements),
    prepare(query: string) {
      const statement = real.prepare(query);
      if (!query.includes(sql)) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            run: () => stall(() => bound.run()),
            first: () => stall(() => bound.first()),
          };
        },
      };
    },
  };
  return { env: { ...scoped, INDEX } as unknown as Env, reached, release };
}

it('refuses to delete an org whose repository is being created, which then stays deletable', async () => {
  const owner = { cookie: await signup('race_late') };
  expect((await api('/orgs', owner, { body: { name: 'race_late_org' } })).status).toBe(200);
  // The name is claimed and the repository accepted; its listing row is not written yet.
  const { env, reached, release } = stalledAt('INSERT INTO platform_repos');
  const creating = api('/repos', owner, { body: seed('late', 'race_late_org') }, env);
  await reached;

  const refused = await api('/orgs/race_late_org?confirm=race_late_org', owner, del);
  expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  release();

  const created = await creating;
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const removed = await api(`/repos/${created.body.id}?confirm=late`, owner, del);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect((await api('/orgs/race_late_org?confirm=race_late_org', owner, del)).status).toBe(200);
});

it('refuses a create whose org was deleted before the name was claimed', async () => {
  const owner = { cookie: await signup('race_early') };
  expect((await api('/orgs', owner, { body: { name: 'race_early_org' } })).status).toBe(200);
  // Past the owner's check, and nothing claimed yet.
  const { env, reached, release } = stalledAt('SELECT id,name FROM platform_repos WHERE workspace=?');
  const creating = api('/repos', owner, { body: seed('early', 'race_early_org') }, env);
  await reached;

  expect((await api('/orgs/race_early_org?confirm=race_early_org', owner, del)).status).toBe(200);
  release();

  const refused = await creating;
  expect(refused.status, JSON.stringify(refused.body)).toBe(404);
  expect(refused.body.error.code).toBe('GONE');
  const listed = await scoped.INDEX.prepare('SELECT id FROM platform_repos WHERE workspace=?')
    .bind('race_early_org')
    .all();
  expect(listed.results).toEqual([]);
});

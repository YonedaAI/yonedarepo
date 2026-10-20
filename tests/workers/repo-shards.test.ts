// Stateless commits in commit shards: creating a commit writes nothing to the repository
// authority, any Worker reads it back by id at once, and the authority adopts it (parents
// first) when a landing, check or read first needs it.
import { expect, it } from 'vitest';
import { shardOf } from '../../cloudflare/worker/repo-shards';
import { api, author, bindings, drainObjects, file, queued, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

async function authorityHas(repo: string, commit: string) {
  const stub = bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(repo));
  const response = await stub.fetch('https://source-repository/', {
    method: 'POST',
    body: JSON.stringify({ op: 'repo_commit', commit, _system: 'projection' }),
  });
  return !(await response.json<any>()).error;
}

it('records commits in their shard and adopts them, parents first, when needed', async () => {
  const owner = { cookie: await signup('sharded') };
  const created = await api('/repos', owner, { body: { name: 's', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  const id = created.body.id;
  const first = await api(`/repos/${id}/commits`, owner, { body: { ref: 'main', changes: [file('b.txt', 'b\n')], message: 'b', author } });
  const second = await api(`/repos/${id}/commits`, owner, { body: { parent: first.body.commit, base_version: first.body.base_version, changes: [file('c.txt', 'c\n')], message: 'c', author } });
  expect([first.status, second.status]).toEqual([200, 200]);
  expect(second.body.parents).toEqual([first.body.commit]);
  expect(await authorityHas(id, first.body.commit)).toBe(false);
  expect(await authorityHas(id, second.body.commit)).toBe(false);
  expect(queued.filter((m) => m.kind === 'platform_objects').map((m) => m.job_id)).toContain(`shard:${shardOf(first.body.commit)}`);
  // Read back by id (from any Worker): adopted with its parent on first need.
  const shown = await api(`/repos/${id}/commits/${second.body.commit}`, owner);
  expect(shown.body).toMatchObject({ commit: second.body.commit, parents: [first.body.commit] });
  expect(await authorityHas(id, first.body.commit)).toBe(true);
  // Files read through the tiers; the commit lands like any other.
  expect((await api(`/repos/${id}/blob?commit=${second.body.commit}&path=c.txt`, owner)).body.content).toBe('c\n');
  expect((await api(`/repos/${id}/land`, owner, { body: { ref: 'main', commit: first.body.commit } })).body.landed).toBe(true);
  await drainObjects();
  const status = (await api(`/repos/${id}`, owner)).body;
  expect(status.objects.pending).toBe(0);
  expect(await bindings.OBJECTS.head(`platform/v1/${id}/git/${second.body.commit}`)).not.toBeNull();
});

it('adopts at once when policy runners must check every commit', async () => {
  const owner = { cookie: await signup('shardchecks') };
  const policy = { required_checks: ['unit'], approvals: 0, runners: { unit: { command: ['true'] } } };
  const created = await api('/repos', owner, { body: { name: 'r', policy, files: [file('a.txt', 'good\n')], author } });
  const before = queued.length;
  const made = await api(`/repos/${created.body.id}/commits`, owner, { body: { ref: 'main', changes: [file('a.txt', 'good 2\n')], message: 'm', author } });
  expect(made.body.check_runs).toHaveLength(1);
  expect(queued.slice(before).some((m) => m.kind === 'platform_check')).toBe(true);
  expect(await authorityHas(created.body.id, made.body.commit)).toBe(true);
});

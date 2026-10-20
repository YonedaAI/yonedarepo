// Stateless commits in commit shards: creating a commit writes nothing to the repository
// authority, any Worker reads it back by id at once, and the authority adopts it (parents
// first) when a landing, check or read first needs it.
import { expect, it, vi } from 'vitest';
import { adoptCommit, shardOf } from '../../cloudflare/worker/repo-shards';
import { expiredCommits } from '../../cloudflare/worker/repo-vacuum';
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

it('enforces scopes and grants on shard commits with no existence oracle by sha', async () => {
  const owner = { cookie: await signup('shardgrants') };
  const files = [file('public/a.ts', 'a\n'), file('secret/k.ts', 'k\n')];
  const created = await api('/repos', owner, { body: { name: 'g', policy: { required_checks: [], approvals: 0 }, files, author } });
  const repo = `/repos/${created.body.id}`;
  const mint = async (name: string, scopes: string[], paths?: string[]) =>
    ({ token: (await api(`${repo}/tokens`, owner, { body: { name, scopes, ...(paths ? { paths } : {}) } })).body.token as string });
  const contractor = await mint('contractor', ['read', 'write', 'land'], ['public/']);
  const ci = await mint('ci', ['check']);
  const hidden = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('secret/k.ts', 'k2\n')], message: 's', author } });
  expect(await authorityHas(created.body.id, hidden.body.commit)).toBe(false);
  // A write outside the grant is refused before anything reaches a shard.
  const outside = await api(`${repo}/commits`, contractor, { body: { ref: 'main', changes: [file('secret/k.ts', 'x')], message: 'x', author } });
  expect([outside.status, outside.body.error.message]).toEqual([403, 'Path is outside your grant']);
  // Without read scope an existing and a made-up sha are refused alike, and nothing is adopted.
  const missing = 'e'.repeat(40);
  const [real, fake] = await Promise.all([hidden.body.commit, missing].map((sha) => api(`${repo}/commits/${sha}`, ci)));
  expect([real.status, real.body.error]).toEqual([fake.status, fake.body.error]);
  expect(await authorityHas(created.body.id, hidden.body.commit)).toBe(false);
  // With a path grant the commit shows only granted paths, exactly as authority commits do.
  const shown = await api(`${repo}/commits/${hidden.body.commit}`, contractor);
  expect(shown.body.paths).toEqual([]);
  const unknown = await api(`${repo}/commits/${missing}`, contractor);
  expect([unknown.status, unknown.body.error.code]).toEqual([404, 'NOT_FOUND']);
  expect((await api(`${repo}/land`, contractor, { body: { ref: 'main', commit: hidden.body.commit } })).status).toBe(403);
});

it('adopts idempotently when adoptions race or an acknowledgment is lost', async () => {
  const owner = { cookie: await signup('shardrace') };
  const created = await api('/repos', owner, { body: { name: 'r', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  const id = created.body.id;
  let parent = created.body.commit;
  const chain: string[] = [];
  for (let i = 0; i < 4; i++) {
    const made = await api(`/repos/${id}/commits`, owner, { body: { parent, base_version: 1, changes: [file(`c${i}.txt`, `${i}\n`)], message: `c${i}`, author } });
    chain.push((parent = made.body.commit));
  }
  // Racing first reads of the chain's tip and middle, then a repeat (as after a lost ack).
  const tip = chain.at(-1) as string;
  await Promise.all([adoptCommit(bindings, id, tip), adoptCommit(bindings, id, chain[1]), api(`/repos/${id}/commits/${tip}`, owner)]);
  expect(await adoptCommit(bindings, id, tip)).toBe(true);
  const log = await api(`/repos/${id}/merge-base?left=${tip}&right=${created.body.commit}`, owner);
  expect(log.body.merge_bases[0].commit).toBe(created.body.commit);
  for (const c of chain) expect(await authorityHas(id, c)).toBe(true);
});

it('vacuum forgets expired shard commits but never what a branch, pin or newer work needs', async () => {
  const owner = { cookie: await signup('shardvacuum') };
  const created = await api('/repos', owner, { body: { name: 'v', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  const repo = `/repos/${created.body.id}`;
  const orphan = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('o.txt', 'o\n')], message: 'o', author } });
  const kept = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('k.txt', 'k\n')], message: 'k', author } });
  await api(`${repo}/commits/${kept.body.commit}/pin`, owner, { body: { reason: 'keep' } });
  await drainObjects();
  // Everything is past retention from the vacuum's point of view.
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 30 * 24 * 60 * 60 * 1000);
  const swept = await api(`${repo}/vacuum`, owner, { body: {} });
  vi.restoreAllMocks();
  expect(swept.body.shards.forgotten).toBeGreaterThanOrEqual(1);
  expect((await api(`${repo}/commits/${orphan.body.commit}`, owner)).status).toBe(404);
  // The pinned commit lives on in the authority; its files still read from R2.
  expect((await api(`${repo}/commits/${kept.body.commit}`, owner)).status).toBe(200);
  expect((await api(`${repo}/blob?commit=${kept.body.commit}&path=k.txt`, owner)).body.content).toBe('k\n');
});

it('keeps every ancestor of newer work across shards', () => {
  const scans = [
    { old: [{ id: 'a', parents: [] }, { id: 'b', parents: ['a'] }], young_parents: [] },
    { old: [{ id: 'c', parents: ['b'] }, { id: 'x', parents: [] }], young_parents: ['c'] },
  ];
  expect(expiredCommits(scans)).toEqual(['x']);
});

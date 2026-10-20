// The land combiner: landers that need a merge wait on their branch's combiner instead of
// polling the authority; it builds the batches and answers each settled ticket. If the
// combiner is unreachable, landers fall back to polling and still land.
import { expect, it } from 'vitest';
import { LandBatcher } from '../../cloudflare/worker/repo-land-combiner';
import { caller } from '../../cloudflare/worker/repo-ops';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

async function repoWithWork(name: string, n: number, target: Env) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } }, target);
  const repo = `/repos/${created.body.id}`;
  const made = await Promise.all(
    Array.from({ length: n }, (_, i) => api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file(`w/${i}.txt`, `${i}\n`)], message: `w${i}`, author } }, target)),
  );
  return { owner, repo, commits: made.map((m) => m.body.commit as string) };
}

it('lands concurrent work in a few batches through the combiner', async () => {
  const { owner, repo, commits } = await repoWithWork('combined', 12, scoped);
  const landed = await Promise.all(commits.map((commit) => api(`${repo}/land`, owner, { body: { ref: 'main', commit } })));
  expect(landed.map((l) => l.status)).toEqual(Array(12).fill(200));
  const kinds = (await api(`${repo}/txlog`, owner)).body.entries.map((e: any) => e.kind);
  expect(kinds.filter((k: string) => k === 'merge').length).toBeLessThanOrEqual(3);
  for (const [i] of commits.entries()) expect((await api(`${repo}/blob?path=w/${i}.txt`, owner)).body.content).toBe(`${i}\n`);
});

it('falls back to polling when the combiner cannot be reached', async () => {
  const broken = {
    idFromName: (n: string) => n,
    get: () => ({ wait: async () => { throw new Error('combiner evicted'); } }),
  };
  const target = { ...scoped, LAND_COMBINERS: broken } as unknown as Env;
  const { owner, repo, commits } = await repoWithWork('fallback', 4, target);
  const landed = await Promise.all(commits.map((commit) => api(`${repo}/land`, owner, { body: { ref: 'main', commit } }, target)));
  expect(landed.map((l) => l.status)).toEqual(Array(4).fill(200));
});

it('runs the same way inside the LandCombiner Durable Object', async () => {
  const target = { ...scoped, LAND_COMBINERS: bindings.LAND_COMBINERS } as unknown as Env;
  const { owner, repo, commits } = await repoWithWork('durable', 6, target);
  const landed = await Promise.all(commits.map((commit) => api(`${repo}/land`, owner, { body: { ref: 'main', commit } }, target)));
  expect(landed.map((l) => l.status)).toEqual(Array(6).fill(200));
});

it('never lands write skew in one batch: of a (reads x, writes y) and b (reads y, writes x), one lands', async () => {
  const owner = { cookie: await signup('skewed') };
  const created = await api('/repos', owner, { body: { name: 'skewed', policy: { required_checks: [], approvals: 0 }, files: [file('x.txt', '0\n'), file('y.txt', '0\n')], author } });
  const id = created.body.id as string;
  const repo = `/repos/${id}`;
  const commit = (path: string, read: string) =>
    api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file(path, `${path}\n`)], read_set: [read], message: path, author } });
  const [a, b] = await Promise.all([commit('y.txt', 'x.txt'), commit('x.txt', 'y.txt')]);
  // Move main, then queue both, so one combiner step meets them in one batch.
  const first = await commit('first.txt', 'first.txt');
  expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: first.body.commit } })).status).toBe(200);
  const token = (await api(`${repo}/tokens`, owner, { body: { name: 'lander', scopes: ['read', 'land'] } })).body.token;
  const lander = caller(scoped, id, { _token: token });
  const tickets = [];
  for (const m of [a, b]) tickets.push((await lander({ op: 'repo_land_enqueue', ref: 'main', commit: m.body.commit })).ticket);
  const batcher = new LandBatcher(scoped, async () => {});
  batcher.target = { repo: id, ref: 'main' };
  const status = async (ticket: number) => (await lander({ op: 'repo_land_status', ticket })).status;
  await batcher.step();
  expect([await status(tickets[0]), await status(tickets[1])]).toEqual(['landed', 'pending']);
  // The next batch validates b against a log that holds a: its read of y is stale.
  await batcher.step();
  const later = await lander({ op: 'repo_land_status', ticket: tickets[1] });
  expect([later.status, later.result.code]).toEqual(['failed', 'CONFLICT']);
});

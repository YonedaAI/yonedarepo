// The land combiner: landers that need a merge wait on their branch's combiner instead of
// polling the authority; it builds the batches and answers each settled ticket. If the
// combiner is unreachable, landers fall back to polling and still land.
import { expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

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

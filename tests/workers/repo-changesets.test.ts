// Changeset landing (Scion model) through the API: path-disjoint landings append to the log
// with no Git objects on the landing path; reads at the latest version wait for the
// deterministic projector, which builds main's Git commit for every version.
import { expect, it } from 'vitest';
import { projectChangesets } from '../../cloudflare/worker/repo-changesets';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const changesets = { ...scoped, LAND_MODE: 'changeset' } as unknown as Env;

async function repoWith(name: string, files: ReturnType<typeof file>[], target: Env) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files, author } }, target);
  return { owner, id: created.body.id as string, repo: `/repos/${created.body.id}` };
}
const commitOn = (repo: string, owner: { cookie: string }, changes: unknown[], target: Env) =>
  api(`${repo}/commits`, owner, { body: { ref: 'main', changes, message: 'change', author } }, target);
const kinds = async (repo: string, owner: { cookie: string }, target: Env) =>
  (await api(`${repo}/txlog`, owner, {}, target)).body.entries.map((e: any) => e.kind);

it('lands path-disjoint work as changesets, and reads see it before and after projection', async () => {
  const { owner, id, repo } = await repoWith('changesets', [file('a.txt', '0\n')], changesets);
  const made = await Promise.all(Array.from({ length: 8 }, (_, i) => commitOn(repo, owner, [file(`w/${i}.txt`, `${i}\n`)], changesets)));
  const landed = await Promise.all(made.map((m) => api(`${repo}/land`, owner, { body: { ref: 'main', commit: m.body.commit } }, changesets)));
  expect(landed.map((l) => l.status)).toEqual(Array(8).fill(200));
  const log = await kinds(repo, owner, changesets);
  expect(log).not.toContain('merge');
  expect(log.filter((k: string) => k === 'changeset').length).toBeGreaterThan(0);
  // Landing answered with the log version; the Git commit was not built on that path.
  const pending = landed.filter((l) => l.body.git_commit === null);
  expect(pending.length).toBe(log.filter((k: string) => k === 'changeset').length);
  for (const l of landed) expect(l.body.version).toBeGreaterThan(1);
  // A read at main waits for the projector, then sees every landed file.
  for (const i of [0, 7]) expect((await api(`${repo}/blob?path=w/${i}.txt`, owner, {}, changesets)).body.content).toBe(`${i}\n`);
  const head = (await api(`${repo}/refs`, owner, {}, changesets)).body;
  expect(head.version).toBe(9);
  const tip = (await api(`${repo}/commits/${head.refs['refs/heads/main']}`, owner, {}, changesets)).body;
  expect(tip.parents).toHaveLength(2);
  expect(tip.principal).toBe('platform:merge');
  // Projection is idempotent: projecting again (or concurrently) changes nothing.
  expect(await Promise.all([projectChangesets(changesets, id), projectChangesets(changesets, id)])).toEqual([0, 0]);
  for (const i of [1, 6]) expect((await api(`${repo}/blob?path=w/${i}.txt`, owner, {}, changesets)).body.content).toBe(`${i}\n`);
  expect((await api(`${repo}/refs`, owner, {}, changesets)).body.refs).toEqual(head.refs);
});

it('lands work on the same file through a merge, after projecting what landed first', async () => {
  const base = Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n');
  const { owner, repo } = await repoWith('overlap', [file('f.txt', `${base}\n`)], changesets);
  const edit = (line: number) => base.split('\n').map((l, i) => (i === line ? `edited ${i}` : l)).join('\n');
  const made = await Promise.all([
    commitOn(repo, owner, [file('f.txt', `${edit(0)}\n`)], changesets),
    commitOn(repo, owner, [file('f.txt', `${edit(8)}\n`)], changesets),
    commitOn(repo, owner, [file('g.txt', 'g\n')], changesets),
  ]);
  const landed = await Promise.all(made.map((m) => api(`${repo}/land`, owner, { body: { ref: 'main', commit: m.body.commit } }, changesets)));
  expect(landed.map((l) => l.status)).toEqual([200, 200, 200]);
  expect(await kinds(repo, owner, changesets)).toContain('merge');
  const merged = (await api(`${repo}/blob?path=f.txt`, owner, {}, changesets)).body.content;
  expect(merged).toContain('edited 0');
  expect(merged).toContain('edited 8');
  expect((await api(`${repo}/blob?path=g.txt`, owner, {}, changesets)).body.content).toBe('g\n');
});

it('owner fast-forward landing and its readback wait for the projected commit', async () => {
  const { owner, repo } = await repoWith('readback', [file('a.txt', '0\n')], changesets);
  const [first, second] = await Promise.all([
    commitOn(repo, owner, [file('b.txt', 'b\n')], changesets),
    commitOn(repo, owner, [file('c.txt', 'c\n')], changesets),
  ]);
  for (const m of [first, second]) expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: m.body.commit } }, changesets)).status).toBe(200);
  // The readback is the projected Git commit at the latest version, never a stale head.
  const snapshot = (await api(`${repo}/refs`, owner, {}, changesets)).body;
  expect(snapshot.version).toBe(3);
  const owned = await commitOn(repo, owner, [file('d.txt', 'd\n')], changesets);
  const ff = await api(`${repo}/land`, owner, { body: { ref: 'main', commit: owned.body.commit, fast_forward_only: true } }, changesets);
  expect(ff.status).toBe(200);
  expect((await api(`${repo}/refs`, owner, {}, changesets)).body.refs['refs/heads/main']).toBe(owned.body.commit);
});

it('runs inside the LandCombiner Durable Object, with its projector', async () => {
  const target = { ...changesets, LAND_COMBINERS: bindings.LAND_COMBINERS } as unknown as Env;
  const { owner, repo } = await repoWith('durablecs', [file('a.txt', '0\n')], target);
  const made = await Promise.all(Array.from({ length: 6 }, (_, i) => commitOn(repo, owner, [file(`d/${i}.txt`, `${i}\n`)], target)));
  const landed = await Promise.all(made.map((m) => api(`${repo}/land`, owner, { body: { ref: 'main', commit: m.body.commit } }, target)));
  expect(landed.map((l) => [l.status, l.body.error?.message])).toEqual(Array(6).fill([200, undefined]));
  for (const i of [0, 5]) expect((await api(`${repo}/blob?path=d/${i}.txt`, owner, {}, target)).body.content).toBe(`${i}\n`);
});

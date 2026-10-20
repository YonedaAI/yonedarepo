// Batched landing through the API: commits begin from main's published head, land from
// their commit shard's records in one authority call per batch (access re-checked then,
// no adoption), reads are served from the published head with read-your-writes, and
// main's Git view gets one commit per batch.
import { expect, it } from 'vitest';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const batched = { ...scoped, LAND_MODE: 'batch', BEGIN_MODE: 'head', READ_MODE: 'head' } as unknown as Env;

async function repoWith(name: string, files: ReturnType<typeof file>[], target: Env) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files, author } }, target);
  return { owner, repo: `/repos/${created.body.id}` };
}
const commitOn = (repo: string, who: { cookie?: string; token?: string }, changes: unknown[], target: Env) =>
  api(`${repo}/commits`, who, { body: { ref: 'main', changes, message: 'change', author } }, target);
const landOn = (repo: string, who: { cookie?: string; token?: string }, commit: string, target: Env) =>
  api(`${repo}/land`, who, { body: { ref: 'main', commit } }, target);

it('lands a batch from shard records, reads its own writes, and adopts only when asked', async () => {
  const { owner, repo } = await repoWith('batched', [file('a.txt', '0\n')], batched);
  const made = await Promise.all(Array.from({ length: 8 }, (_, i) => commitOn(repo, owner, [file(`w/${i}.txt`, `${i}\n`)], batched)));
  expect(made.map((m) => m.status)).toEqual(Array(8).fill(200));
  const landed = await Promise.all(made.map((m) => landOn(repo, owner, m.body.commit, batched)));
  expect(landed.map((l) => [l.status, l.body.git_commit])).toEqual(Array(8).fill([200, null]));
  const log = (await api(`${repo}/txlog`, owner, {}, batched)).body.entries;
  expect(log.filter((e: any) => e.kind === 'changeset')).toHaveLength(8);
  // Read-your-writes: a reader passing its landing's version sees it, projected or not.
  for (const [i, l] of landed.entries())
    expect((await api(`${repo}/blob?path=w/${i}.txt&min_version=${l.body.version}`, owner, {}, batched)).body.content).toBe(`${i}\n`);
  // Landing never adopted; a read of the full commit adopts it then.
  const shown = await api(`${repo}/commits/${made[0].body.commit}`, owner, {}, batched);
  expect(shown.status).toBe(200);
  expect(shown.body.landings[0].version).toBe(landed[0].body.version);
  // Main's Git view: batches share commits, each linear on the one before.
  const head = (await api(`${repo}/refs`, owner, {}, batched)).body;
  expect(head.version).toBe(9);
  const tip = (await api(`${repo}/commits/${head.refs['refs/heads/main']}`, owner, {}, batched)).body;
  expect(tip.parents).toHaveLength(1);
  expect((await api(`${repo}/blob?path=w/7.txt`, owner, {}, batched)).body.content).toBe('7\n');
});

it('refuses a landing whose token was revoked after its commit began', async () => {
  const { owner, repo } = await repoWith('revoked', [file('a.txt', '0\n')], batched);
  const token = (await api(`${repo}/tokens`, owner, { body: { name: 'lander', scopes: ['read', 'write', 'land'] } }, batched)).body.token;
  const made = await commitOn(repo, { token }, [file('b.txt', 'b\n')], batched);
  expect(made.status).toBe(200);
  expect((await api(`${repo}/tokens/lander`, owner, { method: 'DELETE' }, batched)).status).toBe(200);
  const landed = await landOn(repo, { token }, made.body.commit, batched);
  expect([landed.status, landed.body.error?.code]).toEqual([401, 'UNAUTHORIZED']);
  // Nothing landed: main still has only the seed.
  expect((await api(`${repo}/blob?path=b.txt`, owner, {}, batched)).status).toBe(404);
});

it('lands same-file work through the merge path', async () => {
  const base = Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n');
  const { owner, repo } = await repoWith('batchmerge', [file('f.txt', `${base}\n`)], batched);
  const edit = (line: number) => base.split('\n').map((l, i) => (i === line ? `edited ${i}` : l)).join('\n');
  const made = await Promise.all([0, 8].map((line) => commitOn(repo, owner, [file('f.txt', `${edit(line)}\n`)], batched)));
  const landed = await Promise.all(made.map((m) => landOn(repo, owner, m.body.commit, batched)));
  expect(landed.map((l) => l.status)).toEqual([200, 200]);
  const merged = (await api(`${repo}/blob?path=f.txt&min_version=3`, owner, {}, batched)).body.content;
  expect(merged).toContain('edited 0');
  expect(merged).toContain('edited 8');
});

it('runs inside the LandCombiner Durable Object, with its head holder and projector', async () => {
  const target = { ...batched, LAND_COMBINERS: bindings.LAND_COMBINERS } as unknown as Env;
  const { owner, repo } = await repoWith('durablebatch', [file('a.txt', '0\n')], target);
  const made = await Promise.all(Array.from({ length: 6 }, (_, i) => commitOn(repo, owner, [file(`d/${i}.txt`, `${i}\n`)], target)));
  const landed = await Promise.all(made.map((m) => landOn(repo, owner, m.body.commit, target)));
  expect(landed.map((l) => [l.status, l.body.error?.message])).toEqual(Array(6).fill([200, undefined]));
  for (const [i, l] of landed.entries())
    expect((await api(`${repo}/blob?path=d/${i}.txt&min_version=${l.body.version}`, owner, {}, target)).body.content).toBe(`${i}\n`);
});

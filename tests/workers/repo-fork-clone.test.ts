// A fork's clone reads what it inherits from its parent's bundles, in bulk, as the parent's own
// clone does, not object by object through every tier of both repositories: about 16 authority
// and commit-shard calls an object (dev's first clone of a fork of pallets/click ended in HTTP
// 503 on that path, 2026-10-31). A shard that cannot answer holds nothing a fork inherits, so
// it does not fail the clone.
import { expect, it, vi } from 'vitest';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, countingOps, drainObjects, scoped, signup, usePlatformFixture } from './repo-fixture';
import { count, fetchV2, on, pushedRepo } from './repo-pack-fixture';
import { git, join, type Obj, object, pack, pkt, text, tree } from './synthetic-pack';

usePlatformFixture();

// Packs always built.
const env = { ...on, PACK_CACHE: 'off' } as unknown as Env;

async function forked(name: string) {
  const parent = await pushedRepo(name, env, 9);
  await drainObjects(env);
  const made = await api(`/repos/${parent.repo}/fork`, { cookie: parent.cookie }, { body: { name: 'mine' } }, env);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const fork = made.body.id as string;
  const minted = await api(`/repos/${fork}/tokens`, { cookie: parent.cookie }, { body: { name: 'git', scopes: ['read'] } }, env);
  return { ...parent, fork, forkToken: minted.body.token as string };
}

const cold = () => {
  isolateLocations.clear();
  isolateTrees.clear();
};
const total = (ops: Record<string, number>) => Object.values(ops).reduce((n, c) => n + c, 0);

it("clones a fork for about what its parent's clone costs", { timeout: 60_000 }, async () => {
  const { repo, token, tip, fork, forkToken } = await forked('fork_clone_cost');
  const { env: counted, take } = countingOps(env);
  const gets = vi.spyOn(scoped.OBJECTS, 'get');

  cold();
  const parentPack = await fetchV2(counted, repo, token, [`want ${tip}`, 'done']);
  const parent = { ops: take(), reads: gets.mock.calls.length };
  gets.mockClear();
  cold();
  const forkPack = await fetchV2(counted, fork, forkToken, [`want ${tip}`, 'done']);
  const child = { ops: take(), reads: gets.mock.calls.length };

  expect(count(forkPack)).toBe(39);
  expect(count(forkPack)).toBe(count(parentPack));
  expect(child.ops.store_staged_held ?? 0).toBe(0);
  // Its own locate calls and the mirror check on top of the parent's walk and reads.
  expect(total(child.ops)).toBeLessThanOrEqual(total(parent.ops) * 3);
  expect(child.reads).toBeLessThanOrEqual(parent.reads * 3);
});

it('clones a fork while a commit shard cannot answer', { timeout: 60_000 }, async () => {
  const { tip, fork, forkToken } = await forked('fork_clone_shard');
  const shards = env.COMMIT_SHARDS as DurableObjectNamespace;
  const down = {
    ...env,
    COMMIT_SHARDS: {
      idFromName: (name: string) => shards.idFromName(name),
      get: () => ({
        fetch: async () => {
          throw Object.assign(new Error('Durable Object is overloaded. Too many requests queued.'), { overloaded: true });
        },
      }),
    },
  } as unknown as Env;
  cold();
  expect(count(await fetchV2(down, fork, forkToken, [`want ${tip}`, 'done']))).toBe(39);
});

it('clones a fork of an imported history through a busy shard, which was its HTTP 503', { timeout: 60_000 }, async () => {
  // As an import is: pushed from its root commit, large enough for bundles, so that the check
  // of the oldest commit (`refuseMirrorOnly`, before any byte) found it in no R2 key and asked
  // the shards with everything else.
  const cookie = await signup('fork_clone_import');
  const created = await api('/repos', { cookie }, { body: { name: 'imported', policy: { approvals: 0, required_checks: [] } } }, env);
  const repo = created.body.id as string;
  const { token } = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read', 'write', 'land'] } }, env)).body;
  const objects: Obj[] = [];
  let tip = '';
  for (let i = 0; i < 9; i++) {
    const lines = Array.from({ length: 12_000 }, (_, n) => `line ${n} of file ${i}: ${(n * 7919 + i) % 100003}\n`);
    const blob = await object('blob', text.encode(lines.join('')));
    const root = await tree([['100644', 'f', blob.id]]);
    const who = `${author.name} <${author.email}> ${1700000000 + i} +0000`;
    const commit = await object('commit', text.encode(`tree ${root.id}\n${tip ? `parent ${tip}\n` : ''}author ${who}\ncommitter ${who}\n\nc${i}\n`));
    objects.push(commit, root, blob);
    tip = commit.id;
  }
  const head = text.encode(`${pkt(`${'0'.repeat(40)} ${tip} refs/heads/main\0report-status\n`)}0000`);
  expect(new TextDecoder().decode(await git(repo, token, 'git-receive-pack', join([head, await pack(objects)]), env))).toContain('ok refs/heads/main');
  await drainObjects(env);
  const fork = (await api(`/repos/${repo}/fork`, { cookie }, { body: { name: 'mine' } }, env)).body.id as string;
  const forkToken = (await api(`/repos/${fork}/tokens`, { cookie }, { body: { name: 'git', scopes: ['read'] } }, env)).body.token as string;

  const shards = env.COMMIT_SHARDS as DurableObjectNamespace;
  let calls = 0;
  const busy = {
    ...env,
    COMMIT_SHARDS: {
      idFromName: (name: string) => shards.idFromName(name),
      get: (id: DurableObjectId) => ({
        fetch: async (url: string, init: RequestInit) => {
          if (++calls === 2) throw Object.assign(new Error('Durable Object is overloaded. Too many requests queued.'), { overloaded: true });
          return shards.get(id).fetch(url, init);
        },
      }),
    },
  } as unknown as Env;
  cold();
  expect(count(await fetchV2(busy, fork, forkToken, [`want ${tip}`, 'done']))).toBe(objects.length);
  expect(calls).toBe(0);
});

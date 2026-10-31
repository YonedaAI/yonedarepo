// A fork's clone reads what it inherits from its parent's bundles, in bulk, as the parent's own
// clone does, not object by object through every tier of both repositories: about 16 authority
// and commit-shard calls an object (dev's first clone of a fork of pallets/click ended in HTTP
// 503 on that path, 2026-10-31). A shard that cannot answer holds nothing a fork inherits, so
// it does not fail the clone.
import { expect, it, vi } from 'vitest';
import { isolateLocations } from '../../cloudflare/worker/repo-bundles';
import { isolateTrees } from '../../cloudflare/worker/repo-tree-memo';
import type { Env } from '../../cloudflare/worker/types';
import { api, countingOps, drainObjects, fakeArtifacts, scoped, usePlatformFixture } from './repo-fixture';
import { count, fetchV2, on, pushedRepo } from './repo-pack-fixture';

usePlatformFixture();

// Artifacts as on dev (a store with `cloneAccess`, which a fork of it is too); packs always built.
const artifacts = { ...fakeArtifacts, get: async (name: string) => ({ ...(await fakeArtifacts.get(name)), fork: async () => ({}) }) };
const env = { ...on, ARTIFACTS: artifacts, PACK_CACHE: 'off' } as unknown as Env;

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

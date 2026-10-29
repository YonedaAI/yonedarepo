// Reads of objects still staged in commit shards (not yet drained to R2) ask the 64 shards
// only as a last resort, and then once for all of a read's misses: a projection names each
// object's commit, so it reads that commit's shard; a pack read asks every shard which ids
// it holds once per thousand ids (not for content once per 64) and reads the holders;
// concurrent single reads of one request share one ask. Counts are of commit-shard
// commands in local workerd.
import { expect, it } from 'vitest';
import { caller, RepoContext } from '../../cloudflare/worker/repo-ops';
import { api, author, bindings, countingOps, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

/** A repository with two undrained shard commits of `files` files each, and their files. */
async function staged(name: string, files: number) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  const id = created.body.id as string;
  const commits: { commit: string; files: { id: string; kind: string }[] }[] = [];
  for (const dir of ['x', 'y']) {
    const changes = Array.from({ length: files }, (_, k) => file(`${dir}/${k}.txt`, `${dir} file ${k}\n`));
    const made = await api(`/repos/${id}/commits`, owner, { body: { ref: 'main', changes, message: dir, author } });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const tree = await api(`/repos/${id}/tree?commit=${made.body.commit}&path=${dir}`, owner);
    commits.push({ commit: made.body.commit, files: tree.body.entries.map((e: { id: string }) => ({ id: e.id, kind: 'blob' })) });
  }
  // Both cache tiers miss, as on a cold colo before the drain.
  for (const { files: listed } of commits)
    for (const f of listed) {
      await bindings.OBJECTS.delete(`platform/v1/${id}/objects/${f.id}`);
      await caches.default.delete(new Request(`https://objects.yoneda.internal/${id}/${f.id}`));
    }
  return { id, commits };
}

const context = (env: typeof scoped, id: string) => new RepoContext(env, id, caller(env, id, { _system: 'projection' }));

it('reads staged objects from their commits shards, or every shard once per read', async () => {
  const { id, commits } = await staged('shardreads', 150);
  const wanted = commits.flatMap((c) => c.files);
  const { env, take } = countingOps(scoped);

  // A pack read that knows nothing of their commits: every shard once, not once per 64.
  const objects = await context(env, id).objects();
  take();
  expect(await objects.raw(wanted)).toHaveLength(300);
  // 64 asks of which ids each shard holds, then 64 ids per read of the shards holding them.
  const asked = take();
  expect(asked.store_staged_held ?? 0).toBeLessThanOrEqual(64);
  expect(asked.store_staged_objects).toBeLessThanOrEqual(2 * Math.ceil(150 / 64));

  // A projection names each object's commit: only those commits' shards are asked.
  const owners = new Map(commits.flatMap((c) => c.files.map((f) => [f.id, c.commit] as const)));
  const projecting = await context(env, id).objects();
  take();
  expect(await projecting.raw(wanted, owners)).toHaveLength(300);
  const read = take();
  expect(read.store_staged_held ?? 0).toBe(0);
  expect(read.store_staged_objects).toBeLessThanOrEqual(2 * Math.ceil(150 / 64));
});

it("shares one ask of every shard among a request's concurrent reads", async () => {
  const { id, commits } = await staged('shardsingles', 12);
  const { env, take } = countingOps(scoped);
  const objects = await context(env, id).objects();
  take();
  const read = await Promise.all(commits.flatMap((c) => c.files).map((f) => objects.blob(f.id)));
  expect(read).toHaveLength(24);
  expect(new TextDecoder().decode(read[0])).toBe('x file 0\n');
  const asked = take();
  expect(asked.store_staged_held).toBeLessThanOrEqual(2 * 64);
  expect(asked.store_staged_objects).toBeLessThanOrEqual(4);
});

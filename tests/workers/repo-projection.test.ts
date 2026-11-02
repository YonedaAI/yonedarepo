// Staged objects drain into R2, the store of record: each commit once its every write is
// confirmed, the authority's staged copies dropped only then. Repeating a job changes nothing,
// and an outbox too long for one invocation goes on in a fresh job.
import { expect, it } from 'vitest';
import { projectObjects } from '../../cloudflare/worker/repo-projection';
import { api, author, bindings, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const policy = { required_checks: [], approvals: 0 };
const stored = (repo: string, id: string) => bindings.OBJECTS.head(`platform/v1/${repo}/git/${id}`);

async function repository(name: string) {
  const owner = { cookie: await signup(name) };
  const created = await api('/repos', owner, { body: { name, policy, files: [file('a.txt', '0\n')], author } });
  const path = `/repos/${created.body.id}`;
  const blob = (await api(`${path}/tree?path=`, owner)).body.entries[0].id as string;
  return { owner, id: created.body.id as string, path, commit: created.body.commit as string, tree: created.body.tree as string, blob };
}

it('writes staged objects to R2 and drops the staged copies, once', async () => {
  const { owner, id, path, commit, tree, blob } = await repository('drained');
  const pending = queued.filter((m) => m.kind === 'platform_objects');
  expect(pending.length).toBeGreaterThan(0);
  expect((await api(path, owner)).body.objects.pending).toBe(1);
  expect(await stored(id, commit)).toBeNull();

  const job = pending[0].job_id;
  expect(await projectObjects(scoped, id, job)).toEqual({ projected: 1, more: false });
  for (const object of [commit, tree, blob]) expect(await stored(id, object), object).not.toBeNull();
  expect((await api(path, owner)).body.objects.pending).toBe(0);
  // Delivered again, there is nothing left to do.
  expect(await projectObjects(scoped, id, job)).toEqual({ projected: 0, more: false });
});

it('settles a commit only when every one of its writes is confirmed', async () => {
  const { owner, id, path, commit, blob } = await repository('partly');
  const job = queued.find((m) => m.kind === 'platform_objects').job_id;
  const refusing = new Proxy(bindings.OBJECTS, {
    get(target, prop) {
      if (prop === 'put')
        return (key: string, ...rest: unknown[]) =>
          key.endsWith(`/git/${blob}`) ? Promise.reject(new Error('R2 unavailable')) : (target.put as any)(key, ...rest);
      const value = (target as any)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(projectObjects({ ...scoped, OBJECTS: refusing }, id, job)).rejects.toThrow('1 staged commits are not in R2 yet');
  expect((await api(path, owner)).body.objects).toMatchObject({ pending: 1, oldest: { commit_id: commit } });
  expect((await api(`${path}/blob?path=a.txt`, owner)).body.content).toBe('0\n');

  expect(await projectObjects(scoped, id, job)).toEqual({ projected: 1, more: false });
  expect(await stored(id, blob)).not.toBeNull();
});

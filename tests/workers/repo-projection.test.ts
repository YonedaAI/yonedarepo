// Branch refs are projected into the object store with expected-old leases; refusals
// become visible drift instead of forced updates.
import { expect, it } from 'vitest';
import { projectObjects, projectRefs } from '../../cloudflare/worker/repo-projection';
import { parseStore } from '../../cloudflare/worker/repo-objects';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, file, pushes, queued, refusals, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const zero = '0'.repeat(40);

async function landNext(repo: string, owner: { cookie: string }, text: string, target: Env = scoped) {
  const made = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes: [file('a.txt', text)], message: text, author } }, target);
  expect((await api(`${repo}/land`, owner, { body: { ref: 'main', commit: made.body.commit } }, target)).body.landed).toBe(true);
  return made.body.commit as string;
}
const drain = async (target: Env) => {
  for (const message of queued.splice(0)) {
    if (message.kind === 'platform_objects') await projectObjects(target, message.repo_id);
    if (message.kind === 'platform_project') await projectRefs(target, message);
  }
};

it('projects landed branches to Artifacts with leases and records drift', async () => {
  const owner = { cookie: await signup('projector') };
  const created = await api('/repos', owner, { body: { name: 'p', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } });
  const repo = `/repos/${created.body.id}`;
  await drain(scoped);
  const branchPushes = () => pushes.filter((p) => p.endsWith(' refs/heads/main'));
  expect(branchPushes()).toEqual([`${zero} ${created.body.commit} refs/heads/main`]);
  expect((await api(repo, owner)).body.projections[0]).toMatchObject({ status: 'ok', projected_commit: created.body.commit });

  const second = await landNext(repo, owner, '1\n');
  await drain(scoped);
  expect(branchPushes().at(-1)).toBe(`${created.body.commit} ${second} refs/heads/main`);

  refusals.add('refs/heads/main');
  await landNext(repo, owner, '2\n');
  await drain(scoped);
  const drifted = (await api(repo, owner)).body.projections[0];
  expect(drifted).toMatchObject({ status: 'drift', projected_commit: second });
  expect(drifted.detail).toContain('stale info');
  // Drifted refs are not pushed again until resolved.
  const count = pushes.length;
  await landNext(repo, owner, '3\n');
  await drain(scoped);
  expect(pushes.filter((p) => p.endsWith(' refs/heads/main')).length).toBe(branchPushes().length);
  expect(pushes.length).toBe(count + 1); // only the new commit's hidden ref
});

it('keeps R2-store refs in step and detects tampering', async () => {
  const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
  const owner = { cookie: await signup('localprojector') };
  const created = await api('/repos', owner, { body: { name: 'l', policy: { required_checks: [], approvals: 0 }, files: [file('a.txt', '0\n')], author } }, local);
  const repo = `/repos/${created.body.id}`;
  const store = parseStore(local, `r2:yr-${created.body.id}`) as unknown as { readRef(r: string): Promise<string | null> };
  await drain(local);
  expect(await store.readRef('refs/heads/main')).toBe(created.body.commit);
  const next = await landNext(repo, owner, '1\n', local);
  await drain(local);
  expect(await store.readRef('refs/heads/main')).toBe(next);

  await bindings.OBJECTS.put(`store/v1/yr-${created.body.id}/refs/heads/main`, created.body.commit);
  await landNext(repo, owner, '2\n', local);
  await drain(local);
  expect((await api(repo, owner, {}, local)).body.projections[0].status).toBe('drift');
  expect(await store.readRef('refs/heads/main')).toBe(created.body.commit);
});

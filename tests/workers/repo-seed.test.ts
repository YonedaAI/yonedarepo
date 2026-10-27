// Warm-start seeds (Scion S13): a check run on a commit near the branch head starts from
// the head's seed and fetches only the blobs that differ, with the same files shipped.
import { expect, it } from 'vitest';
import { deriveAfterLanding } from '../../cloudflare/worker/repo-derived';
import { executeCheckRun } from '../../cloudflare/worker/repo-checks';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, executed, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();
const local = { ...scoped, PLATFORM_OBJECT_STORE: 'r2' } as unknown as Env;
const policy = { required_checks: ['unit'], approvals: 0, runners: { unit: { command: ['sh', '-c', 'test'], timeout_seconds: 30 } } };

async function checked(owner: { cookie: string }, repo: string, changes: unknown[]) {
  const made = await api(`${repo}/commits`, owner, { body: { ref: 'main', changes, message: 'c', author } }, local);
  const run = queued.filter((m) => m.kind === 'platform_check').at(-1);
  expect(await executeCheckRun(local, run)).toBeUndefined();
  const detail = await api(`${repo}/commits/${made.body.commit}`, owner, {}, local);
  return { job: executed.at(-1).job, evidence: JSON.parse(detail.body.checks[0].evidence) };
}

it('ships a nearby commit from the seed plus the changed blobs only', async () => {
  const owner = { cookie: await signup('seeder') };
  const files = [file('a.txt', 'good\n'), ...Array.from({ length: 200 }, (_, i) => file(`src/${i}.txt`, `${i}\n`))];
  const created = await api('/repos', owner, { body: { name: 'seeded', policy, files, author } }, local);
  const repo = `/repos/${created.body.id}`;

  const cold = await checked(owner, repo, [file('src/1.txt', 'one\n')]);
  expect(cold.evidence.seed).toBeUndefined();
  expect(cold.job.files).toHaveLength(201);

  await deriveAfterLanding(local, { v: 1, kind: 'platform_derive', repo_id: created.body.id, job_id: 'main' } as any);
  const warm = await checked(owner, repo, [file('src/2.txt', 'two\n'), { path: 'src/3.txt', delete: true }]);
  expect(warm.evidence.seed).toEqual({ commit: created.body.commit, fetched: 1 });
  const shipped = Object.fromEntries(warm.job.files.map((f: any) => [f.path, atob(f.data_b64)]));
  expect(Object.keys(shipped)).toHaveLength(200);
  expect(shipped['src/2.txt']).toBe('two\n');
  expect(shipped['src/3.txt']).toBeUndefined();
  expect(shipped['src/4.txt']).toBe('4\n');
});

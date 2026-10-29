// Warm-start seeds (Scion S13): a check run on a commit near the branch head starts from
// the head's seed and fetches only the blobs that differ, with the same files shipped.
import { expect, it } from 'vitest';
import { deriveAfterLanding } from '../../cloudflare/worker/repo-derived';
import { executeCheckRun } from '../../cloudflare/worker/repo-checks';
import { fileSetDigest } from '../../cloudflare/worker/repo-seed';
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
  const evidence = JSON.parse(detail.body.checks[0].evidence);
  // The verdict names exactly what ran: this commit, its tree and the shipped file set.
  expect([evidence.commit, evidence.tree]).toEqual([made.body.commit, detail.body.tree]);
  return { job: executed.at(-1).job, evidence };
}

/** The shipped files as path → text (the job carries raw bytes). */
const texts = (files: { path: string; data: Uint8Array }[]) =>
  Object.fromEntries(files.map((f) => [f.path, new TextDecoder().decode(f.data)]));

/** The digest of `files` (path → text) as Git sees them, recomputed independently. */
async function expectedDigest(files: Record<string, string>) {
  const listed = await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      const body = new TextEncoder().encode(text);
      const header = new TextEncoder().encode(`blob ${body.length}\0`);
      const sha1 = await crypto.subtle.digest('SHA-1', new Uint8Array([...header, ...body]));
      const id = [...new Uint8Array(sha1)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return { path, type: 'blob', id };
    }),
  );
  return fileSetDigest(listed);
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
  const shipped = texts(warm.job.files);
  expect(Object.keys(shipped)).toHaveLength(200);
  expect(shipped['src/2.txt']).toBe('two\n');
  expect(shipped['src/3.txt']).toBeUndefined();
  expect(shipped['src/4.txt']).toBe('4\n');
  // The seeded file set is the commit's tree exactly, and its digest says so.
  expect(warm.evidence.files_sha256).toBe(await expectedDigest(shipped));
  expect(cold.evidence.files_sha256).not.toBe(warm.evidence.files_sha256);
});

it('ships only a scoped runner\'s paths, cold and seeded, bound to the scoped file set', async () => {
  const owner = { cookie: await signup('scoper') };
  const scopedPolicy = { ...policy, runners: { unit: { ...policy.runners.unit, paths: ['src', 'docs/api.md'] } } };
  const files = [
    file('a.txt', 'good\n'),
    file('docs/api.md', 'api\n'),
    file('docs/other.md', 'other\n'),
    file('src/a/b.txt', 'b\n'),
    file('srcx/c.txt', 'c\n'),
  ];
  const created = await api('/repos', owner, { body: { name: 'scoped', policy: scopedPolicy, files, author } }, local);
  const repo = `/repos/${created.body.id}`;

  const cold = await checked(owner, repo, [file('src/new.txt', 'new\n')]);
  expect(Object.keys(texts(cold.job.files)).sort()).toEqual(['docs/api.md', 'src/a/b.txt', 'src/new.txt']);
  expect(cold.evidence.scope).toEqual(['src', 'docs/api.md']);
  expect(cold.evidence.files_sha256).toBe(await expectedDigest(texts(cold.job.files)));

  await deriveAfterLanding(local, { v: 1, kind: 'platform_derive', repo_id: created.body.id, job_id: 'main' } as any);
  // Each change is checked against the seeded head; out-of-scope changes are not fetched.
  const warm = await checked(owner, repo, [file('srcx/c.txt', 'c2\n'), file('src/a/b.txt', 'b2\n')]);
  expect(warm.evidence.seed).toEqual({ commit: expect.any(String), fetched: 1 });
  expect(texts(warm.job.files)).toEqual({ 'docs/api.md': 'api\n', 'src/a/b.txt': 'b2\n' });
  expect(warm.evidence.files_sha256).toBe(await expectedDigest(texts(warm.job.files)));
});

it('ships the whole tree and names no scope for a runner without paths', async () => {
  const owner = { cookie: await signup('unscoped') };
  const created = await api('/repos', owner, { body: { name: 'whole', policy, files: [file('a.txt', 'good\n')], author } }, local);
  const run = await checked(owner, `/repos/${created.body.id}`, [file('b/c.txt', 'c\n')]);
  expect(Object.keys(texts(run.job.files)).sort()).toEqual(['a.txt', 'b/c.txt']);
  expect(run.evidence.scope).toBeUndefined();
});

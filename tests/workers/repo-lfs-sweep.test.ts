// The LFS sweep end to end in workerd: bytes of a reservation that lapsed and of an upload
// that failed verification are deleted from R2 by the platform's sweep job, never the
// bytes of a stored object; the first reservation schedules the job, a redelivered job
// changes nothing, and a sweep of a repository that is gone ends quietly. A lapse is made
// by backdating the reservation in the authority's SQLite (a day cannot pass in a test).
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { platformJob } from '../../cloudflare/worker/platform-entrypoint';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { lfsKey } from '../../cloudflare/worker/repo-lfs';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, bindings, delayed, file, queued, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

// The S3 key pair is a test fixture (presigned URLs are never fetched here).
const lfsEnv = {
  ...scoped,
  LFS_S3_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
  LFS_S3_BUCKET: 'yoneda-local-test',
  LFS_S3_ACCESS_KEY_ID: 'test-fixture-key-id',
  LFS_S3_SECRET_ACCESS_KEY: 'test-fixture-secret',
} as Env;
const MEDIA = 'application/vnd.git-lfs+json';

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const blob = async (n: number) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return { bytes, oid: hex(await crypto.subtle.digest('SHA-256', bytes)) };
};

async function lfs(repo: string, path: string, token: string, body: unknown) {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/info/lfs/${path}`, {
      method: 'POST',
      headers: { accept: MEDIA, 'content-type': MEDIA, authorization: `Basic ${btoa(`git:${token}`)}` },
      body: JSON.stringify(body),
    }),
    lfsEnv,
  );
  return { status: response.status, body: await response.json<any>() };
}

async function setup(name: string) {
  const cookie = await signup(name);
  const repo = (await api('/repos', { cookie }, { body: { name, files: [file('a.md', 'a\n')], author } })).body.id as string;
  const writer = (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: 'w', scopes: ['read', 'write'] } })).body.token as string;
  return { repo, writer };
}

const sweeps = () => [...queued, ...delayed].filter((m) => m.kind === 'platform_lfs_sweep');
async function runSweep(repo: string) {
  let acked = 0;
  const message = { body: { v: 1, kind: 'platform_lfs_sweep', repo_id: repo, job_id: 'sweep' }, attempts: 1, ack: () => void acked++, retry: () => {} };
  await platformJob(lfsEnv, message as unknown as Message<any>);
  return acked;
}

it('sweeps a lapsed reservation’s bytes and never a stored object’s', async () => {
  const { repo, writer } = await setup('lfs_sweep_lapse');
  const [kept, lapsing] = [await blob(1024), await blob(2048)];
  const objects = [kept, lapsing].map(({ bytes, oid }) => ({ oid, size: bytes.length }));
  expect((await lfs(repo, 'objects/batch', writer, { operation: 'upload', objects })).status).toBe(200);
  // The first reservation schedules the sweep for when it lapses.
  expect(sweeps()).toHaveLength(1);
  await lfsEnv.OBJECTS.put(lfsKey(repo, kept.oid), kept.bytes);
  expect((await lfs(repo, 'verify', writer, { oid: kept.oid, size: kept.bytes.length })).status).toBe(200);
  // Uploaded but never verified, and a day old.
  await lfsEnv.OBJECTS.put(lfsKey(repo, lapsing.oid), lapsing.bytes);
  await runInDurableObject(bindings.SOURCE_REPOS.get(bindings.SOURCE_REPOS.idFromName(repo)), async (_i, state) => {
    state.storage.sql.exec("UPDATE lfs_objects SET reserved_at=0 WHERE state='pending'");
  });

  expect(await runSweep(repo)).toBe(1);
  expect(await lfsEnv.OBJECTS.head(lfsKey(repo, lapsing.oid))).toBeNull();
  expect(await lfsEnv.OBJECTS.head(lfsKey(repo, kept.oid))).not.toBeNull();
  // Nothing waits: no further run is scheduled, and a redelivered job changes nothing.
  expect(sweeps()).toHaveLength(1);
  expect(await runSweep(repo)).toBe(1);
  expect(await lfsEnv.OBJECTS.head(lfsKey(repo, kept.oid))).not.toBeNull();
  const down = await lfs(repo, 'objects/batch', writer, { operation: 'download', objects: [objects[0]] });
  expect(down.body.objects[0].actions.download.href).toContain(kept.oid);
});

it('sweeps a failed upload’s bytes before verify answers and schedules a backstop', async () => {
  const { repo, writer } = await setup('lfs_sweep_failed');
  const { bytes, oid } = await blob(512);
  await lfs(repo, 'objects/batch', writer, { operation: 'upload', objects: [{ oid, size: bytes.length }] });
  await lfsEnv.OBJECTS.put(lfsKey(repo, oid), bytes.slice(1));
  expect((await lfs(repo, 'verify', writer, { oid, size: bytes.length })).status).toBe(422);
  expect(await lfsEnv.OBJECTS.head(lfsKey(repo, oid))).toBeNull();
  // The reservation's own sweep, and the one the orphan armed for now.
  expect(sweeps().map((m) => m.repo_id)).toEqual([repo, repo]);
  // The right bytes upload and store afterwards.
  await lfs(repo, 'objects/batch', writer, { operation: 'upload', objects: [{ oid, size: bytes.length }] });
  await lfsEnv.OBJECTS.put(lfsKey(repo, oid), bytes);
  expect((await lfs(repo, 'verify', writer, { oid, size: bytes.length })).status).toBe(200);
});

it('ends the sweep of a repository that is gone quietly', async () => {
  expect(await runSweep('r00000000000000000000')).toBe(1);
});

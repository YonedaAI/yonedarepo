// Git LFS on a fork (workerd): an object the fork does not store is served from its parent's
// LFS objects (a presigned GET of the parent's key) only to a caller with current read on the
// parent, asked of the parent's authority with the caller's own credentials. A fork's
// repository token, or an account removed from the parent, gets a 404 and no parent URL.
// The fork's quota counts only its own uploads. The S3 key pair is a test fixture.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { lfsKey } from '../../cloudflare/worker/repo-lfs';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, drainObjects, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const env = {
  ...scoped,
  PLATFORM_OBJECT_STORE: 'r2',
  ARTIFACTS: undefined,
  LFS_S3_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
  LFS_S3_BUCKET: 'yoneda-local-test',
  LFS_S3_ACCESS_KEY_ID: 'test-fixture-key-id',
  LFS_S3_SECRET_ACCESS_KEY: 'test-fixture-secret',
} as unknown as Env;
const MEDIA = 'application/vnd.git-lfs+json';
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function lfs(repo: string, path: string, token: string, body: unknown) {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/info/lfs/${path}`, {
      method: 'POST',
      headers: { 'content-type': MEDIA, authorization: `Basic ${btoa(`git:${token}`)}` },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: response.status, body: await response.json<any>() };
}

/** Stores `bytes` as an LFS object of `repo` the way a client's upload and verify do. */
async function upload(repo: string, token: string, bytes: Uint8Array) {
  const oid = hex(await crypto.subtle.digest('SHA-256', bytes));
  const objects = [{ oid, size: bytes.length }];
  expect((await lfs(repo, 'objects/batch', token, { operation: 'upload', objects })).status).toBe(200);
  await env.OBJECTS.put(lfsKey(repo, oid), bytes, { sha256: oid });
  expect((await lfs(repo, 'verify', token, { oid, size: bytes.length })).status).toBe(200);
  return oid;
}

const pat = async (cookie: string) =>
  (await api('/tokens', { cookie }, { body: { name: 'git', scopes: ['repo:read', 'repo:write'] } }, env)).body.token as string;

it("serves a fork's inherited LFS objects from the parent only to readers of the parent", async () => {
  const alice = { cookie: await signup('lfs_fork_alice') };
  const bob = { cookie: await signup('lfs_fork_bob') };
  const created = await api('/repos', alice, { body: { name: 'big-upstream', policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } }, env);
  const parent = created.body.id as string;
  await drainObjects(env);
  const alicePat = await pat(alice.cookie);
  const inherited = await upload(parent, alicePat, crypto.getRandomValues(new Uint8Array(1500)));
  expect((await api(`/repos/${parent}/members`, alice, { body: { account: 'lfs_fork_bob', role: 'read' } }, env)).status).toBe(200);
  const forked = await api(`/repos/${parent}/fork`, bob, { body: { name: 'big-fork' } }, env);
  expect(forked.status, JSON.stringify(forked.body)).toBe(200);
  const fork = forked.body.id as string;
  const bobPat = await pat(bob.cookie);
  const own = await upload(fork, bobPat, crypto.getRandomValues(new Uint8Array(700)));

  // Bob reads the parent: the inherited object downloads from the parent's key.
  const objects = [{ oid: inherited, size: 1500 }, { oid: own, size: 700 }];
  const down = await lfs(fork, 'objects/batch', bobPat, { operation: 'download', objects });
  expect(down.status, JSON.stringify(down.body)).toBe(200);
  const [fromParent, fromFork] = down.body.objects;
  expect(new URL(fromParent.actions.download.href).pathname).toBe(`/yoneda-local-test/${lfsKey(parent, inherited)}`);
  expect(new URL(fromFork.actions.download.href).pathname).toBe(`/yoneda-local-test/${lfsKey(fork, own)}`);

  // The fork's quota counts its own upload only.
  expect((await api(`/repos/${fork}/lfs`, bob, {}, env)).body).toMatchObject({ stored_bytes: 700, objects: 1 });

  // A fork repository token has no read on the parent: no parent URL.
  const forkToken = (await api(`/repos/${fork}/tokens`, bob, { body: { name: 'ci', scopes: ['read'] } }, env)).body.token as string;
  const scoped = await lfs(fork, 'objects/batch', forkToken, { operation: 'download', objects });
  expect(scoped.body.objects[0].error.code).toBe(404);
  expect(scoped.body.objects[0].error.message).toContain(`read on its parent repository ${parent}`);
  expect(scoped.body.objects[1].actions.download.href).toContain(lfsKey(fork, own));
  expect(JSON.stringify(scoped.body)).not.toContain(lfsKey(parent, inherited));

  // Removed from the parent: the next batch refuses the inherited object at once.
  expect((await api(`/repos/${parent}/members/lfs_fork_bob`, alice, { method: 'DELETE' }, env)).status).toBe(200);
  const removed = await lfs(fork, 'objects/batch', bobPat, { operation: 'download', objects });
  expect(removed.body.objects[0].error.code).toBe(404);
  expect(JSON.stringify(removed.body)).not.toContain(lfsKey(parent, inherited));
});

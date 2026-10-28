// Git LFS end to end in workerd, with the presigned transfers played by writing R2
// directly: the Batch API answers upload and download actions in the shapes `git lfs`
// expects (presigned R2 URLs that sign the sha256 checksum header, a verify action),
// refuses a read-only or path-restricted token's upload and a batch over the quota (507),
// and verify records only bytes whose size and sha256 match (anything else is deleted).
// The S3 key pair below is a test fixture; the presigner matches AWS's documented example.
import { expect, it } from 'vitest';
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import { lfsKey } from '../../cloudflare/worker/repo-lfs';
import { presign } from '../../cloudflare/worker/s3-presign';
import type { Env } from '../../cloudflare/worker/types';
import { api, author, file, scoped, signup, usePlatformFixture } from './repo-fixture';

usePlatformFixture();

const lfsEnv = {
  ...scoped,
  LFS_S3_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
  LFS_S3_BUCKET: 'yoneda-local-test',
  LFS_S3_ACCESS_KEY_ID: 'test-fixture-key-id',
  LFS_S3_SECRET_ACCESS_KEY: 'test-fixture-secret',
} as Env;
const MEDIA = 'application/vnd.git-lfs+json';

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes));

async function lfs(repo: string, path: string, token: string | null, body?: unknown, method = 'POST', target = lfsEnv) {
  const headers: Record<string, string> = { accept: MEDIA, 'content-type': MEDIA };
  if (token) headers.authorization = `Basic ${btoa(`git:${token}`)}`;
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/info/lfs/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    target,
  );
  return { status: response.status, headers: response.headers, body: await response.json<any>() };
}

async function setup(name: string) {
  const cookie = await signup(name);
  const created = await api('/repos', { cookie }, { body: { name, policy: { approvals: 0, required_checks: [] }, files: [file('a.md', 'a\n')], author } });
  const repo = created.body.id as string;
  const mint = async (scopes: string[], paths?: string[]) =>
    (await api(`/repos/${repo}/tokens`, { cookie }, { body: { name: `${scopes.join('-')}${paths ? '-dir' : ''}`, scopes, ...(paths && { paths }) } })).body.token as string;
  return { repo, cookie, writer: await mint(['read', 'write']), reader: await mint(['read']), mint };
}

it('presigns like AWS Signature Version 4 (the documented GET example)', async () => {
  const url = await presign(
    {
      endpoint: 'https://examplebucket.s3.amazonaws.com',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
    },
    'GET',
    'test.txt',
    86400,
    {},
    new Date('2013-05-24T00:00:00Z'),
  );
  expect(url).toBe(
    'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  );
});

it('hands out presigned uploads, verifies the stored bytes, then hands out downloads', async () => {
  const { repo, writer, reader } = await setup('lfs_round_trip');
  const bytes = crypto.getRandomValues(new Uint8Array(4096));
  const oid = await sha256(bytes);
  const objects = [{ oid, size: bytes.length }];

  // Nothing to download yet.
  const before = await lfs(repo, 'objects/batch', reader, { operation: 'download', transfers: ['basic'], objects });
  expect(before.status).toBe(200);
  expect(before.body.objects[0].error.code).toBe(404);

  const batch = await lfs(repo, 'objects/batch', writer, { operation: 'upload', transfers: ['basic'], objects, hash_algo: 'sha256' });
  expect(batch.status).toBe(200);
  expect(batch.headers.get('content-type')).toBe(MEDIA);
  expect(batch.body.transfer).toBe('basic');
  const [object] = batch.body.objects;
  expect(object).toMatchObject({ oid, size: bytes.length, authenticated: true });
  const upload = new URL(object.actions.upload.href);
  expect(upload.origin).toBe('https://test-account.r2.cloudflarestorage.com');
  expect(upload.pathname).toBe(`/yoneda-local-test/${lfsKey(repo, oid)}`);
  expect(upload.searchParams.get('X-Amz-SignedHeaders')).toBe('host;x-amz-checksum-sha256');
  expect(upload.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  // The checksum header is the oid's bytes in base64: R2 refuses other bytes.
  const checksum = object.actions.upload.header['x-amz-checksum-sha256'];
  expect(hex(Uint8Array.from(atob(checksum), (c) => c.charCodeAt(0)).buffer)).toBe(oid);
  expect(object.actions.verify.href).toBe(`https://yoneda/git/${repo}.git/info/lfs/verify`);
  expect(object.actions.upload.expires_in).toBeGreaterThan(0);

  // Verify before the bytes arrive: not uploaded.
  expect((await lfs(repo, 'verify', writer, { oid, size: bytes.length })).status).toBe(404);
  // The client's PUT, as R2 keeps it (with the checksum it was sent).
  await lfsEnv.OBJECTS.put(lfsKey(repo, oid), bytes, { sha256: oid });
  // A reader cannot verify (that records an upload).
  expect((await lfs(repo, 'verify', reader, { oid, size: bytes.length })).status).toBe(403);
  const verified = await lfs(repo, 'verify', writer, { oid, size: bytes.length });
  expect(verified.status).toBe(200);

  const usage = await api(`/repos/${repo}/lfs`, { token: reader });
  expect(usage.body).toMatchObject({ stored_bytes: bytes.length, pending_bytes: 0, objects: 1 });

  // Stored: an upload needs no action, a download gets a presigned GET.
  const again = await lfs(repo, 'objects/batch', writer, { operation: 'upload', objects });
  expect(again.body.objects[0]).toEqual({ oid, size: bytes.length });
  const download = await lfs(repo, 'objects/batch', reader, { operation: 'download', objects });
  const href = new URL(download.body.objects[0].actions.download.href);
  expect(href.pathname).toBe(`/yoneda-local-test/${lfsKey(repo, oid)}`);
  expect(href.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  expect(download.body.objects[0].authenticated).toBe(true);
});

it('verify rejects a wrong size or hash and deletes the bytes; hashes when R2 kept no checksum', async () => {
  const { repo, writer } = await setup('lfs_verify');
  const bytes = crypto.getRandomValues(new Uint8Array(2048));
  const oid = await sha256(bytes);
  const key = lfsKey(repo, oid);
  await lfs(repo, 'objects/batch', writer, { operation: 'upload', objects: [{ oid, size: bytes.length }] });

  // Bytes of another size.
  await lfsEnv.OBJECTS.put(key, bytes.slice(1));
  const short = await lfs(repo, 'verify', writer, { oid, size: bytes.length });
  expect(short.status).toBe(422);
  expect(short.body.message).toContain(`${bytes.length - 1} bytes were stored`);
  expect(await lfsEnv.OBJECTS.head(key)).toBeNull();

  // Same size, other bytes (no checksum recorded, so verify hashes them).
  const other = crypto.getRandomValues(new Uint8Array(bytes.length));
  await lfsEnv.OBJECTS.put(key, other);
  const wrong = await lfs(repo, 'verify', writer, { oid, size: bytes.length });
  expect(wrong.status).toBe(422);
  expect(wrong.body.message).toContain('do not hash to the oid');
  expect(await lfsEnv.OBJECTS.head(key)).toBeNull();

  // The right bytes without a recorded checksum: hashed and stored.
  await lfsEnv.OBJECTS.put(key, bytes);
  expect((await lfs(repo, 'verify', writer, { oid, size: bytes.length })).status).toBe(200);
  expect((await api(`/repos/${repo}/lfs`, { token: writer })).body.objects).toBe(1);
});

it('refuses uploads without write, from a path-restricted token, without credentials or over the quota', async () => {
  const { repo, cookie, writer, reader, mint } = await setup('lfs_refusals');
  const objects = [{ oid: 'a'.repeat(64), size: 11 }];

  const anonymous = await lfs(repo, 'objects/batch', null, { operation: 'upload', objects });
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get('lfs-authenticate')).toMatch(/^Basic /);

  const readOnly = await lfs(repo, 'objects/batch', reader, { operation: 'upload', objects });
  expect(readOnly.status).toBe(403);
  expect(readOnly.body.message).toContain('write');

  const dir = await mint(['read', 'write'], ['src/']);
  expect((await lfs(repo, 'objects/batch', dir, { operation: 'download', objects })).status).toBe(403);

  // Only the owner sets the quota.
  expect((await api(`/repos/${repo}/lfs`, { token: writer }, { method: 'PUT', body: { quota_bytes: 10 } })).status).toBe(403);
  const set = await api(`/repos/${repo}/lfs`, { cookie }, { method: 'PUT', body: { quota_bytes: 10 } });
  expect(set.body).toMatchObject({ quota_bytes: 10, used_bytes: 0 });
  const over = await lfs(repo, 'objects/batch', writer, { operation: 'upload', objects });
  expect(over.status).toBe(507);
  expect(over.body.message).toContain('LFS quota exceeded');

  // Other hash algorithms and transfer adapters are refused; a bad oid is a per-object 422.
  expect((await lfs(repo, 'objects/batch', writer, { operation: 'upload', objects, hash_algo: 'sha512' })).status).toBe(409);
  expect((await lfs(repo, 'objects/batch', writer, { operation: 'upload', objects, transfers: ['tus'] })).status).toBe(422);
  const bad = await lfs(repo, 'objects/batch', writer, { operation: 'download', objects: [{ oid: 'xyz', size: 1 }] });
  expect(bad.body.objects[0].error.code).toBe(422);

  // A deployment without the S3 key pair answers 501 (after authentication).
  const unconfigured = await lfs(repo, 'objects/batch', writer, { operation: 'download', objects }, 'POST', scoped);
  expect(unconfigured.status).toBe(501);
});

it('answers the locks API without locking anything', async () => {
  const { repo, writer, reader } = await setup('lfs_locks');
  expect(await lfs(repo, 'locks', reader, undefined, 'GET')).toMatchObject({ status: 200, body: { locks: [] } });
  expect(await lfs(repo, 'locks/verify', writer, {})).toMatchObject({ status: 200, body: { ours: [], theirs: [] } });
  // Verifying locks comes before a push: it needs write.
  expect((await lfs(repo, 'locks/verify', reader, {})).status).toBe(403);
  const lock = await lfs(repo, 'locks', writer, { path: 'big.bin' });
  expect(lock.status).toBe(501);
  expect(lock.body.message).toContain('locking is not supported');
  expect((await lfs(repo, 'locks/1/unlock', writer, {})).status).toBe(404);
});

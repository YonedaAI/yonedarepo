import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { cacheSourceBlob, sourceCacheKey } from '../../cloudflare/worker/source-cache';
import { preparedSourceView, sourceIndexBounded } from '../../cloudflare/worker/source-index';
import { openSource } from '../../cloudflare/worker/source-objects';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';
import { syntheticPlatform } from './platform-fixture';

afterEach(reset);

/** One indexed file of a synthetic platform revision, its body cached with a real R2 proof. */
async function cachedFixture() {
  const name = 'cache-proof-boundary';
  const base = { repository: `platform/${name}`, commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const bytes = new TextEncoder().encode('source fixture');
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', object))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const synthetic = {
    [Symbol.dispose]() {},
    readCommit: async (commit: string) => {
      if (commit !== base.commit) throw new Error('Unapproved commit');
      return { hash: base.commit, treeHash: base.tree };
    },
    readTree: async (tree: string) => {
      if (tree !== base.tree) throw new Error('Unapproved tree');
      return [{ name: 'app.js', hash, mode: '100644', type: 'blob' }];
    },
    readBlob: async (blob: string) => {
      if (blob !== hash) throw new Error('Unapproved blob');
      return new Blob([bytes]);
    },
  };
  const env = await syntheticPlatform(bindings, { [name]: synthetic }, 'source_owner');
  if ((await sourceIndexBounded(env, base)).state !== 'prepared')
    throw new Error('Fixture source is not ready');
  const file = (await preparedSourceView(env, base)).files[0];
  if (file.content.kind !== 'git') throw new Error('Expected indexed Git fixture');
  const repo = await openSource(env, base.repository);
  const key = await sourceCacheKey(base, file.content.blob);
  const proofObject = await env.OBJECTS.get(`${key}.proof`);
  if (!proofObject) throw new Error('Missing real R2 cache proof');
  const proof = await proofObject.json<Record<string, any>>();
  return { env, repo, base, file, key, proof, oid: file.content.blob };
}

for (const field of ['sha256', 'size', 'git_oid', 'etag', 'version', 'signature']) {
  it(`fails closed on an altered cache proof ${field}`, async () => {
    const f = await cachedFixture();
    if (field === 'sha256') f.proof.sha256 = 'f'.repeat(64);
    if (field === 'size') f.proof.size--;
    if (field === 'git_oid') f.proof.git_oid = 'd'.repeat(40);
    if (field === 'etag') f.proof.etag = 'replaced-etag';
    if (field === 'version') f.proof.version = 2;
    if (field === 'signature') f.proof.certificate = { version: 1, signature: '0'.repeat(64) };
    await f.env.OBJECTS.put(`${f.key}.proof`, JSON.stringify(f.proof));
    await expect(cacheSourceBlob(f.env, f.repo, f.base, f.oid)).rejects.toMatchObject({
      code: expect.stringMatching(/^SOURCE_/),
    });
  });
}

it('binds an intact cache proof to its exact opaque key rather than accepting cross-revision transplantation', async () => {
  const f = await cachedFixture();
  const foreign = { ...f.base, commit: 'e'.repeat(40) };
  const foreignKey = await sourceCacheKey(foreign, f.oid);
  const body = await f.env.OBJECTS.get(f.key);
  if (!body) throw new Error('Missing original verified body');
  const stored = await f.env.OBJECTS.put(foreignKey, body.body);
  expect(stored?.etag).toBe(f.proof.etag);
  await f.env.OBJECTS.put(`${foreignKey}.proof`, JSON.stringify(f.proof));
  await expect(cacheSourceBlob(f.env, f.repo, foreign, f.oid)).rejects.toMatchObject({
    code: expect.stringMatching(/^SOURCE_/),
  });
});

it('recovers a missing legacy certificate only by reading and hashing the actual Git body', async () => {
  const f = await cachedFixture();
  delete f.proof.certificate;
  await f.env.OBJECTS.put(`${f.key}.proof`, JSON.stringify(f.proof));
  let bodyReads = 0;
  const measured = {
    ...f.env,
    OBJECTS: new Proxy(f.env.OBJECTS, {
      get(target, key) {
        const member = Reflect.get(target, key, target);
        return typeof member === 'function'
          ? (...args: unknown[]) => {
              if (key === 'get' && args[0] === f.key) bodyReads++;
              return Reflect.apply(member, target, args);
            }
          : member;
      },
    }),
  };
  expect(await cacheSourceBlob(measured, f.repo, f.base, f.oid)).toMatchObject({
    size: f.file.size,
    git_oid: f.oid,
    sha256: f.proof.sha256,
  });
  expect(bodyReads).toBeGreaterThan(0);
});

it('rejects an intact cache certificate under a different signing key', async () => {
  const f = await cachedFixture();
  await expect(
    cacheSourceBlob({ ...f.env, VAULT_KEY: 'different-local-key' }, f.repo, f.base, f.oid),
  ).rejects.toMatchObject({ code: expect.stringMatching(/^SOURCE_/) });
});

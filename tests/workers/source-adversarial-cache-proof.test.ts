import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { cacheSourceBlob, sourceCacheKey } from '../../cloudflare/worker/source-cache';
import { boundSourceFixture } from '../../tools/source-benchmark/workerd-bound-source-fixture';

afterEach(reset);

async function cachedFixture() {
  const f = await boundSourceFixture('cache-proof-boundary');
  const base = f.context.binding.base;
  const file = f.context.view!.files[0];
  if (file.content.kind !== 'git') throw new Error('Expected indexed Git fixture');
  const key = await sourceCacheKey(base, file.content.blob);
  const object = await f.env.OBJECTS.get(`${key}.proof`);
  if (!object) throw new Error('Missing real R2 cache proof');
  const proof = await object.json<Record<string, any>>();
  const repo = await f.env.ARTIFACTS.get('cache-proof-boundary');
  return { ...f, base, file, key, proof, repo, oid: file.content.blob };
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

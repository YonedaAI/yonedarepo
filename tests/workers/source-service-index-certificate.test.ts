import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { hex, sourceFingerprint } from '../../cloudflare/worker/source-crypto';
import { ensureSourceIndex, preparedSourceView, sourceIndexBounded } from '../../cloudflare/worker/source-index';
import { indexPrefix, type IndexManifest } from '../../cloudflare/worker/source-index-journal';
import type { Env } from '../../cloudflare/worker/types';
import { bindings } from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);
async function fixture() {
  const revision = { repository: 'yoneda-test/certified-index', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const body = new Uint8Array([0, 255]);
  const prefix = new TextEncoder().encode(`blob ${body.length}\0`);
  const raw = new Uint8Array(prefix.length + body.length); raw.set(prefix); raw.set(body, prefix.length);
  const oid = hex(await crypto.subtle.digest('SHA-1', raw));
  const repo = { readCommit: async () => ({ hash: revision.commit, treeHash: revision.tree }),
    readTree: async () => [{ name: 'source.bin', hash: oid, mode: '100644', type: 'blob' }],
    readBlob: async () => new Blob([body]), [Symbol.dispose]() {} } as unknown as ArtifactsRepo;
  const env = { ...bindings, ARTIFACTS: { get: async () => repo } } as unknown as Env;
  const state = await sourceIndexBounded(env, revision);
  if (state.state !== 'prepared') throw new Error('Fixture index incomplete');
  const manifest = await (await bindings.OBJECTS.get(state.manifest))!.json<IndexManifest>();
  const journalKey = `${await indexPrefix(revision)}/journal`;
  const journal = await (await bindings.OBJECTS.get(journalKey))!.json<any>();
  const replace = async (value: IndexManifest) => {
    const key = `${await indexPrefix(revision)}/chunks/${await sourceFingerprint(value)}`;
    await bindings.OBJECTS.put(key, JSON.stringify(value));
    await bindings.OBJECTS.put(journalKey, JSON.stringify({ ...journal, manifest: key, files: value.files, bytes: value.bytes }));
  };
  return { env, revision, manifest, journal, replace };
}

it('refuses a rewritten immutable manifest even when its object identity and advisory counts are internally consistent', async () => {
  const f = await fixture();
  await f.replace({ ...f.manifest, files: f.manifest.files + 1 });
  await expect(preparedSourceView(f.env, f.revision)).rejects.toMatchObject({ code: 'SOURCE_INDEX_CERTIFICATE' });
});

it('binds the private index certificate to its signing authority and exact revision', async () => {
  const f = await fixture();
  await expect(preparedSourceView({ ...f.env, VAULT_KEY: 'unrelated-local-authority' }, f.revision)).rejects.toMatchObject({ code: 'SOURCE_INDEX_CERTIFICATE' });
  const view = await preparedSourceView(f.env, f.revision);
  expect(view.base).toEqual(f.revision);
  expect(view.files).toHaveLength(1);
  expect(Object.keys(view)).toEqual(['version', 'base', 'files']);
});

it('rebuilds an unsigned advisory journal through bounded source preparation instead of signing old metadata in place', async () => {
  const f = await fixture();
  const { certificate: _old, ...unsigned } = f.manifest;
  delete f.journal.certificate;
  await f.replace(unsigned);
  await expect(preparedSourceView(f.env, f.revision)).rejects.toMatchObject({ code: 'SOURCE_PREPARING' });
  expect((await ensureSourceIndex(f.env, f.revision)).state).toBe('preparing');
  expect((await sourceIndexBounded(f.env, f.revision)).state).toBe('prepared');
  expect((await preparedSourceView(f.env, f.revision)).files).toHaveLength(1);
});

it('never certifies an altered in-progress traversal journal as if it were linked to the frozen root', async () => {
  const f = await fixture();
  const key = `${await indexPrefix(f.revision)}/journal`;
  const journal = await (await bindings.OBJECTS.get(key))!.json<any>();
  // Simulate cache corruption, not a model capability: the complete root still contains source.bin.
  await bindings.OBJECTS.put(key, JSON.stringify({ ...journal, state: 'preparing', manifest: undefined,
    stack: [{ tree: f.revision.tree, path: 'phantom', next: 0 }], chunks: [], files: 0, bytes: 0 }));
  await expect(sourceIndexBounded(f.env, f.revision)).rejects.toMatchObject({ code: 'SOURCE_INDEX_CERTIFICATE' });
});

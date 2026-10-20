import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { cacheSourceBlob, sourceCacheKey } from '../../cloudflare/worker/source-cache';
import { preparedSourceView, sourceIndexBounded } from '../../cloudflare/worker/source-index';
import {
  immutableIndexObject,
  indexPrefix,
  type IndexJournal,
  type IndexManifest,
} from '../../cloudflare/worker/source-index-journal';
import { verifySourceView } from '../../cloudflare/worker/source-view-proof';
import { bindings, sha256 } from '../../tools/source-benchmark/workerd-source-fixture';
import { syntheticPlatform } from './platform-fixture';

afterEach(reset);

/** Only the external SDK is a fixture. Journal, immutable chunks and cache use real Workerd R2. */
async function partialIndex() {
  const base = {
    repository: 'platform/index-signing',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
  };
  const body = new TextEncoder().encode('index proof bytes');
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const object = new Uint8Array(header.length + body.length);
  object.set(header);
  object.set(body, header.length);
  const blob = [...new Uint8Array(await crypto.subtle.digest('SHA-1', object))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const paths = Array.from({ length: 20 }, (_, n) => `file-${String(n).padStart(2, '0')}.bin`);
  const repo = {
    [Symbol.dispose]() {},
    async readCommit(commit: string) {
      if (commit !== base.commit) throw new Error('Unapproved commit');
      return { hash: commit, treeHash: base.tree };
    },
    async readTree(tree: string) {
      if (tree !== base.tree) throw new Error('Unapproved tree');
      return paths.map((name) => ({ name, mode: '100644', type: 'blob', hash: blob }));
    },
    async readBlob(hash: string) {
      if (hash !== blob) throw new Error('Unapproved blob');
      return new Blob([body]);
    },
  } as unknown as ArtifactsRepo;
  const local = await syntheticPlatform(bindings, { 'index-signing': repo });
  expect(await sourceIndexBounded(local, base)).toMatchObject({ state: 'preparing', files: 16 });
  const prefix = await indexPrefix(base);
  const stored = await bindings.OBJECTS.get(`${prefix}/journal`);
  if (!stored) throw new Error('Missing real R2 index journal');
  const journal = await stored.json<IndexJournal>();
  return { local, base, prefix, journal, paths, repo, blob, body };
}

// A consumer may reject corrupted state or rebuild it. It must never certify a different view.
async function assertNoForgedPreparation(f: Awaited<ReturnType<typeof partialIndex>>) {
  let view;
  try {
    const state = await sourceIndexBounded(f.local, f.base);
    if (state.state !== 'prepared') return;
    view = await preparedSourceView(f.local, f.base);
  } catch (error) {
    expect((error as { code?: string }).code).toMatch(/^SOURCE_/);
    return;
  }
  expect(view.files.map((file) => file.path)).toEqual(f.paths);
  expect(view.files.every((file) => file.mode === '100644')).toBe(true);
}

it('does not certify a journal whose stack was truncated before complete SDK traversal', async () => {
  const f = await partialIndex();
  f.journal.stack = [];
  await bindings.OBJECTS.put(`${f.prefix}/journal`, JSON.stringify(f.journal));
  await assertNoForgedPreparation(f);
});

it('does not certify self-consistent replacement chunks grafted into resumable progress', async () => {
  const f = await partialIndex();
  const original = await bindings.OBJECTS.get(f.journal.chunks[0]);
  if (!original) throw new Error('Missing immutable chunk');
  const chunk = await original.json<{ files: { mode: string }[] }>();
  chunk.files[0].mode = '100755';
  f.journal.chunks[0] = await immutableIndexObject(f.local, f.prefix, chunk);
  await bindings.OBJECTS.put(`${f.prefix}/journal`, JSON.stringify(f.journal));
  await assertNoForgedPreparation(f);
});

it('does not certify a foreign traversal root injected into a journal with self-consistent empty counters', async () => {
  const f = await partialIndex();
  const foreignTree = 'c'.repeat(40);
  const readTree = f.repo.readTree.bind(f.repo);
  f.repo.readTree = async (tree: string) =>
    tree === foreignTree
      ? [{ name: 'foreign-only.bin', mode: '100644', type: 'blob', hash: f.blob }]
      : readTree(tree);
  f.journal.stack = [{ tree: foreignTree, path: '', next: 0 }];
  f.journal.chunks = [];
  f.journal.files = 0;
  f.journal.bytes = 0;
  await bindings.OBJECTS.put(`${f.prefix}/journal`, JSON.stringify(f.journal));
  await assertNoForgedPreparation(f);
});

it('does not resume a journal revision different from the exact requested immutable input', async () => {
  const f = await partialIndex();
  f.journal.revision = { ...f.base, commit: 'd'.repeat(40), tree: 'e'.repeat(40) };
  await bindings.OBJECTS.put(`${f.prefix}/journal`, JSON.stringify(f.journal));
  await assertNoForgedPreparation(f);
});

it('rebuilds unsigned legacy progress from the approved root without reusing injected arrays', async () => {
  const f = await partialIndex();
  delete f.journal.certificate;
  f.journal.stack = [];
  f.journal.chunks = [];
  f.journal.files = 0;
  f.journal.bytes = 0;
  await bindings.OBJECTS.put(`${f.prefix}/journal`, JSON.stringify(f.journal));
  expect(await sourceIndexBounded(f.local, f.base)).toMatchObject({
    state: 'preparing',
    files: 16,
  });
  expect(await sourceIndexBounded(f.local, f.base)).toMatchObject({ state: 'prepared', files: 20 });
  expect((await preparedSourceView(f.local, f.base)).files.map((file) => file.path)).toEqual(
    f.paths,
  );
});

it('rejects a validly authenticated journal transplanted from a different requested revision', async () => {
  const f = await partialIndex();
  const foreign = { ...f.base, commit: 'd'.repeat(40) };
  const foreignRepo = {
    ...f.repo,
    async readCommit(commit: string) {
      if (commit !== foreign.commit) throw new Error('Unapproved foreign fixture commit');
      return { hash: commit, treeHash: foreign.tree };
    },
  } as ArtifactsRepo;
  await sourceIndexBounded(await syntheticPlatform(bindings, { 'index-signing': foreignRepo }), foreign);
  const foreignObject = await bindings.OBJECTS.get(`${await indexPrefix(foreign)}/journal`);
  if (!foreignObject) throw new Error('Missing authenticated foreign journal');
  await bindings.OBJECTS.put(`${f.prefix}/journal`, await foreignObject.text());
  await expect(sourceIndexBounded(f.local, f.base)).rejects.toMatchObject({
    code: 'SOURCE_INDEX_CERTIFICATE',
  });
});

it('full membership verification currently rejects omitted files rather than treating cache digests as authority', async () => {
  const f = await partialIndex();
  f.journal.stack = [];
  await bindings.OBJECTS.put(`${f.prefix}/journal`, JSON.stringify(f.journal));
  try {
    const state = await sourceIndexBounded(f.local, f.base);
    if (state.state !== 'prepared') return;
    const view = await preparedSourceView(f.local, f.base);
    await expect(verifySourceView(f.local, view)).rejects.toMatchObject({ code: 'SOURCE_INDEX' });
  } catch (error) {
    expect((error as { code?: string }).code).toMatch(/^SOURCE_/);
  }
});

async function completedIndex() {
  const f = await partialIndex();
  expect(await sourceIndexBounded(f.local, f.base)).toMatchObject({ state: 'prepared', files: 20 });
  const journalObject = await bindings.OBJECTS.get(`${f.prefix}/journal`);
  if (!journalObject) throw new Error('Missing completed journal');
  f.journal = await journalObject.json<IndexJournal>();
  const manifestObject = await bindings.OBJECTS.get(f.journal.manifest!);
  if (!manifestObject) throw new Error('Missing completed manifest');
  const manifest = await manifestObject.json<IndexManifest>();
  expect((await preparedSourceView(f.local, f.base)).files).toHaveLength(20);
  return { ...f, manifest };
}

for (const field of ['repository', 'commit', 'tree', 'files', 'bytes', 'view_digest', 'chunks']) {
  it(`rejects a rehashed manifest with altered ${field} rather than trusting immutable key spelling`, async () => {
    const f = await completedIndex();
    const altered = structuredClone(f.manifest);
    if (field === 'repository') altered.revision.repository = 'platform/foreign';
    if (field === 'commit') altered.revision.commit = 'c'.repeat(40);
    if (field === 'tree') altered.revision.tree = 'd'.repeat(40);
    if (field === 'files') altered.files--;
    if (field === 'bytes') altered.bytes--;
    if (field === 'view_digest') altered.view_digest = '0'.repeat(64);
    if (field === 'chunks') altered.chunks.reverse();
    f.journal.manifest = await immutableIndexObject(f.local, f.prefix, altered);
    f.journal.revision = altered.revision;
    f.journal.files = altered.files;
    f.journal.bytes = altered.bytes;
    await bindings.OBJECTS.put(`${f.prefix}/journal`, JSON.stringify(f.journal));
    await expect(preparedSourceView(f.local, f.base)).rejects.toMatchObject({
      code: expect.stringMatching(/^SOURCE_/),
    });
  });
}

it('rejects unsigned completed metadata and cannot downgrade to a cache-only trust flag', async () => {
  const f = await completedIndex();
  delete f.manifest.certificate;
  f.journal.manifest = await immutableIndexObject(f.local, f.prefix, f.manifest);
  await bindings.OBJECTS.put(`${f.prefix}/journal`, JSON.stringify(f.journal));
  await expect(preparedSourceView(f.local, f.base)).rejects.toMatchObject({
    code: expect.stringMatching(/^SOURCE_/),
  });
});

it('rejects an otherwise intact certificate under a different private signing key', async () => {
  const f = await completedIndex();
  await expect(
    preparedSourceView({ ...f.local, VAULT_KEY: 'different-local-fixture-key' }, f.base),
  ).rejects.toMatchObject({ code: expect.stringMatching(/^SOURCE_/) });
});

it('does not treat a replaced body plus self-consistent unsigned cache proof as verified Git bytes', async () => {
  const f = await partialIndex();
  const key = await sourceCacheKey(f.base, f.blob);
  const changed = new Uint8Array(f.body.length).fill(65);
  const stored = await bindings.OBJECTS.put(key, changed);
  if (!stored) throw new Error('Missing replacement cache body');
  await bindings.OBJECTS.put(
    `${key}.proof`,
    JSON.stringify({
      version: 1,
      size: changed.length,
      sha256: await sha256(changed),
      git_oid: f.blob,
      etag: stored.etag,
    }),
  );
  await expect(cacheSourceBlob(f.local, f.repo, f.base, f.blob)).rejects.toMatchObject({
    code: expect.stringMatching(/^SOURCE_/),
  });
});

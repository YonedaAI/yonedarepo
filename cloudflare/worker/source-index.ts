import { cacheSourceBlob } from './source-cache';
import {
  SOURCE_LIMITS,
  type SourceFile,
  type SourceRevision,
  type SourceView,
  sourceError,
} from './source-contract';
import { sourceFingerprint } from './source-crypto';
import {
  certifySourceIndex,
  certifySourceIndexJournal,
  verifySourceIndexCertificate,
} from './source-index-certificate';
import {
  type IndexJournal,
  type IndexManifest,
  immutableIndexObject,
  indexFiles,
  indexPrefix,
  readIndexJournal,
} from './source-index-journal';
import { compareSourcePaths, sourceEntry, sourcePath, sourceRepository } from './source-path';
import type { Env } from './types';

export type SourceIndexResult =
  | { state: 'preparing'; cursor: number; files: number; bytes: number }
  | { state: 'prepared'; manifest: string; files: number; bytes: number; view_digest: string }
  | { state: 'failed'; error_code: string };

async function result(env: Env, prefix: string, journal: IndexJournal): Promise<SourceIndexResult> {
  if (journal.state === 'failed')
    return { state: 'failed', error_code: journal.error_code ?? 'SOURCE_INDEX' };
  if (journal.state !== 'prepared')
    return { state: 'preparing', cursor: journal.step, files: journal.files, bytes: journal.bytes };
  if (!journal.manifest?.startsWith(`${prefix}/chunks/`))
    throw sourceError('SOURCE_INDEX', 'Invalid final index reference');
  const object = await env.OBJECTS.get(journal.manifest);
  const manifest = object && object.size <= 512 * 1024 ? await object.json<IndexManifest>() : null;
  if (
    !manifest ||
    (await sourceFingerprint(manifest)) !== journal.manifest.slice(-64) ||
    manifest.files !== journal.files ||
    manifest.bytes !== journal.bytes ||
    (await sourceFingerprint(manifest.revision)) !== (await sourceFingerprint(journal.revision))
  )
    throw sourceError('SOURCE_INDEX', 'Source final manifest differs');
  await verifySourceIndexCertificate(env, manifest);
  return {
    state: 'prepared',
    manifest: journal.manifest,
    files: manifest.files,
    bytes: manifest.bytes,
    view_digest: manifest.view_digest,
  };
}

/** Rebuildable advisory cache only. A partial index never authorizes a source mount. */
export async function sourceIndexBounded(
  env: Env,
  revision: SourceRevision,
  cursor?: number,
): Promise<SourceIndexResult> {
  const name = sourceRepository(env, revision);
  const prefix = await indexPrefix(revision);
  const prior = await readIndexJournal(env, prefix, revision);
  if (
    prior?.value &&
    (prior.value.state !== 'preparing' || (cursor !== undefined && cursor !== prior.value.step))
  )
    return result(env, prefix, prior.value);
  using repo = await env.ARTIFACTS.get(name);
  const commit = await repo.readCommit(revision.commit);
  if (!commit || commit.hash !== revision.commit || commit.treeHash !== revision.tree)
    throw sourceError('SOURCE_CHANGED', 'Approved source root is unavailable');
  const journal: IndexJournal = prior?.value
    ? structuredClone(prior.value)
    : {
        version: 1,
        revision,
        step: 0,
        stack: [{ tree: revision.tree, path: '', next: 0 }],
        chunks: [],
        files: 0,
        bytes: 0,
        state: 'preparing',
      };
  const files: SourceFile[] = [];
  // Cache only this bounded step; immutable tree metadata is shared by adjacent file entries.
  const trees = new Map<string, NonNullable<Awaited<ReturnType<ArtifactsRepo['readTree']>>>>();
  let metadataOps = 0;
  let streamedBytes = 0;
  try {
    while (
      journal.stack.length &&
      files.length < 16 &&
      streamedBytes < 8 * 1024 * 1024 &&
      metadataOps++ < 32
    ) {
      const frame = journal.stack[journal.stack.length - 1];
      let entries = trees.get(frame.tree);
      if (!entries) {
        const fetched = await repo.readTree(frame.tree);
        if (!fetched || fetched.length > SOURCE_LIMITS.files)
          throw sourceError('SOURCE_LIMIT', 'Source tree exceeds allowance');
        entries = fetched.sort((a, b) => compareSourcePaths(a.name, b.name));
        if (new Set(entries.map((entry) => entry.name)).size !== entries.length)
          throw sourceError('SOURCE_OBJECT', 'Source tree contains ambiguous paths');
        trees.set(frame.tree, entries);
      }
      if (frame.next >= entries.length) {
        journal.stack.pop();
        continue;
      }
      const entry = entries[frame.next++];
      sourceEntry(entry);
      const path = sourcePath(frame.path ? `${frame.path}/${entry.name}` : entry.name);
      if (entry.type === 'tree') {
        if (journal.stack.length >= 256)
          throw sourceError('SOURCE_LIMIT', 'Source tree exceeds depth allowance');
        journal.stack.push({ tree: entry.hash, path, next: 0 });
        continue;
      }
      // This traversal proves membership at the approved commit/root before cache access.
      const proof = await cacheSourceBlob(env, repo, revision, entry.hash);
      streamedBytes += proof.size;
      journal.files++;
      journal.bytes += proof.size;
      if (journal.files > SOURCE_LIMITS.files || journal.bytes > SOURCE_LIMITS.bytes)
        throw sourceError('SOURCE_LIMIT', 'Source workspace exceeds allowance');
      files.push({
        path,
        mode: entry.mode as SourceFile['mode'],
        size: proof.size,
        content: {
          kind: 'git',
          repository: revision.repository,
          commit: revision.commit,
          path,
          blob: entry.hash,
        },
      });
    }
    if (files.length) journal.chunks.push(await immutableIndexObject(env, prefix, { files }));
    if (!journal.stack.length) {
      const all = await indexFiles(env, prefix, journal.chunks);
      if (
        all.length !== journal.files ||
        all.reduce((sum, file) => sum + file.size, 0) !== journal.bytes ||
        new Set(all.map((file) => file.path)).size !== all.length
      )
        throw sourceError('SOURCE_INDEX', 'Final source index counts differ');
      const view: SourceView = { version: 1, base: revision, files: all };
      const manifest = await certifySourceIndex(env, {
        version: 1,
        revision,
        chunks: journal.chunks,
        files: journal.files,
        bytes: journal.bytes,
        view_digest: await sourceFingerprint({ view, baseline_overrides: [] }),
      });
      journal.manifest = await immutableIndexObject(env, prefix, manifest);
      journal.state = 'prepared';
    }
  } catch (failure) {
    const code = (failure as { code?: string }).code;
    // SDK/R2 transport errors are real queue retries. Do not poison shared immutable metadata.
    if (!code?.startsWith('SOURCE_')) throw failure;
    journal.state = 'failed';
    journal.error_code = code;
  }
  journal.step++;
  const signed = await certifySourceIndexJournal(env, journal);
  const stored = await env.OBJECTS.put(`${prefix}/journal`, JSON.stringify(signed), {
    onlyIf: prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: '*' },
  });
  if (!stored) {
    const winner = await readIndexJournal(env, prefix, revision);
    if (!winner?.value)
      throw sourceError('SOURCE_INDEX', 'Source journal acknowledgement is unavailable');
    return result(env, prefix, winner.value);
  }
  return result(env, prefix, journal);
}

/** Read-only status check; creating or advancing the journal is a separate bounded operation. */
export async function ensureSourceIndex(
  env: Env,
  revision: SourceRevision,
): Promise<SourceIndexResult> {
  sourceRepository(env, revision);
  const prefix = await indexPrefix(revision);
  const journal = await readIndexJournal(env, prefix, revision);
  return journal?.value
    ? result(env, prefix, journal.value)
    : { state: 'preparing', cursor: 0, files: 0, bytes: 0 };
}

export async function preparedSourceView(
  env: Env,
  revision: SourceRevision,
  guard?: () => Promise<unknown>,
): Promise<SourceView> {
  const prefix = await indexPrefix(revision);
  const state = await ensureSourceIndex(env, revision);
  if (state.state !== 'prepared')
    throw sourceError('SOURCE_PREPARING', 'Source metadata is still preparing');
  const object = await env.OBJECTS.get(state.manifest);
  if (!object) throw sourceError('SOURCE_INDEX', 'Source manifest is missing');
  const manifest = await object.json<IndexManifest>();
  await verifySourceIndexCertificate(env, manifest);
  const view: SourceView = {
    version: 1,
    base: revision,
    files: await indexFiles(env, prefix, manifest.chunks, guard),
  };
  if (
    view.files.length !== manifest.files ||
    view.files.reduce((sum, file) => sum + file.size, 0) !== manifest.bytes ||
    new Set(view.files.map((file) => file.path)).size !== view.files.length ||
    (await sourceFingerprint({ view, baseline_overrides: [] })) !== state.view_digest
  )
    throw sourceError('SOURCE_INDEX', 'Source final view digest differs');
  if (guard) await guard();
  return view;
}

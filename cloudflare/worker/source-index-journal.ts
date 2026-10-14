import { type SourceFile, type SourceRevision, sourceError } from './source-contract';
import { sourceFingerprint } from './source-crypto';
import { verifySourceIndexJournal } from './source-index-certificate';
import { compareSourcePaths } from './source-path';
import type { Env } from './types';

export type IndexFrame = { tree: string; path: string; next: number };
export type IndexJournal = {
  version: 1;
  revision: SourceRevision;
  step: number;
  stack: IndexFrame[];
  chunks: string[];
  files: number;
  bytes: number;
  state: 'preparing' | 'prepared' | 'failed';
  manifest?: string;
  error_code?: string;
  certificate?: { version: 1; signature: string };
};
export type IndexManifest = {
  version: 1;
  revision: SourceRevision;
  chunks: string[];
  files: number;
  bytes: number;
  view_digest: string;
  certificate?: { version: 1; signature: string };
};
export const indexPrefix = async (revision: SourceRevision) =>
  `source/v1/index/${await sourceFingerprint(revision)}`;

export async function readIndexJournal(env: Env, prefix: string, revision: SourceRevision) {
  const object = await env.OBJECTS.get(`${prefix}/journal`);
  if (!object) return null;
  if (object.size > 512 * 1024)
    throw sourceError('SOURCE_INDEX', 'Source index journal exceeds limits');
  const value = await object.json<IndexJournal>();
  if (value.version !== 1 || !Array.isArray(value.stack) || !Array.isArray(value.chunks))
    throw sourceError('SOURCE_INDEX', 'Invalid source index journal');
  try {
    await verifySourceIndexJournal(env, value);
  } catch (failure) {
    if ((failure as { code?: string }).code === 'SOURCE_INDEX_UNSIGNED')
      return { value: null, etag: object.etag };
    throw failure;
  }
  if ((await sourceFingerprint(value.revision)) !== (await sourceFingerprint(revision)))
    throw sourceError(
      'SOURCE_INDEX_CERTIFICATE',
      'Source journal revision differs from the approved input',
    );
  return { value, etag: object.etag };
}

export async function immutableIndexObject(env: Env, prefix: string, value: unknown) {
  const digest = await sourceFingerprint(value);
  const key = `${prefix}/chunks/${digest}`;
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).length > 512 * 1024)
    throw sourceError('SOURCE_INDEX', 'Source index chunk exceeds limits');
  await env.OBJECTS.put(key, body, { onlyIf: { etagDoesNotMatch: '*' } });
  const readback = await env.OBJECTS.get(key);
  if (!readback || (await sourceFingerprint(await readback.json())) !== digest)
    throw sourceError('SOURCE_INDEX', 'Source index chunk differs from its immutable identity');
  return key;
}

export async function indexFiles(
  env: Env,
  prefix: string,
  chunks: string[],
  guard?: () => Promise<unknown>,
): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  let reads = 0;
  let lastGuard = 0;
  for (const key of chunks) {
    if (guard && (reads++ % 16 === 0 || Date.now() - lastGuard >= 10000)) {
      await guard();
      lastGuard = Date.now();
    }
    if (!key.startsWith(`${prefix}/chunks/`) || !/^[a-f0-9]{64}$/.test(key.slice(-64)))
      throw sourceError('SOURCE_INDEX', 'Invalid source index chunk reference');
    const object = await env.OBJECTS.get(key);
    if (!object || object.size > 512 * 1024)
      throw sourceError('SOURCE_INDEX', 'Source index chunk is missing');
    const chunk = await object.json<{ files: SourceFile[] }>();
    if (
      (await sourceFingerprint(chunk)) !== key.slice(-64) ||
      !Array.isArray(chunk.files) ||
      chunk.files.length > 16
    )
      throw sourceError('SOURCE_INDEX', 'Source index chunk proof differs');
    files.push(...chunk.files);
    if (files.length > 10000)
      throw sourceError('SOURCE_LIMIT', 'Source file count exceeds allowance');
  }
  return files.sort((a, b) => compareSourcePaths(a.path, b.path));
}

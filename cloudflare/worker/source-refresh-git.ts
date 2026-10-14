import { response } from './http';
import { SOURCE_LIMITS, type SourceRevision, sourceError } from './source-contract';
import {
  compareSourcePaths,
  sourceEntry,
  sourceLink,
  sourceOid,
  sourcePath,
  sourceRepository,
} from './source-path';
import { immutableSourceFile } from './source-storage';
import type { Env, Json } from './types';

/** Resolve only an already-authorized native revision; Git metadata never selects authority. */
export async function refreshRevision(
  env: Env,
  input: { repository: string; commit: string; tree?: string },
) {
  const commit = sourceOid(input.commit);
  using repo = await env.ARTIFACTS.get(sourceRepository(env, { ...input, tree: commit }));
  const actual = await repo.readCommit(commit);
  if (
    !actual ||
    actual.hash !== commit ||
    !Array.isArray(actual.parents) ||
    actual.parents.length > 128 ||
    (input.tree !== undefined && input.tree !== actual.treeHash)
  )
    throw sourceError('SOURCE_CHANGED', 'Frozen refresh commit is unavailable');
  actual.parents.forEach(sourceOid);
  return { revision: { ...input, tree: sourceOid(actual.treeHash) }, parents: actual.parents };
}

export async function refreshTree(env: Env, revision: SourceRevision, body: Json) {
  const path = sourcePath(body.path ?? '', true);
  if (body.cursor !== undefined && body.cursor !== null) sourcePath(body.cursor);
  const limit = body.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOURCE_LIMITS.page)
    throw sourceError('SOURCE_LIMIT', 'Refresh tree page exceeds allowance');
  using repo = await env.ARTIFACTS.get(sourceRepository(env, revision));
  const root = await repo.readCommit(revision.commit);
  if (!root || root.hash !== revision.commit || root.treeHash !== revision.tree)
    throw sourceError('SOURCE_CHANGED', 'Frozen refresh root differs');
  const entry = path ? await sourceLink(repo, revision, path) : null;
  if (entry && entry.type !== 'tree')
    throw sourceError('SOURCE_PATH', 'Refresh path is not a directory');
  const tree = entry?.hash ?? revision.tree;
  const entries = await repo.readTree(tree);
  if (
    !entries ||
    entries.length > SOURCE_LIMITS.files ||
    new Set(entries.map((e) => e.name)).size !== entries.length
  )
    throw sourceError('SOURCE_OBJECT', 'Refresh tree is unavailable or ambiguous');
  entries.forEach(sourceEntry);
  entries.sort((a, b) => compareSourcePaths(a.name, b.name));
  const remaining = entries.filter((e) => compareSourcePaths(e.name, body.cursor ?? '') > 0);
  const items = remaining
    .slice(0, limit)
    .map((e) => ({ name: e.name, mode: e.type === 'tree' ? '40000' : e.mode, oid: e.hash }));
  return response({
    tree_oid: tree,
    items,
    next_cursor: remaining.length > items.length ? items.at(-1)?.name : null,
  });
}

/** Missing paths are meaningful three-way merge inputs; ambiguity and unsafe objects fail closed. */
export async function refreshBlob(env: Env, revision: SourceRevision, body: Json) {
  const path = sourcePath(body.path);
  const offset = body.offset ?? 0;
  const limit = body.limit ?? 65536;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > SOURCE_LIMITS.readBytes
  )
    throw sourceError('SOURCE_LIMIT', 'Refresh blob range exceeds allowance');
  using repo = await env.ARTIFACTS.get(sourceRepository(env, revision));
  const root = await repo.readCommit(revision.commit);
  if (!root || root.hash !== revision.commit || root.treeHash !== revision.tree)
    throw sourceError('SOURCE_CHANGED', 'Frozen refresh root differs');
  let tree = revision.tree;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    const entries = await repo.readTree(tree);
    if (!entries || entries.length > SOURCE_LIMITS.files)
      throw sourceError('SOURCE_OBJECT', 'Refresh tree is unavailable');
    const matches = entries.filter((e) => e.name === parts[index]);
    if (!matches.length)
      throw sourceError('NOT_FOUND', 'Declared refresh path is absent in this revision');
    if (matches.length !== 1) throw sourceError('SOURCE_OBJECT', 'Refresh path is ambiguous');
    sourceEntry(matches[0]);
    if (index < parts.length - 1) {
      if (matches[0].type !== 'tree')
        throw sourceError('NOT_FOUND', 'Declared refresh path is absent in this revision');
      tree = matches[0].hash;
    } else if (!['blob', 'exec'].includes(matches[0].type)) {
      throw sourceError('SOURCE_PATH', 'Refresh blob requires a regular file');
    }
  }
  return immutableSourceFile(env, revision, path, offset, limit);
}

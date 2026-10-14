import { response } from './http';
import { cacheSourceBlob } from './source-cache';
import {
  type CaptureChange,
  type CaptureContext,
  sourceCaptureContext,
  sourceCaptureManifest,
  sourceCapturePath,
} from './source-capture-context';
import {
  type SourceFile,
  type SourceOverride,
  type SourceRevision,
  sourceError,
} from './source-contract';
import { sourceFingerprint } from './source-crypto';
import {
  compareSourcePaths,
  sourceEntry,
  sourceLink,
  sourceOid,
  sourcePath,
  sourceRepository,
} from './source-path';
import { sourceReadResponse } from './source-storage';
import type { Env, Json, Scope } from './types';

const fields: Record<string, string[]> = {
  context: [],
  manifest: ['kind', 'cursor', 'limit'],
  tree: ['path', 'cursor', 'limit', 'input'],
  blob: ['path', 'offset', 'limit', 'kind'],
  verify: ['commit', 'tree', 'parents'],
};

async function baseFile(env: Env, revision: SourceRevision, path: string): Promise<SourceFile> {
  using repo = await env.ARTIFACTS.get(sourceRepository(env, revision));
  const entry = await sourceLink(repo, revision, path);
  if (!['blob', 'exec'].includes(entry.type))
    throw sourceError('SOURCE_PATH', 'Capture blob requires a regular file');
  const proof = await cacheSourceBlob(env, repo, revision, entry.hash);
  return {
    path,
    size: proof.size,
    mode: entry.mode as SourceFile['mode'],
    content: {
      kind: 'git',
      repository: revision.repository,
      commit: revision.commit,
      path,
      blob: entry.hash,
    },
  };
}

async function treePage(env: Env, context: CaptureContext, body: Json) {
  const selected =
    body.input === undefined
      ? context.base
      : /^input-(\d+)$/.test(body.input)
        ? context.binding.inputs[Number(body.input.slice(6))]
        : undefined;
  if (!selected) throw sourceError('SOURCE_SCOPE', 'Capture tree input is not approved');
  const path = sourcePath(body.path ?? '', true);
  using repo = await env.ARTIFACTS.get(sourceRepository(env, selected));
  const commit = await repo.readCommit(selected.commit);
  if (!commit || commit.hash !== selected.commit || commit.treeHash !== selected.tree)
    throw sourceError('SOURCE_CHANGED', 'Capture base root differs');
  let tree = selected.tree;
  if (path) {
    const entry = await sourceLink(repo, selected, path);
    if (entry.type !== 'tree') throw sourceError('SOURCE_PATH', 'Capture path is not a tree');
    tree = entry.hash;
  }
  const entries = await repo.readTree(tree);
  if (!entries || entries.length > 10000)
    throw sourceError('SOURCE_LIMIT', 'Capture tree metadata exceeds allowance');
  entries.forEach(sourceEntry);
  entries.sort((a, b) => compareSourcePaths(a.name, b.name));
  const after = body.cursor === null || body.cursor === undefined ? '' : String(body.cursor);
  const remaining = entries.filter((entry) => compareSourcePaths(entry.name, after) > 0);
  const items = remaining.slice(0, body.limit ?? 200).map((entry) => ({
    name: entry.name,
    mode: entry.type === 'tree' ? '40000' : entry.mode,
    oid: entry.hash,
  }));
  return response({
    tree_oid: tree,
    items,
    next_cursor: remaining.length > items.length ? items.at(-1)?.name : null,
  });
}

/** Called only after current container check_attempt and supervisor bearer authentication. */
export async function sourceCapture(env: Env, scope: Scope, op: string, body: Json) {
  if (!fields[op] || Object.keys(body).some((key) => !fields[op].includes(key)))
    throw sourceError('FORBIDDEN', 'Unknown capture operation or private selector');
  if (
    body.limit !== undefined &&
    (!Number.isSafeInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > (op === 'blob' ? 65536 : 200))
  )
    throw sourceError('SOURCE_LIMIT', 'Capture page exceeds allowance');
  const context = await sourceCaptureContext(env, scope);
  if (op === 'context') {
    const { _capture_grant: _private, ...publicContext } = context;
    return response(publicContext);
  }
  if (op === 'manifest') {
    if (body.kind !== undefined && !['overrides', 'changes'].includes(body.kind))
      throw sourceError('SOURCE_SCOPE', 'Unknown manifest section');
    return response(
      await sourceCaptureManifest(
        env,
        context,
        body.kind ?? 'changes',
        body.cursor ?? null,
        body.limit ?? 200,
      ),
    );
  }
  if (op === 'tree') return treePage(env, context, body);
  if (op === 'blob') {
    const path = sourcePath(body.path);
    let file: SourceFile | null;
    if (body.kind === 'before') file = await baseFile(env, context.base, path);
    else if (body.kind === 'override') {
      const override = (await sourceCapturePath(
        env,
        context,
        path,
        'overrides',
      )) as SourceOverride | null;
      file = override?.file ?? null;
    } else if (body.kind === 'after') {
      const change = (await sourceCapturePath(
        env,
        context,
        path,
        'changes',
      )) as CaptureChange | null;
      const override = change
        ? null
        : ((await sourceCapturePath(env, context, path, 'overrides')) as SourceOverride | null);
      file = change
        ? change.after
        : override
          ? override.file
          : await baseFile(env, context.base, path);
    } else throw sourceError('SOURCE_SCOPE', 'Unknown capture blob kind');
    if (!file) throw sourceError('NOT_FOUND', 'Captured path is deleted or unavailable');
    const offset = body.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
      throw sourceError('SOURCE_LIMIT', 'Invalid capture offset');
    return sourceReadResponse(env, context.binding, {
      version: 1,
      workspace_id: context.binding.workspace_id,
      workspace_version: context.seal.workspace_version,
      file: { ...file, kind: 'file', exists: true, file_version: context.seal.workspace_version },
      content: file.content,
      offset,
      length: Math.min(body.limit ?? 65536, file.size - offset),
    });
  }
  const fork = scope.fork ?? scope.job.payload?.fork;
  if (typeof fork !== 'string' || !Array.isArray(body.parents))
    throw sourceError('SOURCE_SCOPE', 'Capture fork is not server assigned');
  sourceOid(body.commit);
  sourceOid(body.tree);
  if ((await sourceFingerprint(body.parents)) !== (await sourceFingerprint(context.parents)))
    throw sourceError('SOURCE_SCOPE', 'Capture ordered parents differ');
  const ref = { repository: fork, commit: body.commit, tree: body.tree };
  using repo = await env.ARTIFACTS.get(sourceRepository(env, ref));
  const actual = await repo.readCommit(body.commit);
  const assigned = scope.job.source_capture_ref;
  const tip = assigned?.branch ? (await repo.log({ ref: assigned.branch, limit: 1 }))[0] : null;
  if (
    !actual ||
    actual.hash !== body.commit ||
    actual.treeHash !== body.tree ||
    !tip ||
    tip.hash !== body.commit ||
    (await sourceFingerprint(actual.parents)) !== (await sourceFingerprint(context.parents)) ||
    !(await repo.readTree(body.tree))
  )
    throw sourceError(
      'SOURCE_CHANGED',
      'Captured fork commit, tree, or parents differ from readback',
    );
  return response({
    verified: true,
    revision: { repository: fork, commit: actual.hash },
    tree: actual.treeHash,
    parents: actual.parents,
  });
}

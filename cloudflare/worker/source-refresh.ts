import { response } from './http';
import { sourceError } from './source-contract';
import { sourceFingerprint } from './source-crypto';
import { sourceOid, sourcePath, sourceRepository } from './source-path';
import { sourceRefreshContext, sourceRefreshFrozen } from './source-refresh-context';
import { refreshBlob, refreshRevision, refreshTree } from './source-refresh-git';
import { sourceRefreshPathAllowed, sourceRefreshPaths } from './source-refresh-paths';
import { sha } from './storage';
import type { Env, Json, Scope } from './types';

const fields: Record<string, string[]> = {
  context: [],
  tree: ['input', 'path', 'cursor', 'limit'],
  blob: ['input', 'path', 'offset', 'limit'],
  verify: ['commit', 'tree', 'parents'],
  verify_input: [],
  paths: ['after', 'limit', 'expectedDigest'],
};

/** Private root transport. Identity and all input revisions come from the active native reservation. */
export async function sourceRefresh(env: Env, scope: Scope, op: string, body: Json) {
  if (!fields[op] || Object.keys(body).some((key) => !fields[op].includes(key)))
    throw sourceError('FORBIDDEN', 'Unknown refresh operation or authority selector');
  const frozen = await sourceRefreshFrozen(env, scope);
  if (op === 'context') return response(await sourceRefreshContext(env, scope, frozen));
  if (op === 'paths') return response(await sourceRefreshPaths(env, scope, frozen, body));
  if (op === 'verify_input') {
    const input = await refreshRevision(env, frozen.candidate);
    if (input.revision.tree !== frozen.candidate.tree || input.parents[0] !== frozen.base.commit)
      throw sourceError('SOURCE_CHANGED', 'Reserved refresh candidate differs');
    if (typeof scope.fork !== 'string')
      throw sourceError('SOURCE_SCOPE', 'Refresh fork is not assigned');
    using repo = await env.ARTIFACTS.get(
      sourceRepository(env, { ...input.revision, repository: scope.fork }),
    );
    const actual = await repo.readCommit(input.revision.commit);
    const ref = `refs/yoneda/source-input/${await sha(String(scope.job.id))}`;
    const tip = (await repo.log({ ref, limit: 1 }))[0];
    if (
      !actual ||
      actual.hash !== input.revision.commit ||
      actual.treeHash !== input.revision.tree ||
      !tip ||
      tip.hash !== input.revision.commit ||
      (await sourceFingerprint(actual.parents)) !== (await sourceFingerprint(input.parents)) ||
      !(await repo.readTree(input.revision.tree))
    )
      throw sourceError(
        'SOURCE_CHANGED',
        'Refresh preload commit, tree, parents or temporary ref differs',
      );
    return response({
      verified: true,
      revision: { repository: scope.fork, commit: actual.hash },
      tree: actual.treeHash,
      parents: actual.parents,
    });
  }
  if (op === 'tree' || op === 'blob') {
    if (!['base', 'head', 'candidate'].includes(body.input))
      throw sourceError('FORBIDDEN', 'Refresh input is not a frozen alias');
    if (op === 'blob') {
      const path = sourcePath(body.path);
      if (!(await sourceRefreshPathAllowed(env, scope, frozen, path)))
        throw sourceError('FORBIDDEN', 'Refresh bytes are outside the declared paths');
    }
    const input = frozen[body.input as 'base' | 'head' | 'candidate'];
    const { revision } = await refreshRevision(env, input);
    if (input.tree !== undefined && input.tree !== revision.tree)
      throw sourceError('SOURCE_CHANGED', 'Refresh frozen tree differs');
    return op === 'tree' ? refreshTree(env, revision, body) : refreshBlob(env, revision, body);
  }
  const parents = [frozen.head.commit, frozen.candidate.commit];
  if (
    !Array.isArray(body.parents) ||
    (await sourceFingerprint(body.parents)) !== (await sourceFingerprint(parents))
  )
    throw sourceError('FORBIDDEN', 'Refresh ordered merge parents differ');
  sourceOid(body.commit);
  sourceOid(body.tree);
  const fork = scope.fork;
  const assigned = scope.job.source_capture_ref;
  if (typeof fork !== 'string' || typeof assigned?.branch !== 'string')
    throw sourceError('SOURCE_SCOPE', 'Refresh fork is not server assigned');
  using repo = await env.ARTIFACTS.get(
    sourceRepository(env, { repository: fork, commit: body.commit, tree: body.tree }),
  );
  const actual = await repo.readCommit(body.commit);
  const candidate = await repo.readCommit(frozen.candidate.commit);
  const head = await repo.readCommit(frozen.head.commit);
  const tip = (await repo.log({ ref: assigned.branch, limit: 1 }))[0];
  if (
    !actual ||
    actual.hash !== body.commit ||
    actual.treeHash !== body.tree ||
    !tip ||
    tip.hash !== body.commit ||
    !candidate ||
    candidate.hash !== frozen.candidate.commit ||
    candidate.treeHash !== frozen.candidate.tree ||
    !head ||
    head.hash !== frozen.head.commit ||
    (await sourceFingerprint(actual.parents)) !== (await sourceFingerprint(parents)) ||
    !(await repo.readTree(body.tree))
  )
    throw sourceError(
      'SOURCE_CHANGED',
      'Refresh fork, merge parents, or candidate closure differs',
    );
  return response({
    verified: true,
    revision: { repository: fork, commit: actual.hash },
    tree: actual.treeHash,
    parents: actual.parents,
  });
}

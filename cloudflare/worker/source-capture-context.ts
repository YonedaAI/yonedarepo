import { sourceAuthority } from './source-authority';
import {
  type SourceBinding,
  type SourceFile,
  type SourceOverride,
  sourceError,
} from './source-contract';
import { compareSourcePaths } from './source-path';
import { ledger } from './storage';
import type { Env, Json, Scope } from './types';

export type CaptureContext = {
  version: 1;
  binding: SourceBinding;
  seal: {
    workspace_id: string;
    seal_id: string;
    checkpoint_id: string;
    changeset_digest: string;
    workspace_version: number;
  };
  view_digest: string;
  base: SourceBinding['base'];
  parents: string[];
  baseline_overrides_digest: string;
  manifest_header: Json;
  manifest_cursor: null;
  _capture_grant: Json;
};
export type CaptureChange = { path: string; before: SourceFile | null; after: SourceFile | null };

/** Current capture job's read grant is distinct from the expired source producer grant. */
export async function sourceCaptureContext(env: Env, scope: Scope): Promise<CaptureContext> {
  if (scope.job.kind !== 'capture')
    throw sourceError('FORBIDDEN', 'No sealed source capture capability');
  const context = (await ledger(env, scope.repo_id, {
    op: 'source_capture_context',
    job_id: scope.job.id,
    epoch: scope.job.epoch,
  })) as CaptureContext;
  if (
    context.version !== 1 ||
    context.binding.repo_id !== scope.repo_id ||
    context.binding.workspace_id !== context.seal.workspace_id ||
    context._capture_grant?.claims.capture_job_id !== scope.job.id ||
    context._capture_grant.claims.capture_epoch !== scope.job.epoch
  )
    throw sourceError('SOURCE_SCOPE', 'Capture source authority differs');
  return context;
}

export async function sourceCaptureManifest(
  env: Env,
  context: CaptureContext,
  kind: 'changes' | 'overrides',
  cursor: string | null,
  limit: number,
) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    (cursor !== null && (typeof cursor !== 'string' || cursor.length > 512))
  )
    throw sourceError('SOURCE_LIMIT', 'Invalid sealed manifest page');
  const result = await sourceAuthority<Json>(env, context.binding.workspace_id, {
    op: 'source_manifest',
    checkpoint_id: context.seal.checkpoint_id,
    section: kind === 'overrides' ? 'baseline_overrides' : 'changes',
    ...(cursor === null ? {} : { after: cursor }),
    limit,
    _capture_grant: context._capture_grant,
  });
  if (
    result.changeset_digest !== context.seal.changeset_digest ||
    result.checkpoint_id !== context.seal.checkpoint_id ||
    !Array.isArray(result.items) ||
    result.items.length > limit ||
    new TextEncoder().encode(JSON.stringify(result)).length > 1024 * 1024
  )
    throw sourceError('SOURCE_SCOPE', 'Sealed manifest page differs');
  return {
    items: result.items,
    next_cursor: result.next_cursor,
    changeset_digest: result.changeset_digest,
  };
}

export async function sourceCapturePath(
  env: Env,
  context: CaptureContext,
  path: string,
  kind: 'changes' | 'overrides',
): Promise<CaptureChange | SourceOverride | null> {
  let cursor: string | null = null;
  for (let page = 0; page < 51; page++) {
    const value = await sourceCaptureManifest(env, context, kind, cursor, 200);
    for (const item of value.items) {
      if (item.path === path) return item;
      if (compareSourcePaths(item.path, path) > 0) return null;
    }
    if (value.next_cursor === null) return null;
    if (value.next_cursor === cursor)
      throw sourceError('SOURCE_SCOPE', 'Sealed manifest cursor did not advance');
    cursor = value.next_cursor;
  }
  throw sourceError('SOURCE_LIMIT', 'Sealed source manifest exceeds allowance');
}

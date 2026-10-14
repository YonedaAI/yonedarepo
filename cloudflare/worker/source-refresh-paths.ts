import { sourceError } from './source-contract';
import { sourceFingerprint } from './source-crypto';
import { compareSourcePaths, sourcePath } from './source-path';
import type { RefreshFrozen } from './source-refresh-context';
import { ledger } from './storage';
import type { Env, Json, Scope } from './types';

async function command(env: Env, scope: Scope, frozen: RefreshFrozen, input: Json) {
  const ref = frozen.declared_paths_ref;
  if (!ref) throw sourceError('SOURCE_SCOPE', 'No compact refresh path authority');
  const value = await ledger(env, scope.repo_id, {
    op: 'source_refresh_paths',
    job_id: scope.job.id,
    epoch: scope.job.epoch,
    expected_digest: ref.digest,
    ...input,
  });
  if (
    value.version !== 1 ||
    value.digest !== ref.digest ||
    value.total !== ref.count ||
    (await sourceFingerprint(value.paths_ref)) !== (await sourceFingerprint(ref))
  )
    throw sourceError('SOURCE_SCOPE', 'Refresh path authority changed');
  return value;
}

/** Each page is guarded by the native active refresh reservation, not a caller-supplied manifest ID. */
export async function sourceRefreshPaths(
  env: Env,
  scope: Scope,
  frozen: RefreshFrozen,
  body: Json,
) {
  const ref = frozen.declared_paths_ref;
  const after = body.after ?? null;
  const limit = body.limit ?? 200;
  if (!ref || body.expectedDigest !== ref.digest)
    throw sourceError('SOURCE_SCOPE', 'Refresh path digest is not the current reservation');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw sourceError('SOURCE_LIMIT', 'Refresh path page exceeds allowance');
  if (after !== null && (typeof after !== 'string' || !after.isWellFormed()))
    throw sourceError('SOURCE_SCOPE', 'Refresh cursor must be a UTF8 path string');
  if (after !== null && after !== '') sourcePath(after.endsWith('/') ? after.slice(0, -1) : after);
  const value = await command(env, scope, frozen, { after, limit });
  if (
    !Array.isArray(value.items) ||
    value.items.length > limit ||
    typeof value.has_more !== 'boolean' ||
    new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024
  )
    throw sourceError('SOURCE_SCOPE', 'Refresh path page is not bounded');
  let previous = after ?? '';
  for (const path of value.items) {
    if (typeof path !== 'string')
      throw sourceError('SOURCE_SCOPE', 'Refresh path entry is invalid');
    sourcePath(path.endsWith('/') ? path.slice(0, -1) : path);
    if (compareSourcePaths(path, previous) <= 0)
      throw sourceError('SOURCE_SCOPE', 'Refresh path cursor does not advance');
    previous = path;
  }
  if (
    value.has_more
      ? !value.items.length || value.next_cursor !== previous
      : value.next_cursor !== null
  )
    throw sourceError('SOURCE_SCOPE', 'Refresh path page cursor differs');
  return value;
}

/** Indexed native membership runs before SDK/cache I/O; no whole manifest scan or hydration. */
export async function sourceRefreshPathAllowed(
  env: Env,
  scope: Scope,
  frozen: RefreshFrozen,
  path: string,
) {
  sourcePath(path);
  if (!frozen.declared_paths_ref)
    return (frozen.declared_paths ?? []).some(
      (allowed) => path === allowed || (allowed.endsWith('/') && path.startsWith(allowed)),
    );
  const value = await command(env, scope, frozen, { path });
  if (typeof value.allowed !== 'boolean')
    throw sourceError('SOURCE_SCOPE', 'Refresh path membership is invalid');
  return value.allowed;
}

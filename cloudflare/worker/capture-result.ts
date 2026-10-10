import { CANDIDATE_DIFF_LIMIT } from './evidence';
import { captureFileProvenance } from './provenance';
import { ledger, object } from './storage';
import type { Env, Json, Scope } from './types';

function changedPaths(files: Json[]): string[] {
  return [
    ...new Set(
      files.flatMap((file) =>
        [file.path, file.old_path].filter((path): path is string => typeof path === 'string'),
      ),
    ),
  ].sort();
}
function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'INVALID_CAPTURE' });
}

/** Independent Artifacts readback; result claims never supply Git paths or blob identities. */
export async function captureResult(env: Env, scope: Scope, body: Json): Promise<Json> {
  const job = scope.job;
  const identity = { job_id: job.id, epoch: job.epoch };
  if (!scope.fork) invalid('Captured repository is unavailable');
  const refresh = job.payload.capture_subtype === 'refresh_candidate';
  const commitHash =
    refresh && body.status === 'unresolved' ? body.merge_workspace_commit : body.revision?.commit;
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(commitHash ?? ''))
    invalid('Captured revision is invalid');
  if (!(refresh && body.status === 'unresolved') && body.revision?.repository !== scope.fork)
    throw Object.assign(new Error('Captured repository mismatch'), { code: 'FORBIDDEN' });
  using captured = await env.ARTIFACTS.get(scope.fork.split('/')[1]);
  const commit = await captured.readCommit(commitHash);
  const base = refresh ? job.payload.expected_head : job.payload.base.commit;
  const parents = refresh ? [base, job.payload.candidate.revision.commit] : [base];
  if (
    !commit ||
    commit.treeHash !== (refresh ? (body.merge_tree ?? body.tree) : body.tree) ||
    JSON.stringify(commit.parents) !== JSON.stringify(parents)
  )
    invalid('Captured commit identity or parents differ from the frozen approval');
  const fileProvenance = await captureFileProvenance(captured, base, commitHash);
  const paths = changedPaths(fileProvenance);
  const {
    diff: _diff,
    diff_digest: _digest,
    file_provenance: _files,
    paths: _paths,
    readback: _readback,
    workspace_revision: _workspace,
    resolver_delta_paths: _resolverDelta,
    ...metadata
  } = body;
  const result: Json = { ...metadata, paths, file_provenance: fileProvenance };
  if (refresh) {
    const status = await ledger(env, scope.repo_id, { op: 'repository_status' });
    using canonical = await env.ARTIFACTS.get(status.remote.name);
    const info = await canonical.info();
    const observed = (
      await canonical.log({ ref: status.remote.branch ?? info.defaultBranch, limit: 1 })
    )[0]?.hash;
    const candidatePaths = changedPaths(
      await captureFileProvenance(
        captured,
        job.payload.expected_base,
        job.payload.candidate.revision.commit,
      ),
    );
    const interveningPaths = changedPaths(
      await captureFileProvenance(captured, job.payload.expected_base, job.payload.expected_head),
    );
    result.readback = {
      observed_head: observed,
      version: status.version,
      parents: commit.parents,
      candidate_paths: candidatePaths,
      intervening_paths: interveningPaths,
      ...(body.status === 'clean'
        ? { merge_commit: commitHash, merged_paths: paths }
        : { workspace_commit: commitHash, conflict_paths: body.conflict_paths }),
    };
    if (body.status === 'unresolved') {
      result.workspace_revision = { repository: scope.fork, commit: commitHash };
    } else {
      if (typeof body.diff !== 'string') invalid('Trusted merge must supply a bounded diff');
      result.diff_digest = (await object(env, body.diff, CANDIDATE_DIFF_LIMIT)).digest;
    }
    return { op: 'conflict_refresh_complete', ...identity, result };
  }
  if (job.payload.capture_subtype === 'resolve_conflict') {
    const workspace = job.payload.merge_workspace_revision;
    if (typeof workspace?.repository !== 'string' || typeof workspace?.commit !== 'string')
      invalid('Frozen resolver merge workspace is missing');
    using merged = await env.ARTIFACTS.get(workspace.repository.split('/')[1]);
    // Compare blob identities across repositories; the new fork need not retain
    // the old merge workspace object after trusted recapture.
    const delta = changedPaths(
      await captureFileProvenance(captured, workspace.commit, commitHash, merged),
    );
    const status = await ledger(env, scope.repo_id, { op: 'repository_status' });
    using canonical = await env.ARTIFACTS.get(status.remote.name);
    const info = await canonical.info();
    const observed = (
      await canonical.log({ ref: status.remote.branch ?? info.defaultBranch, limit: 1 })
    )[0]?.hash;
    result.resolver_delta_paths = delta;
    result.readback = {
      observed_head: observed,
      version: status.version,
      parents: commit.parents,
      candidate_commit: commitHash,
      captured_paths: paths,
      resolver_delta_paths: delta,
    };
  }
  if (typeof body.diff !== 'string') invalid('Trusted capture must supply the full diff');
  result.diff_digest = (await object(env, body.diff, CANDIDATE_DIFF_LIMIT)).digest;
  return { op: 'finish', ...identity, result };
}

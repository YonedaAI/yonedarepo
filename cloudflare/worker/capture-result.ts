import { platformRevision } from './agents-platform';
import { CANDIDATE_DIFF_LIMIT } from './evidence';
import { captureFileProvenance } from './provenance';
import { sourceCaptureCompletion } from './source-completion';
import { openSource, type SourceRepo } from './source-objects';
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
async function targetReadback(env: Env, scope: Scope, source: SourceRepo) {
  const branchId =
    scope.job.payload.working_branch_id ?? scope.job.payload.conflict_resolver?.working_branch_id;
  if (typeof branchId === 'string') {
    const branch = await ledger(env, scope.repo_id, { op: 'working_branch', id: branchId });
    if (branch.working_revision?.repository !== platformRevision(scope.repo_id))
      invalid('Working target repository is unavailable');
    if (!(await source.readCommit(branch.working_commit)))
      invalid('Working target commit is unavailable');
    return { observed: branch.working_commit, version: branch.version };
  }
  const status = await ledger(env, scope.repo_id, { op: 'repository_status' });
  return { observed: await source.head('main'), version: status.version };
}

/** Independent platform readback; result claims never supply Git paths or blob identities. */
export async function captureResult(env: Env, scope: Scope, body: Json): Promise<Json> {
  const job = scope.job;
  const identity = { job_id: job.id, epoch: job.epoch };
  const repository = platformRevision(scope.repo_id);
  // Runtime captures are of a registered seal; refreshes and contributions finish in the Worker.
  if (job.payload.capture_subtype !== 'source_changeset')
    invalid('Only a sealed source capture completes through the broker');
  const sourceCapture = await sourceCaptureCompletion(env, scope, body);
  const commitHash = body.revision?.commit;
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(commitHash ?? ''))
    invalid('Captured revision is invalid');
  if (body.revision?.repository !== repository)
    throw Object.assign(new Error('Captured repository mismatch'), { code: 'FORBIDDEN' });
  const captured = await openSource(env, repository);
  const commit = await captured.readCommit(commitHash);
  // Only the commit this attempt's broker set on its assigned branch is its capture.
  const branch = job.source_capture_ref?.branch;
  if (typeof branch !== 'string' || (await captured.head(branch)) !== commitHash)
    invalid('Captured commit is not the head of its assigned candidate branch');
  const base = sourceCapture.context.base.commit;
  const parents = sourceCapture.context.parents;
  if (
    !commit ||
    commit.hash !== commitHash ||
    commit.treeHash !== body.tree ||
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
    source_lineage: _sourceLineage,
    source_verified: _sourceVerified,
    ...metadata
  } = body;
  const result: Json = {
    ...metadata,
    paths,
    file_provenance: fileProvenance,
    source_lineage: sourceCapture.lineage,
    source_verified: true,
  };
  if (job.payload.source_resolution === true) {
    const workspace = job.payload.merge_workspace_revision;
    if (typeof workspace?.repository !== 'string' || typeof workspace?.commit !== 'string')
      invalid('Frozen resolver merge workspace is missing');
    if (workspace.repository !== repository) invalid('Frozen resolver merge workspace is foreign');
    const delta = changedPaths(await captureFileProvenance(captured, workspace.commit, commitHash));
    const { observed, version } = await targetReadback(env, scope, captured);
    result.resolver_delta_paths = delta;
    result.readback = {
      observed_head: observed,
      version,
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

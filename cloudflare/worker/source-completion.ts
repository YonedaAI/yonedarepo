import { sourceCaptureContext } from './source-capture-context';
import { ledger } from './storage';
import type { Env, Json, Scope } from './types';

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'INVALID_CAPTURE' });
};

/** A model cannot supply registration authority; only the current root completion consumes it. */
export async function sourceAgentCompletion(env: Env, scope: Scope, body: Json): Promise<Json> {
  const registration = await ledger(env, scope.repo_id, {
    op: 'source_registered',
    job_id: scope.job.id,
  });
  const source = body.source_workspace;
  const seal = source?.mounts?.repo;
  if (
    source?.transport !== 'api-source-v1' ||
    source.checked !== false ||
    source.published !== false ||
    !seal ||
    ['workspace_id', 'seal_id', 'checkpoint_id', 'changeset_digest', 'workspace_version'].some(
      (field) =>
        seal[field] !==
        (field === 'workspace_id' ? registration.binding?.workspace_id : registration[field]),
    ) ||
    registration.binding?.job_id !== scope.job.id ||
    registration.binding?.epoch !== scope.job.epoch ||
    registration.binding?.repo_id !== scope.repo_id
  )
    invalid('Source completion differs from the registered seal');
  const {
    source_verified: _verified,
    source_registered: _registration,
    source_workspace: _source,
    workspace: _workspace,
    fork_revision: _fork,
    git_verified: _git,
    ...metadata
  } = body;
  return {
    ...metadata,
    source_verified: true,
    source_registered: {
      producer_job_id: scope.job.id,
      producer_epoch: scope.job.epoch,
      registration_id: registration.registration_id,
      changeset_digest: registration.changeset_digest,
    },
  };
}

/** Source capture lineage is independently reread from the sealed native registration. */
export async function sourceCaptureCompletion(env: Env, scope: Scope, body: Json) {
  const context = await sourceCaptureContext(env, scope);
  if (
    body.source_changeset_digest !== context.seal.changeset_digest ||
    body.source_manifest_digest !== context.seal.changeset_digest ||
    JSON.stringify(body.parents) !== JSON.stringify(context.parents)
  )
    invalid('Capture does not match the exact sealed changeset');
  return {
    context,
    lineage: {
      version: 1,
      authority: 'registered_source_changeset',
      workspace_id: context.binding.workspace_id,
      registration_id: scope.job.payload.source_registered.registration_id,
      producer_job_id: context.binding.job_id,
      producer_epoch: context.binding.epoch,
      seal_id: context.seal.seal_id,
      checkpoint_id: context.seal.checkpoint_id,
      changeset_digest: context.seal.changeset_digest,
      view_digest: context.view_digest,
      baseline_overrides_digest: context.baseline_overrides_digest,
    },
  };
}

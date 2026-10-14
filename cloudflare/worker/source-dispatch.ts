import { cleanupLateRemote } from './repository-deletion';
import { sourceCaptureContext } from './source-capture-context';
import { sourceCaptureRef } from './source-capture-ref';
import { type SourceReadContext, sourceError } from './source-contract';
import { ensureSourceIndex } from './source-index';
import { sourceIndexEnvelope } from './source-index-queue';
import { sourceRepository } from './source-path';
import { sourceRefreshFrozen } from './source-refresh-context';
import { refreshRevision } from './source-refresh-git';
import { activateSourceMounts } from './source-scope';
import { ledger, sha } from './storage';
import type { Env, Scope } from './types';

/** Preparation has no model/reservation authority. Native defer owns attempt/outbox semantics. */
export async function prepareSourceDispatch(env: Env, scope: Scope): Promise<'ready' | 'deferred'> {
  const job = scope.job;
  if (job.payload?.workspace_transport !== 'api-source-v1') return 'ready';
  if (job.kind === 'capture') {
    const base =
      job.payload.capture_subtype === 'refresh_candidate'
        ? (await refreshRevision(env, (await sourceRefreshFrozen(env, scope)).head)).revision
        : (await sourceCaptureContext(env, scope)).base;
    const source = sourceRepository(env, base);
    const name = `candidate-${(await sha(`${scope.repo_id}:${job.id}:${job.epoch}`)).slice(0, 32)}`;
    using origin = await env.ARTIFACTS.get(source);
    try {
      // Working bases may be on non-default branches; capture must retain their object ancestry.
      const created = await origin.fork(name, { defaultBranchOnly: false });
      using target = await env.ARTIFACTS.get(name);
      await target.revokeToken(created.token);
    } catch (failure) {
      using existing = await env.ARTIFACTS.get(name);
      try {
        await existing.info();
      } catch {
        throw failure;
      }
    }
    using target = await env.ARTIFACTS.get(name);
    for (const token of (await target.listTokens()).tokens)
      if (token.state === 'active') await target.revokeToken(token.id);
    const retained = await target.readCommit(base.commit);
    if (!retained || retained.hash !== base.commit || retained.treeHash !== base.tree)
      throw sourceError('INVALID_CAPTURE', 'Capture fork does not retain the exact approved base');
    job.source_capture_ref = await sourceCaptureRef(target);
    try {
      await ledger(env, scope.repo_id, { op: 'check_attempt', job_id: job.id, epoch: job.epoch });
    } catch (failure) {
      if ((failure as { code?: string }).code === 'REPOSITORY_DELETED')
        await cleanupLateRemote(env, scope.repo_id, name);
      throw failure;
    }
    job.fork = `${env.ARTIFACTS_NAMESPACE}/${name}`;
    scope.fork = job.fork;
    job.payload.base = base;
    return 'ready';
  }
  if (!['agent', 'evaluate'].includes(job.kind)) return 'ready';
  const context = (await ledger(env, scope.repo_id, {
    op: 'source_read_context',
    job_id: job.id,
    epoch: job.epoch,
  })) as SourceReadContext;
  const inputs =
    context.role === 'reviewer'
      ? (context.source_mounts ?? [])
          .filter((mount) => mount.path === 'candidate-0' || mount.path === 'candidate-1')
          .map((mount) => {
            const approved = context.inputs.find(
              (input) =>
                input.repository === mount.base.repository &&
                input.commit === mount.base.commit &&
                input.tree === mount.base.tree,
            );
            if (!approved)
              throw sourceError('SOURCE_SCOPE', 'Reviewer mount is not a frozen source input');
            return approved;
          })
      : context.inputs;
  let preparing = false;
  for (const revision of inputs) {
    const state = await ensureSourceIndex(env, revision);
    if (state.state === 'failed')
      throw sourceError(
        'INVALID_CAPTURE',
        `Source metadata preparation failed (${state.error_code})`,
      );
    if (state.state === 'preparing') {
      preparing = true;
      await env.AGENT_QUEUE.send(sourceIndexEnvelope(context, revision));
    }
  }
  if (preparing) {
    await ledger(env, scope.repo_id, {
      op: 'defer_job',
      job_id: job.id,
      epoch: job.epoch,
      reason: 'source_preparing',
    });
    return 'deferred';
  }
  job.source_mounts = await activateSourceMounts(env, scope);
  return 'ready';
}

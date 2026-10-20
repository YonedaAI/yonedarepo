import { sourceCaptureContext } from './source-capture-context';
import { type SourceReadContext, sourceError } from './source-contract';
import { ensureSourceIndex } from './source-index';
import { sourceIndexEnvelope } from './source-index-queue';
import { activateSourceMounts } from './source-scope';
import { ledger, sha } from './storage';
import type { Env, Scope } from './types';

/** Preparation has no model/reservation authority. Native defer owns attempt/outbox semantics. */
export async function prepareSourceDispatch(env: Env, scope: Scope): Promise<'ready' | 'deferred'> {
  const job = scope.job;
  if (job.payload?.workspace_transport !== 'api-source-v1') return 'ready';
  if (job.kind === 'capture') {
    const base = (await sourceCaptureContext(env, scope)).base;
    // Each capture attempt commits to its own candidate branch on the project's platform repo.
    job.source_capture_ref = {
      branch: `agents/capture-${(await sha(`${scope.repo_id}:${job.id}:${job.epoch}`)).slice(0, 32)}`,
    };
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

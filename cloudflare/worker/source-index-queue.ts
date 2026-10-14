import {
  type SourceIndexEnvelope,
  type SourceMount,
  type SourceReadContext,
  type SourceRevision,
  sourceError,
} from './source-contract';
import { sourceFingerprint } from './source-crypto';
import { sourceIndexBounded } from './source-index';
import { ledger } from './storage';
import type { Env } from './types';

/** Factory called with private native source_read_context, never model arguments. */
export function sourceIndexEnvelope(
  context: SourceReadContext,
  revision: SourceRevision,
  mount: SourceMount = 'repo',
): SourceIndexEnvelope {
  if (
    context.version !== 1 ||
    context.transport !== 'api-source-v1' ||
    !context.inputs.some(
      (input) =>
        input.repository === revision.repository &&
        input.commit === revision.commit &&
        input.tree === revision.tree,
    )
  )
    throw sourceError('SOURCE_SCOPE', 'Source index revision is outside the frozen inputs');
  return {
    v: 1,
    version: 1,
    kind: 'source_index',
    repo_id: context.repo_id,
    job_id: context.job_id,
    mount,
    revision,
  };
}

/** Queue progress has no attempt/write authority and may outlive the producer epoch. */
export async function sourceIndex(env: Env, envelope: SourceIndexEnvelope) {
  if (envelope.version !== 1 || envelope.kind !== 'source_index')
    throw sourceError('SOURCE_SCOPE', 'Invalid source index envelope');
  const context = (await ledger(env, envelope.repo_id, {
    op: 'source_read_context',
    job_id: envelope.job_id,
  })) as SourceReadContext;
  if (
    context.repo_id !== envelope.repo_id ||
    context.job_id !== envelope.job_id ||
    context.transport !== 'api-source-v1' ||
    !context.inputs.some(
      (input) =>
        input.repository === envelope.revision.repository &&
        input.commit === envelope.revision.commit &&
        input.tree === envelope.revision.tree,
    )
  )
    throw sourceError(
      'SOURCE_SCOPE',
      'Source index job no longer authorizes this immutable revision',
    );
  const approved = context.inputs.find(
    (input) =>
      input.repository === envelope.revision.repository &&
      input.commit === envelope.revision.commit,
  );
  if ((await sourceFingerprint(approved)) !== (await sourceFingerprint(envelope.revision)))
    throw sourceError('SOURCE_SCOPE', 'Source index approved tree differs');
  return sourceIndexBounded(env, envelope.revision);
}

import { sha } from './storage';
import type { Env, Json, Scope } from './types';

/** Controlled deployed exercise only. Production and reviewer namespaces cannot enable it. */
export async function injectPublicationAckLoss(
  env: Env,
  scope: Scope,
  result: Json,
): Promise<boolean> {
  if (
    env.ACCEPTANCE_FAULTS !== 'publish-ack-once' ||
    !env.ARTIFACTS_NAMESPACE.endsWith('-acceptance') ||
    !(scope.repo_id.startsWith('acceptance-') || scope.repo_id === env.ACCEPTANCE_REPOSITORY) ||
    scope.job.kind !== 'publish' ||
    typeof result.commit !== 'string' ||
    result.commit !== scope.job.payload.target.commit ||
    result.conflict === true
  )
    return false;
  const key = `acceptance-faults/${await sha(`${scope.repo_id}:${scope.job.id}`)}`;
  const marker = await env.OBJECTS.put(
    key,
    JSON.stringify({
      kind: 'controlled-publication-ack-loss',
      repo_id: scope.repo_id,
      job_id: scope.job.id,
      epoch: scope.job.epoch,
      target: result.commit,
      injected_at: Date.now(),
    }),
    { onlyIf: new Headers({ 'If-None-Match': '*' }) },
  );
  return marker !== null;
}

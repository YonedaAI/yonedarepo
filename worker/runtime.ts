import type { Json } from './types';
export function checkLedger(snapshot: Json) {
  if (snapshot?.capabilities?.artifact_reads !== 2)
    throw Object.assign(
      new Error('Repository ledger code is still updating; retry after deployment propagation'),
      { code: 'LEDGER_UPDATING' },
    );
}
// Worker and image deploy separately; refuse incompatible images before model calls.
export function checkRuntime(health: Json, job: Json) {
  if (health?.protocol !== 2)
    throw new Error('Previous container protocol is still serving; wait for rollout completion');
  if (
    job.kind === 'agent' &&
    job.payload?.execution?.harness === 'gemini' &&
    !health.harnesses?.includes('gemini')
  )
    throw new Error('Container image does not support Gemini; wait for rollout completion');
  if (job.payload?.policy?.build && !health.suites?.includes('commands-v1'))
    throw new Error('Container image does not support general repository runs');
  if (
    job.kind === 'evaluate' &&
    ((health.environment !== job.payload.policy.environment &&
      !health.environments?.includes(job.payload.policy.environment)) ||
      !Array.isArray(health.suites) ||
      !health.suites.includes(job.payload.policy.suite))
  )
    throw new Error(
      'Evaluator image does not support the requested policy; wait for rollout completion',
    );
}
export function modelForJob(job: Json, defaults: { codex: string; claude: string }) {
  return job.model ?? defaults[job.payload.execution?.harness === 'codex' ? 'codex' : 'claude'];
}

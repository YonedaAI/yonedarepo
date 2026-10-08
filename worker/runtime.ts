import type { Json } from './types';
// Worker and image deploy separately; refuse incompatible images before model calls.
export function checkRuntime(health: Json, job: Json) {
  if (health?.protocol !== 2)
    throw new Error('Previous container protocol is still serving; wait for rollout completion');
  if (
    job.kind === 'evaluate' &&
    (health.environment !== job.payload.policy.environment ||
      !Array.isArray(health.suites) ||
      !health.suites.includes(job.payload.policy.suite))
  )
    throw new Error(
      'Evaluator image does not support the requested policy; wait for rollout completion',
    );
}

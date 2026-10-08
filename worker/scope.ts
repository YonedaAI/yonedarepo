import { ledger } from './storage';
import type { Env, Scope } from './types';
export async function scopeFor(env: Env, id: string) {
  const stub = env.EXECUTIONS.get(env.EXECUTIONS.idFromString(id));
  const scope = (await stub.scope()) as unknown as Scope;
  await ledger(env, scope.repo_id, {
    op: 'check_attempt',
    job_id: scope.job.id,
    epoch: scope.job.epoch,
  });
  return { scope, stub };
}

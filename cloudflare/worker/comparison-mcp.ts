import { comparisonContext } from './comparison-context';
import { assertComparisonReview } from './comparison-scope';
import { error, response } from './http';
import { ledger } from './storage';
import type { Env, Json, Scope } from './types';

export async function comparisonMcp(env: Env, scope: Scope, body: Json): Promise<Response> {
  if (!['comparison_context', 'comparison_submit'].includes(body.name))
    return error(
      'FORBIDDEN',
      'Review attempts have read-only comparison tools and comparison_submit only',
      403,
    );
  assertComparisonReview(scope.job);
  const args = body.arguments ?? {};
  if (body.name === 'comparison_context')
    return response(await comparisonContext(env, scope, args));
  return response(
    await ledger(env, scope.repo_id, {
      op: 'comparison_submit',
      job_id: scope.job.id,
      epoch: scope.job.epoch,
      request_id: args.request_id,
      manifest_digest: args.manifest_digest,
      outcome: args.outcome,
      candidate_id: args.candidate_id,
      rationale: args.rationale,
      alternatives: args.alternatives,
      risks: args.risks ?? [],
      evidence_refs: args.evidence_refs ?? [],
      repair_instructions: args.repair_instructions,
    }),
  );
}

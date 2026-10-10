import { contextResponse } from './context-access';
import { guardContextAccess } from './context-policy';
import { error, response } from './http';
import { ledger, object, readObject } from './storage';
import type { Env, Json, Scope } from './types';

/** Container identity, never model arguments, determines attempt authority. */
export async function hostedMcp(env: Env, scope: Scope, body: Json): Promise<Response> {
  const job = scope.job;
  if (job.kind !== 'agent') return error('FORBIDDEN', 'This attempt has no agent tools', 403);
  const args = body.arguments ?? {};
  const name = body.name;
  const identity = { job_id: job.id, epoch: job.epoch };
  const command = (input: Json) => ledger(env, scope.repo_id, { ...input, ...identity });
  await guardContextAccess(env, scope.repo_id, identity, name, args);
  const finish = async (value: Json) =>
    response(await contextResponse(env, scope.repo_id, identity, name, value));
  if (name === 'peer_status') return response(await command({ op: 'peer_status' }));
  if (name === 'repo_context' || name === 'execution_status')
    return finish(await command({ op: 'context' }));
  if (name === 'team_context' || name === 'integration_request')
    return finish(await command({ op: name }));
  if (name === 'team_plan_propose')
    return finish(
      await command({ op: name, plan: args.plan, expected_proposal: args.expected_proposal }),
    );
  if (name === 'task_handoff')
    return finish(
      await command({
        op: name,
        summary: args.summary,
        interface_contract: args.interface_contract,
        references: args.references ?? [],
      }),
    );
  if (name === 'context_usage')
    return finish(
      await command({
        op: name,
        cursor: args.cursor,
        limit: args.limit,
        execution_id: args.execution_id,
        filter_epoch: args.epoch,
      }),
    );
  if (name === 'delegate_agent' || name === 'delegation_status')
    return finish(
      await command({
        op: name,
        ...(name === 'delegate_agent'
          ? { request_id: args.request_id, task: args.task, strategy: args.strategy }
          : {}),
      }),
    );
  if (['context_publish', 'context_get', 'context_search'].includes(name)) {
    const input: Json =
      name === 'context_publish'
        ? { record: { ...args, id: `context:${crypto.randomUUID()}` } }
        : {
            id: args.id,
            query: args.query,
            kind: args.kind,
            limit: args.limit,
            cursor: args.cursor,
          };
    return finish(await command({ ...input, op: name }));
  }
  if (name === 'artifact_get') {
    const artifact = await command({ op: 'authorize_artifact', id: args.id });
    // Successful, digest-verified delivery and its compatibility event commit together.
    return finish({ ...artifact, content: await readObject(env, artifact.digest) });
  }
  if (name === 'artifact_publish') {
    if (typeof args.content !== 'string' || args.content.length > 128 * 1024)
      return error('INVALID_INPUT', 'Artifact content must be bounded text');
    const stored = await object(env, args.content);
    return finish(
      await command({
        op: 'publish_artifact',
        id: `artifact:${crypto.randomUUID()}`,
        digest: stored.digest,
        label: args.label,
        kind: args.kind,
        metadata: args.metadata ?? {},
      }),
    );
  }
  if (name === 'execution_complete')
    return finish(await command({ op: 'hint_complete', summary: args.summary }));
  return error('FORBIDDEN', 'Unknown scoped tool', 403);
}

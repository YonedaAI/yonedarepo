import { contextResponse } from './context-access';
import { guardContextAccess } from './context-policy';
import { error, response, safeId } from './http';
import { validateFilePathAssertions } from './provenance';
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
  if (name === 'peer_message')
    return finish(
      await command({
        op: name,
        request_id: args.request_id,
        recipient: args.recipient,
        kind: args.kind,
        body: args.body,
        context_ids: args.context_ids ?? [],
      }),
    );
  if (name === 'peer_inbox')
    return finish(
      await command({
        op: name,
        after: args.after,
        limit: args.limit,
        ack_ids: args.ack_ids ?? [],
      }),
    );
  if (name === 'repair_request')
    return finish(await command({ op: name, request_id: args.request_id, reason: args.reason }));
  if (name === 'repair_team' || name === 'resolve_conflict')
    return finish(
      await command({
        op: name,
        request_id: args.request_id,
        expected_commit: args.expected_commit,
        expected_version: args.expected_version,
        expected_plan_revision: args.expected_plan_revision,
        expected_task_revisions: args.expected_task_revisions,
        ...(name === 'repair_team'
          ? {
              run_id: args.run_id,
              task_ids: args.task_ids,
              ...(args.task_definitions === undefined
                ? {}
                : { task_definitions: args.task_definitions }),
            }
          : { conflict_id: args.conflict_id }),
      }),
    );
  if (name === 'refresh_candidate')
    return finish(
      await command({
        op: name,
        request_id: args.request_id,
        candidate_id: args.candidate_id,
        expected_commit: args.expected_commit,
        expected_version: args.expected_version,
      }),
    );
  if (name === 'intent_question')
    return finish(
      await command({
        op: name,
        request_id: args.request_id,
        question: args.question,
        ...(args.options === undefined ? {} : { options: args.options }),
      }),
    );
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
    let checkedFilePaths: string[] | undefined;
    if (name === 'context_publish' && args.file_paths !== undefined) {
      const base = job.payload.execution?.base;
      const [namespace, repository, extra] = String(base?.repository ?? '').split('/');
      if (
        extra ||
        namespace !== env.ARTIFACTS_NAMESPACE ||
        !safeId(repository) ||
        typeof base?.commit !== 'string'
      )
        return error(
          'INVALID_INPUT',
          'File path assertions need the assigned source revision',
          400,
        );
      using source = await env.ARTIFACTS.get(repository);
      checkedFilePaths = await validateFilePathAssertions(source, base.commit, args.file_paths);
    }
    const input: Json =
      name === 'context_publish'
        ? {
            record: {
              ...args,
              ...(checkedFilePaths ? { file_paths: checkedFilePaths } : {}),
              id: `context:${crypto.randomUUID()}`,
            },
          }
        : {
            id: args.id,
            query: args.query,
            kind: args.kind,
            limit: args.limit,
            cursor: args.cursor,
            file_path: args.file_path,
            authority: args.authority,
            lineage: args.lineage,
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

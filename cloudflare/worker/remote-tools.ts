import { contextResponse } from './context-access';
import { guardContextAccess } from './context-policy';
import { contribution } from './contributions';
import { ledger, readObject } from './storage';
import type { Env, Json, Principal } from './types';

export async function remoteTool(
  env: Env,
  principal: Principal,
  repo: string,
  name: string,
  args: Json,
  origin: string,
  sessionId?: string,
): Promise<Json> {
  const identity: Json = {
    _workspace: principal.workspace,
    _grant: principal.grant?.id,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
  const command = (input: Json) => ledger(env, repo, { ...input, ...identity });
  await guardContextAccess(env, repo, identity, name, args);
  const finish = (value: Json) => contextResponse(env, repo, identity, name, value);
  if (name === 'repo_context') {
    const s = await command({ op: 'snapshot' });
    return finish({
      repository: s.repository,
      runs: s.runs.slice(-10),
      decisions: s.decisions.slice(-10),
      context: s.nodes
        .filter((n: Json) =>
          [
            'intent',
            'requirement',
            'constraint',
            'assumption',
            'finding',
            'alternative',
            'proposed_decision',
            'question',
          ].includes(n.kind),
        )
        .slice(-50),
      git_url: `${origin}/git/${repo}/source`,
    });
  }
  if (name === 'context_usage')
    return finish(
      await command({
        op: name,
        run_id: args.run_id,
        execution_id: args.execution_id,
        epoch: args.epoch,
        cursor: args.cursor,
        limit: args.limit,
      }),
    );
  if (['context_search', 'context_get', 'graph', 'why', 'decision'].includes(name))
    return finish(
      await command({
        op: name,
        id: args.id,
        query: args.query,
        kind: args.kind,
        limit: args.limit,
        cursor: args.cursor,
        depth: args.depth,
        commit: args.commit,
        path: args.path,
      }),
    );
  if (['attempt_begin', 'attempt_status', 'attempt_submit'].includes(name))
    return finish(await contribution(env, principal, repo, name, args, origin, sessionId));
  if (name === 'context_publish') {
    if (principal.grant?.scope !== 'contribute')
      throw new Error('A contribution grant is required');
    const job = await command({ op: 'external_check', attempt_id: args.attempt_id });
    return finish(
      await command({
        op: 'context_publish',
        job_id: job.id,
        epoch: job.epoch,
        record: {
          id: `context:${crypto.randomUUID()}`,
          kind: args.kind,
          statement: args.statement,
          purpose: args.purpose,
          intent_id: args.intent_id,
          links: args.links ?? [],
        },
      }),
    );
  }
  if (name === 'artifact_get') {
    const s = await command({ op: 'snapshot' });
    const artifact =
      s.artifacts.find((a: Json) => a.id === args.id) ??
      s.evaluations.find((e: Json) => e.id === args.id);
    if (!artifact) throw new Error('Artifact or evaluation is not attached to this repository');
    // Verification precedes both the opened receipt and its returned content.
    return finish({
      ...artifact,
      content: await readObject(env, artifact.digest ?? artifact.evidence),
    });
  }
  throw new Error('Tool is unavailable; agents cannot select or publish canonical source');
}

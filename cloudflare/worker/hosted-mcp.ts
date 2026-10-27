import { contextResponse } from './context-access';
import { error, response } from './http';
import { validateFilePathAssertions } from './provenance';
import { openSource, type SourceRepo } from './source-objects';
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
  const finish = async (value: Json) =>
    response(await contextResponse(env, scope.repo_id, identity, name, value));
  if (name === 'repo_context' || name === 'execution_status')
    return finish(await command({ op: 'context' }));
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
  if (['context_publish', 'context_get', 'context_search'].includes(name)) {
    let checkedFilePaths: string[] | undefined;
    if (name === 'context_publish' && args.file_paths !== undefined) {
      const base = job.payload.execution?.base;
      let source: SourceRepo;
      try {
        if (typeof base?.commit !== 'string') throw new Error('No assigned source revision');
        source = await openSource(env, String(base?.repository ?? ''));
      } catch {
        return error(
          'INVALID_INPUT',
          'File path assertions need the assigned source revision',
          400,
        );
      }
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

// External contributions through the remote MCP: a grant-scoped agent reads the attempt's
// source and commits files onto the attempt's own platform branch through these tools, with
// the project's agent token held here. Submission binds the branch head; a trusted capture
// then rebuilds it on the frozen base before evaluation. The contributor never holds a
// platform credential and cannot select or publish canonical source.
import { repositoryPlatform } from './agents-platform';
import { platformSource } from './source-objects';
import { sourcePath } from './source-path';
import { ledger, sha } from './storage';
import type { Env, Json, Principal } from './types';

const MAX_CHANGES = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const AUTHOR = { name: 'External contributor', email: 'contributor@yonedarepo.invalid' };
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Validated file changes in the platform's commit format. */
function changesOf(input: unknown): Json[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CHANGES)
    throw failure('INVALID_INPUT', `Commit 1 to ${MAX_CHANGES} file changes`);
  return input.map((change: Json) => {
    const path = sourcePath(change?.path);
    if (change.delete === true) return { path, delete: true };
    if (typeof change.content_b64 !== 'string' || change.content_b64.length > MAX_FILE_BYTES * 2)
      throw failure('INVALID_INPUT', 'Each file needs content_b64 of at most 1 MiB, or delete');
    return { path, content_b64: change.content_b64, type: change.executable ? 'exec' : 'blob' };
  });
}

export async function contribution(
  env: Env,
  principal: Principal,
  repo: string,
  name: string,
  args: Json,
  sessionId?: string,
) {
  const grant = principal.grant;
  if (grant?.scope !== 'contribute') throw new Error('A contribution grant is required');
  const command = (input: Json) =>
    ledger(env, repo, {
      ...input,
      _workspace: principal.workspace,
      _grant: grant.id,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  if (name === 'attempt_begin') {
    if (typeof args.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(args.request_id))
      throw new Error('Use a stable request UUID');
    const id = `external-${(await sha(`${repo}:${grant.id}:${args.request_id}`)).slice(0, 32)}`;
    const job = await command({
      op: 'external_begin',
      id,
      branch: `contributions/${id}`,
      intent: args.intent,
      criteria: args.criteria ?? [],
      context: args.context ?? [],
    });
    return {
      ...job.payload,
      attempt_id: id,
      epoch: job.epoch,
      deadline: job.attempt_deadline,
      workspace_transport: job.workspace_transport,
      intent_id: `intent:${job.payload.execution.run_id}`,
      base: job.payload.execution.base,
    };
  }
  if (typeof args.attempt_id !== 'string' || !/^external-[a-f0-9]{32}$/.test(args.attempt_id))
    throw new Error('Valid contribution attempt_id required');
  if (name === 'attempt_status')
    return command({ op: 'external_status', attempt_id: args.attempt_id });
  const platform = await repositoryPlatform(env, repo);
  const source = platformSource(platform);
  if (name === 'attempt_read') {
    const job = await command({ op: 'external_status', attempt_id: args.attempt_id });
    const at = (await source.head(job.external_branch)) ?? job.payload.execution.base.commit;
    const path = args.path ? sourcePath(args.path) : '';
    const query = `?commit=${at}&path=${encodeURIComponent(path)}`;
    // A directory lists its entries; a regular file returns its content.
    try {
      return await platform.call('GET', `/tree${query}`);
    } catch (failed: any) {
      if (failed.code !== 'NOT_FOUND' || !path) throw failed;
      return platform.call('GET', `/blob${query}`);
    }
  }
  if (name === 'attempt_commit') {
    const changes = changesOf(args.changes);
    const job = await command({ op: 'external_check', attempt_id: args.attempt_id });
    const head = await source.head(job.external_branch);
    const made = await platform.call('POST', '/commits', {
      parent: head ?? job.payload.execution.base.commit,
      changes,
      message: String(args.message ?? 'External contribution').slice(0, 2000),
      author: AUTHOR,
    });
    // Compare-and-swap: a concurrent commit from the same attempt is refused, never lost.
    await platform.call('POST', '/branches', {
      ref: job.external_branch,
      commit: made.commit,
      expected: head,
    });
    return { commit: made.commit, tree: made.tree, branch: job.external_branch };
  }
  let job = await command({ op: 'external_status', attempt_id: args.attempt_id });
  if (job.status === 'done')
    return { status: 'capture_requested', execution: job.payload.execution.id };
  job = await command({ op: 'external_freeze', attempt_id: args.attempt_id });
  if (!job.submitted_revision) {
    const commit = await source.head(job.external_branch);
    if (!commit) throw new Error('Commit your contribution with attempt_commit before submitting');
    job = await command({
      op: 'external_bind',
      attempt_id: args.attempt_id,
      revision: { repository: job.external_fork, commit },
    });
  }
  await command({ op: 'external_submit', attempt_id: args.attempt_id });
  return {
    status: 'capture_requested',
    execution: job.payload.execution.id,
    submitted_revision: job.submitted_revision,
  };
}

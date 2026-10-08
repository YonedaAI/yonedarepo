import { source } from './artifacts';
import { ledger, object, sha } from './storage';
import type { Env, Json, Principal } from './types';
export async function contribution(
  env: Env,
  principal: Principal,
  repo: string,
  name: string,
  args: Json,
  origin: string,
) {
  const grant = principal.grant;
  if (grant?.scope !== 'contribute') throw new Error('A contribution grant is required');
  const command = (input: Json) =>
    ledger(env, repo, { ...input, _workspace: principal.workspace, _grant: grant.id });
  if (name === 'attempt_begin') {
    if (typeof args.request_id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(args.request_id))
      throw new Error('Use a stable request UUID');
    const id = `external-${(await sha(`${repo}:${grant.id}:${args.request_id}`)).slice(0, 32)}`;
    const fork = `contribution-${(await sha(id)).slice(0, 32)}`;
    const job = await command({
      op: 'external_begin',
      id,
      fork: `${env.ARTIFACTS_NAMESPACE}/${fork}`,
      intent: args.intent,
      criteria: args.criteria ?? [],
      context: args.context ?? [],
    });
    const canonical = job.payload.execution.base.repository.split('/')[1];
    try {
      using base = await env.ARTIFACTS.get(canonical);
      const created = await base.fork(fork, { defaultBranchOnly: true });
      using target = await env.ARTIFACTS.get(fork);
      await target.revokeToken(created.token);
    } catch (e) {
      try {
        using target = await env.ARTIFACTS.get(fork);
        await target.info();
      } catch {
        throw e;
      }
    }
    using target = await env.ARTIFACTS.get(fork);
    for (const token of (await target.listTokens()).tokens)
      if (token.state === 'active') await target.revokeToken(token.id);
    return {
      ...job.payload,
      attempt_id: id,
      epoch: job.epoch,
      deadline: job.attempt_deadline,
      intent_id: `intent:${job.payload.execution.run_id}`,
      git_url: `${origin}/git/${repo}/${id}`,
      base: job.payload.execution.base,
    };
  }
  if (typeof args.attempt_id !== 'string' || !/^external-[a-f0-9]{32}$/.test(args.attempt_id))
    throw new Error('Valid contribution attempt_id required');
  if (name === 'attempt_status')
    return command({ op: 'external_status', attempt_id: args.attempt_id });
  let job = await command({ op: 'external_status', attempt_id: args.attempt_id });
  if (job.status === 'done')
    return { status: 'capture_requested', execution: job.payload.execution.id };
  job = await command({ op: 'external_freeze', attempt_id: args.attempt_id });
  if (!job.submitted_revision) {
    using fork = await env.ARTIFACTS.get(job.external_fork.split('/')[1]);
    const info = await fork.info();
    const commit = (await fork.log({ ref: info.defaultBranch, limit: 1 }))[0]?.hash;
    if (!commit) throw new Error('Push your contribution to its default branch before submitting');
    job = await command({
      op: 'external_bind',
      attempt_id: args.attempt_id,
      revision: { repository: job.external_fork, commit },
    });
  }
  const files = await source(env, job.submitted_revision);
  const stored = await object(env, JSON.stringify(files), 12 * 1024 * 1024);
  await command({ op: 'external_submit', attempt_id: args.attempt_id, workspace: stored.digest });
  return {
    status: 'capture_requested',
    execution: job.payload.execution.id,
    submitted_revision: job.submitted_revision,
  };
}

// Ledger-level test kit, mirroring the Rust source kit: every run starts with the adapter's
// source approval, and a sandbox attempt finishes with the commit it pushed as its candidate.
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';

const approve = (run: Json, base: Json) =>
  run.workspace_transport !== undefined
    ? run
    : { ...run, workspace_transport: 'api-source-v1', _source_transport_approved: true,
        _source_base: { repository: base.repository, commit: base.commit, tree: 'b'.repeat(40) } };

/**
 * What the Worker adds to a run approval after reading the platform: lazy source at the frozen
 * base (the working branch head, else the published commit).
 */
export async function approvedStart(env: Env, repo: string, command: Json): Promise<Json> {
  if (command.op !== 'start_run') return command;
  const call = (input: Json) => ledger(env, repo, input);
  const working =
    command.working_branch_id == null
      ? null
      : (await call({ op: 'working_branch', id: command.working_branch_id })).working_revision;
  if (working) return approve(command, working);
  const status = await call({ op: 'repository_status' });
  return approve(command, {
    repository: `${status.remote.namespace}/${status.remote.name}`,
    commit: status.published_commit,
  });
}

/** A build policy, which every run needs, and a one-agent roster for it. */
export const buildPolicy = {
  version: 'build-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1', required_checks: ['build'],
  build: { checks: [{ name: 'build', argv: ['node', '--check', 'app.js'], timeout_seconds: 30 }] },
};
export const oneAgent = [{ provider: 'mimo', model: 'mimo-v2.6-flash', strategy: 'minimal' }];

/** `ledger` with the start approval applied, for fixtures that issue raw commands. */
export const approvedLedger = (env: Env, repo: string) => async (command: Json) =>
  ledger(env, repo, await approvedStart(env, repo, command));

/** What the start route approves for a sandbox run (`runtime: "sandbox-cli-v1"`) at `base`. */
export const sandboxStart = (base: Json) => ({
  workspace_transport: 'sandbox-cli-v1', _source_transport_approved: true, _source_base: base,
});

/**
 * What recordSandboxCandidate sends once it has read the attempt branch back: `made`, the one
 * commit the claimed sandbox `job` pushed on the run's frozen `base`, becomes the candidate.
 * `result` names it (`id`) and its changed `paths`.
 */
export async function finishSandbox(env: Env, repo: string, job: Json, base: Json,
  made: { commit: string; tree: string }, result: Json): Promise<Json> {
  return ledger(env, repo, { op: 'sandbox_finish', job_id: job.id, epoch: job.epoch, result: {
    revision: { repository: base.repository, commit: made.commit }, parents: [base.commit],
    tree: made.tree, summary: 'Sandbox change', ...result } });
}

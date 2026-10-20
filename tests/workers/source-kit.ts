// Ledger-level test kit, mirroring the Rust source kit: every run starts with the adapter's
// API source approval, a coding attempt finishes through a real registered seal (SourceWS and
// repository DO, no changed files), and a capture result carries that seal's lineage.
import { sourceAuthority } from '../../cloudflare/worker/source-authority';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json } from '../../cloudflare/worker/types';

const approve = (run: Json, base: Json) =>
  run.workspace_transport !== undefined
    ? run
    : { ...run, workspace_transport: 'api-source-v1', _source_transport_approved: true,
        _source_base: { repository: base.repository, commit: base.commit, tree: 'b'.repeat(40) } };

/**
 * What the Worker adds to a run approval after reading the platform: lazy source at the frozen
 * base (the working branch head, else the published commit). A guided concurrent retry starts
 * from the extend checkpoint the ledger restores.
 */
export async function approvedStart(env: Env, repo: string, command: Json): Promise<Json> {
  const call = (input: Json) => ledger(env, repo, input);
  const published = async () => {
    const status = await call({ op: 'repository_status' });
    return { repository: `${status.remote.namespace}/${status.remote.name}`, commit: status.published_commit };
  };
  const working = async (id: unknown) => (id == null ? null : (await call({ op: 'working_branch', id })).working_revision);
  if (command.op === 'start_run')
    return approve(command, (await working(command.working_branch_id)) ?? (await published()));
  if (command.op !== 'start_guided_step' || !Array.isArray(command._guided_runs)) return command;
  const session = await call({ op: 'guided_session', id: command.session_id, _workspace: command._workspace })
    .catch(() => null);
  let base = (await working(session?.working_branch_id).catch(() => null)) ?? (await published());
  if (command.retry === true && command.step_id === 'concurrent')
    base = session?.steps?.find((step: Json) => step.id === 'extend')?.revision ?? base;
  return { ...command, _guided_runs: command._guided_runs.map((run: Json) => approve(run, base)) };
}

/** `ledger` with the start approval applied, for fixtures that issue raw commands. */
export const approvedLedger = (env: Env, repo: string) => async (command: Json) =>
  ledger(env, repo, await approvedStart(env, repo, command));

/** Seal the leased producer's approved view unchanged and register it; returns the registration. */
export async function sealSource(env: Env, repo: string, job: Json): Promise<Json> {
  const call = (command: Json) => ledger(env, repo, command);
  const context = await call({ op: 'source_read_context', job_id: job.id, epoch: job.epoch });
  const view = { version: 1, base: context.base, files: [] };
  // Dependency paths start absent; the capture reads their premerged bytes itself.
  const paths = [...new Set<string>((context.baseline_inputs ?? []).flatMap((input: Json) => input.paths ?? []))].sort();
  const overrides = paths.map((path) => ({ path, file: null }));
  const bound = await call({ op: 'source_bind', job_id: job.id, epoch: job.epoch, _source_view: view,
    _source_baseline_overrides: overrides, _supervisor: true });
  const source = (command: Json) =>
    sourceAuthority(env, bound.binding.workspace_id, { ...command, _actor: bound.actor_grant });
  await source({ op: 'source_init', request_id: 'init', binding: bound.binding, view, baseline_overrides: overrides });
  const checkpoint = await source({ op: 'source_checkpoint', request_id: 'checkpoint', expected_workspace_version: 0 });
  const seal = await source({ op: 'source_seal', request_id: 'seal', expected_workspace_version: 0,
    checkpoint_id: checkpoint.checkpoint_id, expected_checkpoint_digest: checkpoint.changeset_digest });
  return call({ op: 'source_register_changeset', request_id: 'register', job_id: job.id, epoch: job.epoch,
    view_digest: bound.binding.view_digest, _source_seal: seal });
}

/** The registration pointer an adapter-verified coding completion reports. */
export function pointer(registration: Json): Json {
  const binding = registration.binding;
  return { producer_job_id: binding.job_id, producer_epoch: binding.epoch,
    registration_id: registration.registration_id, changeset_digest: registration.changeset_digest };
}

/** Finish a leased coding job through its registered seal; `extra` adds result fields. */
export async function finishSealed(env: Env, repo: string, job: Json, extra: Json = {}): Promise<Json> {
  const registration = await sealSource(env, repo, job);
  await ledger(env, repo, { op: 'finish', job_id: job.id, epoch: job.epoch,
    result: { source_verified: true, source_registered: pointer(registration), ...extra } });
  return registration;
}

/** A trusted capture `result` bound to `registration`'s seal and producer identity. */
export function withLineage(registration: Json, result: Json): Json {
  const binding = registration.binding;
  return { parents: binding.parents, source_verified: true,
    source_lineage: { version: 1, authority: 'registered_source_changeset', workspace_id: binding.workspace_id,
      registration_id: registration.registration_id, producer_job_id: binding.job_id,
      producer_epoch: binding.epoch, seal_id: registration.seal_id, checkpoint_id: registration.checkpoint_id,
      changeset_digest: registration.changeset_digest, view_digest: binding.view_digest,
      baseline_overrides_digest: binding.baseline_overrides_digest },
    source_changeset_digest: registration.changeset_digest,
    source_manifest_digest: registration.changeset_digest, ...result };
}

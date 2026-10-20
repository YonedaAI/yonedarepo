import { sourceAuthority } from './source-authority';
import {
  type SourceContext,
  type SourceMount,
  type SourceOverride,
  type SourceReadContext,
  type SourceRevision,
  sourceError,
} from './source-contract';
import { sourceFingerprint } from './source-crypto';
import { preparedSourceView } from './source-index';
import { compareSourcePaths, sourceRepo } from './source-path';
import { ledger } from './storage';
import type { Env, Scope } from './types';

export async function sourceScope(
  env: Env,
  scope: Scope,
  mount: SourceMount,
  supervisor = false,
): Promise<SourceContext> {
  const context = (await ledger(env, scope.repo_id, {
    op: 'source_read_context',
    job_id: scope.job.id,
    epoch: scope.job.epoch,
  })) as SourceReadContext;
  if (
    context.transport !== 'api-source-v1' ||
    context.repo_id !== scope.repo_id ||
    context.job_id !== scope.job.id ||
    context.epoch !== scope.job.epoch
  )
    throw sourceError('SOURCE_SCOPE', 'Source attempt identity differs');
  if (context.role === 'reviewer' && mount === 'repo')
    throw sourceError(
      'SOURCE_SCOPE',
      'Reviewer source is restricted to captured candidate aliases',
    );
  const selected: SourceRevision | undefined =
    mount === 'repo'
      ? context.base
      : context.source_mounts?.find((item) => item.path === mount)?.base;
  if (
    !selected ||
    !context.inputs.some(
      (input) =>
        input.repository === selected.repository &&
        input.commit === selected.commit &&
        input.tree === selected.tree,
    )
  )
    throw sourceError('SOURCE_SCOPE', 'Source mount is not an approved immutable input');
  const readOnly = mount !== 'repo';
  const prior = context.bindings?.find(
    (binding) =>
      binding.base.repository === selected.repository &&
      binding.base.commit === selected.commit &&
      binding.base.tree === selected.tree,
  );
  if (prior) {
    const refreshed = await ledger(env, scope.repo_id, {
      op: 'source_bind',
      job_id: scope.job.id,
      epoch: scope.job.epoch,
      _source_view_digest: prior.view_digest,
      ...(readOnly ? { _read_only: true } : {}),
      ...(supervisor ? { _supervisor: true } : {}),
    });
    if (
      (await sourceFingerprint(refreshed.binding)) !== (await sourceFingerprint(prior)) ||
      refreshed.actor_grant?.claims.purpose !== (supervisor ? 'supervisor' : 'source')
    )
      throw sourceError('SOURCE_SCOPE', 'Source refreshed grant differs');
    try {
      await sourceAuthority(env, prior.workspace_id, {
        op: 'source_status',
        _actor: refreshed.actor_grant,
      });
      return { binding: refreshed.binding, actor: refreshed.actor_grant, mount };
    } catch (failure) {
      // First RepoDO bind may have committed before SourceDO init acknowledgement was lost.
      if ((failure as { code?: string }).code !== 'NOT_FOUND') throw failure;
    }
  }
  const guard = () =>
    ledger(env, scope.repo_id, { op: 'heartbeat', job_id: scope.job.id, epoch: scope.job.epoch });
  await guard();
  const view = await preparedSourceView(env, selected, guard);
  const verifyRoot = async (revision: SourceRevision) => {
    await guard();
    const repo = await sourceRepo(env, revision);
    const actual = await repo.readCommit(revision.commit);
    if (!actual || actual.hash !== revision.commit || actual.treeHash !== revision.tree)
      throw sourceError('SOURCE_CHANGED', 'Certified source root differs from the frozen input');
    await guard();
  };
  await verifyRoot(selected);
  const baseline = new Map<string, SourceOverride>();
  if (mount === 'repo' && context.access === 'read_write') {
    for (const input of context.baseline_inputs ?? []) {
      const approved = context.inputs.find(
        (ref) =>
          ref.repository === input.revision.repository &&
          ref.commit === input.revision.commit &&
          ref.tree === input.tree,
      );
      if (!approved)
        throw sourceError('SOURCE_SCOPE', 'Dependency overlay differs from its frozen handoff');
      const dependency = await preparedSourceView(env, approved, guard);
      await verifyRoot(approved);
      for (const path of input.paths)
        baseline.set(path, {
          path,
          file: dependency.files.find((file) => file.path === path) ?? null,
        });
    }
  }
  const overrides = [...baseline.values()].sort((a, b) => compareSourcePaths(a.path, b.path));
  await guard();
  const bound = await ledger(env, scope.repo_id, {
    op: 'source_bind',
    job_id: scope.job.id,
    epoch: scope.job.epoch,
    _source_view: view,
    _source_baseline_overrides: overrides,
    ...(readOnly ? { _read_only: true } : {}),
    ...(supervisor ? { _supervisor: true } : {}),
  });
  const binding = bound.binding;
  const actor = bound.actor_grant;
  if (
    !binding ||
    !actor ||
    binding.job_id !== scope.job.id ||
    binding.epoch !== scope.job.epoch ||
    binding.repo_id !== scope.repo_id ||
    actor.claims.workspace_id !== binding.workspace_id ||
    actor.claims.purpose !== (supervisor ? 'supervisor' : 'source') ||
    binding.view_digest !== (await sourceFingerprint({ view, baseline_overrides: overrides })) ||
    (readOnly &&
      (binding.access !== 'read_only' ||
        binding.write_paths?.length !== 0 ||
        binding.scratch_paths?.length !== 0))
  )
    throw sourceError('SOURCE_SCOPE', 'Source binding differs from its native grant');
  await sourceAuthority(env, binding.workspace_id, {
    op: 'source_init',
    request_id: `init:${binding.view_digest}`,
    binding,
    view,
    baseline_overrides: overrides,
    _actor: actor,
  });
  return { binding, view, baseline_overrides: overrides, actor, mount };
}

/** Parent calls after native claim and source readiness, before launch/model egress. */
export async function activateSourceMounts(env: Env, scope: Scope) {
  await ledger(env, scope.repo_id, {
    op: 'check_attempt',
    job_id: scope.job.id,
    epoch: scope.job.epoch,
  });
  const context = (await ledger(env, scope.repo_id, {
    op: 'source_read_context',
    job_id: scope.job.id,
    epoch: scope.job.epoch,
  })) as SourceReadContext;
  const aliases: SourceMount[] =
    context.role === 'reviewer'
      ? (context.source_mounts ?? [])
          .map((item) => item.path)
          .filter(
            (path): path is 'candidate-0' | 'candidate-1' =>
              path === 'candidate-0' || path === 'candidate-1',
          )
      : context.source_resolution === true
        ? ['repo', 'candidate-0', 'candidate-1']
        : ['repo'];
  const mounts = [];
  for (const path of aliases) {
    const source = await sourceScope(env, scope, path);
    mounts.push({
      path,
      workspace_id: source.binding.workspace_id,
      base: source.binding.base,
      view_digest: source.binding.view_digest,
      access: source.binding.access,
      scratch_paths: source.binding.scratch_paths,
    });
  }
  return mounts;
}

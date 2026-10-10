import type { Scope } from './types';

export type GitRole = { repository: string; writable: boolean };

/** Resolve only repositories frozen into this attempt's job payload. */
export function gitRole(scope: Scope, role: string): GitRole | null {
  const job = scope.job;
  if (job.payload?.workspace_transport !== 'git-native-v1') return null;
  const payload = job.payload;
  const refresh = job.kind === 'capture' && payload.capture_subtype === 'refresh_candidate';
  const resolver =
    Boolean(payload.conflict_resolver) &&
    (job.kind === 'agent' ||
      (job.kind === 'capture' && payload.capture_subtype === 'resolve_conflict'));
  let repository: string | undefined;
  if (refresh) {
    if (['current', 'head'].includes(role)) repository = payload.candidate?.base?.repository;
    else if (role === 'candidate') repository = payload.candidate?.revision?.repository;
    else if (role === 'fork') repository = scope.fork;
    else return null;
    return repository ? { repository, writable: role === 'fork' } : null;
  }
  if (resolver && role === 'merge-workspace')
    repository = payload.conflict_resolver.merge_workspace_repository;
  else if (role === 'canonical')
    repository = payload.execution?.base?.repository ?? payload.base?.repository;
  else if (role === 'fork') repository = scope.fork;
  else if (role === 'target')
    repository = payload.candidate?.revision?.repository ?? payload.target?.repository;
  else if (/^team-(0|[1-9]\d*)$/.test(role)) {
    const index = Number(role.slice(5));
    repository = payload.team_inputs?.[index]?.revision?.repository;
  } else return null;
  const canUse =
    (job.kind === 'agent' || job.kind === 'capture' || job.kind === 'evaluate') &&
    (!resolver || ['canonical', 'fork', 'target', 'merge-workspace'].includes(role));
  if (!canUse || !repository) return null;
  return {
    repository,
    writable: role === 'fork' && (job.kind === 'agent' || job.kind === 'capture'),
  };
}

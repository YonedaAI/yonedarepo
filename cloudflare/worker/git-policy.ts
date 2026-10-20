import { comparisonReviewAttempt } from './comparison-scope';
import type { Scope } from './types';

export type GitRole = { repository: string; writable: boolean };

/** Resolve only repositories frozen into this trusted capture's job payload. */
export function gitRole(scope: Scope, role: string): GitRole | null {
  const job = scope.job;
  if (comparisonReviewAttempt(job) || job.payload?.workspace_transport !== 'api-source-v1')
    return null;
  if (job.kind === 'capture' && job.payload.capture_subtype === 'refresh_candidate') {
    if (role === 'fork' && scope.fork) return { repository: scope.fork, writable: true };
    if (role === 'refresh-candidate' && job.payload.candidate?.revision?.repository)
      return { repository: job.payload.candidate.revision.repository, writable: false };
    return null;
  }
  return job.kind === 'capture' &&
    job.payload.capture_subtype === 'source_changeset' &&
    role === 'candidate' &&
    scope.fork
    ? { repository: scope.fork, writable: true }
    : null;
}

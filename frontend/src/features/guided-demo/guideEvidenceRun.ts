import type { GuidedSession } from '../../../../shared/guided-runs';
import { api } from '../../lib/api';
import type { RunDetail, Snapshot } from '../../lib/types';
/** Resolve the exact final candidate from at most the guide's recorded run IDs, never latest-run guessing. */
export async function guideEvidenceRun(
  snapshot: Snapshot,
  session: GuidedSession,
  candidateId: string,
  load = (path: string) => api<RunDetail>(path),
) {
  const owning = session.steps.find(
    (step) => step.candidate_id === candidateId && step.run_ids.length,
  );
  const ids = owning?.run_ids ?? [...new Set(session.steps.flatMap((step) => step.run_ids))];
  const known = snapshot.candidates.find((candidate) => candidate.id === candidateId);
  if (known && ids.includes(known.run_id)) return known.run_id as string;
  for (const id of ids) {
    const detail = await load(
      `repos/${encodeURIComponent(snapshot.repository.id)}/runs/${encodeURIComponent(id)}`,
    );
    if (
      detail.repository.id !== snapshot.repository.id ||
      detail.runs.length !== 1 ||
      detail.runs[0].id !== id
    )
      throw new Error('The guide result belongs to a different project. Refresh its evidence.');
    if (
      detail.candidates.some((candidate) => candidate.id === candidateId && candidate.run_id === id)
    )
      return id;
  }
  throw new Error(
    'The result’s recorded run is not available yet. Refresh the guide before reviewing.',
  );
}

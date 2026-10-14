import { useEffect, useState } from 'react';
import type { GuidedSession } from '../../../../shared/guided-runs';
import { api } from '../../lib/api';
import type { RunDetail, Snapshot } from '../../lib/types';
import { type GuidedRunFacts, guidedRunFacts } from './guidedStepView';

/**
 * Run status and variant for the guide's concurrent and needs-attention steps. The repository
 * snapshot only holds the newest and active runs, so finished or failed guide runs are read once
 * by id; snapshot rows still win because they are the freshest.
 */
export function useGuidedRunFacts(snapshot: Snapshot, session?: GuidedSession) {
  const [fetched, setFetched] = useState<Record<string, GuidedRunFacts>>({});
  const repo = snapshot.repository.id;
  const wanted = (session?.steps ?? [])
    .filter((step) => step.id === 'concurrent' || step.status === 'needs_attention')
    .flatMap((step) => step.run_ids);
  const known = guidedRunFacts(snapshot);
  const missing = wanted.filter((id) => !known[id] && !fetched[id]).join(',');
  useEffect(() => {
    if (!missing) return;
    const controller = new AbortController();
    for (const runId of missing.split(','))
      void api<RunDetail>(
        `repos/${encodeURIComponent(repo)}/runs/${encodeURIComponent(runId)}`,
        undefined,
        { signal: controller.signal },
      )
        .then((detail) => {
          if (controller.signal.aborted || detail.repository.id !== repo) return;
          const facts = guidedRunFacts(detail as unknown as Snapshot)[runId];
          if (facts) setFetched((previous) => ({ ...previous, [runId]: facts }));
        })
        // Labels fall back to "Run N" and a generic reason when a run cannot be read.
        .catch(() => {});
    return () => controller.abort();
  }, [repo, missing]);
  return { ...fetched, ...known };
}

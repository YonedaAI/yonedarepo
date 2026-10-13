import type { Snapshot } from '../../lib/types';
import { comparisonPhase, comparisonState, latestBuilderCandidates } from './comparisonView';

export function ComparisonWorkflow({
  snapshot,
  run,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
}) {
  const comparison = comparisonState(run);
  const candidates = latestBuilderCandidates(snapshot, run);
  const stages = [
    { name: 'Building', detail: `${candidates.length} captured alternatives` },
    {
      name: 'Checking',
      detail: `${candidates.filter((c) => c.evaluation).length} independently checked revisions`,
    },
    {
      name: 'Reviewing alternatives',
      detail: comparison?.latest_review
        ? 'Reviewer assessment recorded'
        : 'Awaiting recorded review',
    },
    { name: 'Repairing', detail: `${comparison?.round ?? 0} of 2 repair rounds used` },
  ];
  return (
    <section className="run-workflow" aria-label="Comparison workflow">
      <strong role="status">{comparisonPhase(snapshot, run)}</strong>
      <ol className="workflow-stages">
        {stages.map((stage) => (
          <li key={stage.name}>
            <strong>{stage.name}</strong>
            <small>{stage.detail}</small>
          </li>
        ))}
      </ol>
      <p className="subtle">
        Builders and the read-only reviewer are separate executions. New repairs require fresh
        capture and checks; publication remains an owner decision.
      </p>
    </section>
  );
}

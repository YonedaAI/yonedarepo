import { GitCompareArrows } from 'lucide-react';
import type { ComparisonAction } from '../../lib/comparison';
import type { Snapshot } from '../../lib/types';
import { IntegrationInputs } from '../team/IntegrationInputs';
import { integratedExecutions } from '../team/teamView';
import { CandidateCard } from './CandidateCard';
import { CandidateComparison } from './CandidateComparison';
import { ComparisonResults } from './ComparisonResults';
import { selectionBlocker } from './runReviewState';

export function RunCandidates({
  snapshot,
  run,
  selected,
  busy,
  comparing,
  candidates,
  onCompare,
  onSelect,
  onProviders,
  onInspectTask,
  onContext,
  onGraph,
  onComparisonAction,
  onRefresh,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  selected: string;
  busy: boolean;
  comparing: boolean;
  candidates: Record<string, any>[];
  onCompare: () => void;
  onSelect: (id: string) => void;
  onProviders?: () => void;
  onInspectTask: (id: string) => void;
  onContext: () => void;
  onGraph: () => void;
  onComparisonAction?: ComparisonAction;
  onRefresh?: () => Promise<void>;
}) {
  const team = run.mode === 'collaborate';
  const repo = snapshot.repository;
  const coding = snapshot.executions.filter(
    (execution) => execution.run_id === run.id && execution.role === 'coding',
  );
  const integrators = team ? integratedExecutions(snapshot, run) : [];
  // A reconciled run shows only the integrator whose result is current, not the superseded one.
  const executions = team
    ? candidates.length
      ? integrators.filter((execution) =>
          candidates.some((item) => item.execution === execution.id),
        )
      : integrators
    : coding;
  if (run.mode === 'compare')
    return (
      <ComparisonResults
        snapshot={snapshot}
        run={run}
        busy={busy}
        onPublish={onSelect}
        onAction={onComparisonAction}
        onRefresh={onRefresh}
        onProviders={onProviders}
        onContext={onContext}
        onGraph={onGraph}
      />
    );
  return (
    <>
      {!team && (
        <div className="comparison-heading" id="approaches">
          <h2>{coding.length === 1 ? 'Review change' : 'Compare approaches'}</h2>
          {coding.length > 1 && (
            <button
              type="button"
              className="quiet"
              disabled={candidates.length < 2}
              aria-expanded={comparing}
              onClick={onCompare}
            >
              <GitCompareArrows size={17} />
              {comparing ? 'Close comparison' : 'Compare changes'}
            </button>
          )}
        </div>
      )}
      {team && !executions.length && (
        <p role="status" className="inline-empty">
          {run.status === 'planning'
            ? 'The team plan is being prepared from your brief. A final integrated result follows the task work and independent checks.'
            : 'The integrated candidate appears after every required specialist output is captured. Open Agent activity for task progress.'}
        </p>
      )}
      {!team && !executions.length && (
        <p role="status" className="inline-empty">
          No captured results yet. Open Agent activity for progress and execution logs.
        </p>
      )}
      <div className="candidate-grid">
        {executions.map((execution) => {
          const candidate = candidates.find((item) => item.execution === execution.id);
          const evaluation = snapshot.evaluations.find((item) => item.id === candidate?.evaluation);
          return (
            <CandidateCard
              key={execution.id}
              strategy={
                team
                  ? candidate?.conflict_id
                    ? 'Reconciled team result'
                    : 'Integrated team result'
                  : execution.strategy
              }
              team={team}
              repo={repo.id}
              execution={execution}
              candidate={candidate}
              evaluation={evaluation}
              decision={snapshot.decisions.find((item) => item.run_id === run.id)}
              selected={!!candidate && selected === candidate.id}
              disabled={busy || !!selectionBlocker(snapshot, run, candidate)}
              disabledReason={selectionBlocker(snapshot, run, candidate)}
              onSelect={() => onSelect(candidate?.id ?? '')}
              onProviders={onProviders}
              snapshot={snapshot}
              run={run}
              onContext={onContext}
              onGraph={onGraph}
            />
          );
        })}
      </div>
      {team &&
        candidates.map((candidate) => (
          <IntegrationInputs
            key={candidate.id}
            candidate={candidate}
            onInspectTask={onInspectTask}
          />
        ))}
      {!team && comparing && (
        <CandidateComparison key={run.id} repo={repo.id} candidates={candidates} />
      )}
    </>
  );
}

import { GitCompareArrows } from 'lucide-react';
import type { Snapshot } from '../../lib/types';
import { IntegrationInputs } from '../team/IntegrationInputs';
import { integratedExecutions } from '../team/teamView';
import { CandidateCard } from './CandidateCard';
import { CandidateComparison } from './CandidateComparison';

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
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  selected: string;
  busy: boolean;
  comparing: boolean;
  candidates: Record<string, any>[];
  onCompare: () => void;
  onSelect: (id: string) => void;
  onProviders: () => void;
}) {
  const team = run.mode === 'collaborate';
  const repo = snapshot.repository;
  const coding = snapshot.executions.filter(
    (execution) => execution.run_id === run.id && execution.role === 'coding',
  );
  const executions = team ? integratedExecutions(snapshot, run) : coding;
  return (
    <>
      <div className="comparison-heading" id="approaches">
        <h2>
          {team
            ? 'Integrated result'
            : coding.length === 1
              ? 'Review change'
              : 'Compare approaches'}
        </h2>
        {!team && coding.length > 1 && (
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
      {team && !executions.length && (
        <p role="status" className="inline-empty">
          The integrated candidate appears after every required specialist output is captured.
          Review task progress above.
        </p>
      )}
      {team &&
        candidates.map((candidate) => (
          <IntegrationInputs key={candidate.id} candidate={candidate} />
        ))}
      <div className="candidate-grid">
        {executions.map((execution) => {
          const candidate = candidates.find((item) => item.execution === execution.id);
          const evaluation = snapshot.evaluations.find((item) => item.id === candidate?.evaluation);
          return (
            <CandidateCard
              key={execution.id}
              strategy={team ? 'Integrated team result' : execution.strategy}
              team={team}
              repo={repo.id}
              execution={execution}
              candidate={candidate}
              evaluation={evaluation}
              decision={snapshot.decisions.find((item) => item.run_id === run.id)}
              selected={!!candidate && selected === candidate.id}
              disabled={
                candidate?.status !== 'eligible' ||
                !!repo.pending ||
                busy ||
                ['accepted', 'cancelled'].includes(run.status) ||
                candidate?.base.commit !== repo.head_commit ||
                evaluation?.policy !== repo.policy?.version
              }
              onSelect={() => onSelect(candidate?.id ?? '')}
              onProviders={onProviders}
            />
          );
        })}
      </div>
      {!team && comparing && <CandidateComparison key={run.id} candidates={candidates} />}
    </>
  );
}

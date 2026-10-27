import { useRef, useState } from 'react';
import '../../styles/comparison.css';
import type { ComparisonAction } from '../../lib/comparison';
import type { Snapshot } from '../../lib/types';
import { CandidateCard } from './CandidateCard';
import { ComparisonAssessment } from './ComparisonAssessment';
import { ComparisonChoiceDialog } from './ComparisonChoiceDialog';
import { createComparisonMutation } from './comparisonMutation';
import {
  comparisonChoiceBlocker,
  comparisonLease,
  comparisonPhase,
  comparisonState,
} from './comparisonView';
import { refreshedSelection } from './refreshedSelection';
import { runHasActiveAttempts } from './runControlState';
import { selectionBlocker } from './runReviewState';
import { runWorkingBranch } from './workingBranchView';

export function ComparisonResults({
  snapshot,
  run,
  busy,
  onPublish,
  onAction,
  onRefresh,
  onProviders,
  onContext,
  onGraph,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  busy: boolean;
  onPublish: (id: string) => void;
  onAction?: ComparisonAction;
  onRefresh?: () => Promise<void>;
  onProviders?: () => void;
  onContext: () => void;
  onGraph: () => void;
}) {
  const [choice, setChoice] = useState('');
  const [acting, setActing] = useState(false);
  // One controller per chosen result keeps its request ID across acknowledgement-loss retries.
  const controller = useRef<ReturnType<typeof createComparisonMutation> | undefined>(undefined);
  const comparison = comparisonState(run);
  const candidates = snapshot.candidates.filter((candidate) => candidate.run_id === run.id);
  const selectedId =
    comparison?.selected_candidate_id ??
    (!comparison ? runWorkingBranch(snapshot, run)?.latest_candidate_id : undefined);
  const selected = snapshot.candidates.find(
    (candidate) => candidate.run_id === run.id && candidate.id === selectedId,
  );
  // Once the selection is refreshed onto a newer main, the refresh is what gets published.
  const refreshed = comparison ? refreshedSelection(snapshot, run) : undefined;
  const choosing = candidates.find((candidate) => candidate.id === choice);
  const locked = busy || acting || runHasActiveAttempts(snapshot, run);
  async function select(input: Record<string, unknown>) {
    if (!onAction || acting) return false;
    controller.current ??= createComparisonMutation(snapshot.repository.id, onAction);
    setActing(true);
    try {
      const done = await controller.current.submit(input);
      if (done) await onRefresh?.();
      return done;
    } finally {
      setActing(false);
    }
  }
  function choose(candidate: Record<string, any>) {
    const blocker = comparisonChoiceBlocker(snapshot, run, candidate);
    return (
      <div className="comparison-choice">
        <button
          type="button"
          className="quiet"
          disabled={locked || !onAction || !!blocker}
          onClick={() => {
            controller.current = undefined;
            setChoice(candidate.id);
          }}
        >
          Use this result
        </button>
        {blocker && <p className="selection-blocker">{blocker}</p>}
      </div>
    );
  }
  function card(
    candidate: Record<string, any>,
    index: number,
    primary: boolean,
    superseded = false,
  ) {
    const execution = snapshot.executions.find((item) => item.id === candidate.execution);
    const evaluation = snapshot.evaluations.find((item) => item.id === candidate.evaluation);
    const blocker = selectionBlocker(snapshot, run, candidate);
    return (
      <CandidateCard
        repo={snapshot.repository.id}
        snapshot={snapshot}
        run={run}
        strategy={
          superseded
            ? 'Superseded selection (older main)'
            : primary && candidate.id === refreshed?.id
              ? 'Selected output, refreshed onto current main'
              : primary
                ? comparison
                  ? 'Selected output'
                  : 'Checked result'
                : `Alternative ${index + 1}`
        }
        execution={execution}
        candidate={candidate}
        evaluation={evaluation}
        decision={snapshot.decisions.find((item) => item.run_id === run.id)}
        selected={primary}
        disabled={locked || !!blocker}
        disabledReason={blocker}
        showPublishAction={primary}
        actionLabel={comparison ? 'Publish result' : 'Record publishing decision'}
        assessment={primary ? <ComparisonAssessment comparison={comparison} /> : undefined}
        compact
        onSelect={() => onPublish(candidate.id)}
        onProviders={onProviders}
        onContext={onContext}
        onGraph={onGraph}
      />
    );
  }
  return (
    <section className="comparison-results" aria-label="Comparison results">
      <header className="comparison-result-heading">
        <h2>Compare results</h2>
        <strong role="status">{comparisonPhase(snapshot, run)}</strong>
      </header>
      {run.status === 'cancelled' && (
        <p role="alert">
          This run was cancelled. Recorded source and checks remain available; selection and
          publication are disabled.
        </p>
      )}
      {refreshed && card(refreshed, 0, true)}
      {selected && card(selected, candidates.indexOf(selected), !refreshed, !!refreshed)}
      {selected && !refreshed && choose(selected)}
      <div className="comparison-alternatives">
        {candidates
          .filter((candidate) => candidate.id !== selected?.id && candidate.id !== refreshed?.id)
          .map((candidate) => (
            <section key={candidate.id}>
              {card(candidate, candidates.indexOf(candidate), false)}
              {choose(candidate)}
            </section>
          ))}
      </div>
      {!candidates.length && (
        <p role="status">No captured alternatives yet. Follow their progress in Agent activity.</p>
      )}
      {choosing && (
        <ComparisonChoiceDialog
          candidate={choosing}
          busy={busy || acting}
          uncertain={controller.current?.uncertain ?? false}
          blocker={comparisonChoiceBlocker(snapshot, run, choosing)}
          onClose={() => setChoice('')}
          onChoose={(reason) =>
            select({
              ...comparisonLease(snapshot, run),
              candidate_id: choosing.id,
              reason,
              expected_selection_version: comparison?.selection_version ?? 0,
            })
          }
        />
      )}
    </section>
  );
}

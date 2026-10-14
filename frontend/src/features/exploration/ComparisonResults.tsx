import { useRef, useState } from 'react';
import '../../styles/comparison.css';
import type { ComparisonAction, ComparisonOwnerOperation } from '../../lib/comparison';
import type { Snapshot } from '../../lib/types';
import { CandidateCard } from './CandidateCard';
import { ComparisonAssessment } from './ComparisonAssessment';
import { ComparisonChoiceDialog } from './ComparisonChoiceDialog';
import { createComparisonMutation } from './comparisonMutation';
import { comparisonSkipNotice } from './comparisonSkipNotice';
import {
  comparisonBusy,
  comparisonChoiceBlocker,
  comparisonLease,
  comparisonPhase,
  comparisonState,
  latestBuilderCandidates,
} from './comparisonView';
import { LegacyReviewApproval } from './LegacyReviewApproval';
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
  const [reviewing, setReviewing] = useState(false);
  const [choice, setChoice] = useState('');
  const [acting, setActing] = useState(false);
  const controllers = useRef(
    new Map<ComparisonOwnerOperation, ReturnType<typeof createComparisonMutation>>(),
  );
  const comparison = comparisonState(run);
  const skip = comparisonSkipNotice(comparison);
  const skipped = !!skip;
  const builderCandidates = latestBuilderCandidates(snapshot, run);
  const candidates = comparison?.approval
    ? builderCandidates
    : snapshot.candidates.filter((candidate) => candidate.run_id === run.id);
  const originalBuilders = snapshot.executions.filter(
    (execution) =>
      execution.run_id === run.id &&
      execution.role === 'coding' &&
      !execution.parent_execution &&
      execution.comparison_role !== 'repair',
  );
  const originals = snapshot.executions.filter((execution) => execution.run_id === run.id);
  const delegated =
    (run.delegation?.enabled === true &&
      (!Number.isSafeInteger(run.delegation.max_executions) ||
        run.delegation.max_executions > 2)) ||
    originals.length !== 2 ||
    ![1, 2].every((index) =>
      originals.some(
        (execution) =>
          execution.id === `${run.id}:agent-${index}` &&
          execution.role === 'coding' &&
          !execution.parent_execution &&
          (execution.depth == null || execution.depth === 0),
      ),
    );
  const reviewCompatible = originalBuilders.length === 2 && !delegated;
  const selectedId =
    comparison?.selected_candidate_id ??
    (!comparison ? runWorkingBranch(snapshot, run)?.latest_candidate_id : undefined);
  const selected = snapshot.candidates.find(
    (candidate) => candidate.run_id === run.id && candidate.id === selectedId,
  );
  const choosing = candidates.find((candidate) => candidate.id === choice);
  const locked = busy || acting || comparisonBusy(snapshot, run);
  const reviewController = controllers.current.get('approve_comparison_review');
  const chooseController = controllers.current.get('select_comparison_candidate');
  const reviewCandidates = builderCandidates;
  const reviewBlocker = delegated
    ? 'Automatic review requires two original builders without delegated or additional executions. Choose a checked result manually.'
    : originalBuilders.length !== 2 || reviewCandidates.length !== 2
      ? 'Review needs exactly two captured alternatives.'
      : reviewCandidates
          .map((candidate) => comparisonChoiceBlocker(snapshot, run, candidate, true))
          .find(Boolean);
  async function act(operation: ComparisonOwnerOperation, input: Record<string, unknown>) {
    if (!onAction || acting) return false;
    let controller = controllers.current.get(operation);
    if (!controller) {
      controller = createComparisonMutation(snapshot.repository.id, operation, onAction);
      controllers.current.set(operation, controller);
    }
    setActing(true);
    try {
      const done = await controller.submit(input);
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
            controllers.current.delete('select_comparison_candidate');
            setChoice(candidate.id);
          }}
        >
          {comparison?.approval && selected ? 'Use other result' : 'Use this result'}
        </button>
        {blocker && <p className="selection-blocker">{blocker}</p>}
      </div>
    );
  }
  function card(candidate: Record<string, any>, index: number, primary: boolean) {
    const execution = snapshot.executions.find((item) => item.id === candidate.execution);
    const evaluation = snapshot.evaluations.find((item) => item.id === candidate.evaluation);
    const blocker = selectionBlocker(snapshot, run, candidate);
    return (
      <CandidateCard
        repo={snapshot.repository.id}
        snapshot={snapshot}
        run={run}
        strategy={
          primary ? (comparison ? 'Selected output' : 'Checked result') : `Alternative ${index + 1}`
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
      {!comparison?.approval && (
        <p>
          These results have not been automatically reviewed. You can choose a checked result
          yourself{reviewCompatible ? ' or approve a review.' : '.'}
        </p>
      )}
      {comparison?.status === 'needs_attention' && !skipped && run.status !== 'cancelled' && (
        <p role="alert">
          Automatic review stopped without a new winner. Inspect the checks and recorded reasons;
          eligible results can still be chosen manually.
        </p>
      )}
      {run.status === 'cancelled' && (
        <p role="alert">
          This run was cancelled. Recorded source and checks remain available; selection and
          publication are disabled.
        </p>
      )}
      {comparison?.status === 'stale' && (
        <p role="alert">
          The source, policy or selection changed. The prior proposal remains history; refresh
          current evidence before publishing.
        </p>
      )}
      {comparison?.status === 'repairing' && (
        <p>
          A promising alternative is being repaired (round {comparison.round} of 2). Its new source
          must pass fresh checks before another review.
        </p>
      )}
      {selected && card(selected, candidates.indexOf(selected), true)}
      {selected && !comparison?.approval && choose(selected)}
      {!selected && <ComparisonAssessment comparison={comparison} />}
      {!comparison?.approval && reviewCompatible && (
        <button
          type="button"
          className="quiet"
          disabled={locked || !onAction || !!reviewBlocker}
          onClick={() => setReviewing(true)}
        >
          Review now
        </button>
      )}
      {reviewBlocker && !comparison?.approval && originalBuilders.length === 2 && (
        <p className="subtle">{reviewBlocker}</p>
      )}
      <div className="comparison-alternatives">
        {candidates
          .filter((candidate) => candidate.id !== selected?.id)
          .map((candidate) => (
            <section key={candidate.id}>
              {card(candidate, candidates.indexOf(candidate), false)}
              {choose(candidate)}
            </section>
          ))}
      </div>
      {!candidates.length && (
        <p role="status">
          {skip?.code === 'CAPTURE_RECOVERY_CHECK_ONLY'
            ? 'Checked captures are recorded. Refresh status to load their source and check evidence.'
            : skipped
              ? 'No checked alternative was produced. Recorded failures remain in Agent activity.'
              : 'No captured alternatives yet. Follow their progress in Agent activity.'}
        </p>
      )}
      {reviewing && (
        <LegacyReviewApproval
          goal={run.intent}
          candidates={reviewCandidates}
          busy={busy || acting}
          uncertain={reviewController?.uncertain}
          blocker={reviewBlocker}
          onClose={() => setReviewing(false)}
          onApprove={() => act('approve_comparison_review', comparisonLease(snapshot, run))}
        />
      )}
      {choosing && (
        <ComparisonChoiceDialog
          candidate={choosing}
          reviewed={!!selected && !!comparison?.latest_review}
          busy={busy || acting}
          uncertain={chooseController?.uncertain ?? false}
          blocker={comparisonChoiceBlocker(snapshot, run, choosing)}
          onClose={() => setChoice('')}
          onChoose={(reason) =>
            act('select_comparison_candidate', {
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

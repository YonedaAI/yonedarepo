import { lazy, Suspense, useEffect, useState } from 'react';
import type { ComparisonAction } from '../../lib/comparison';
import type { Snapshot } from '../../lib/types';
import { RunSourceProgress } from '../source-workspace/RunSourceProgress';
import { TeamWorkflow } from '../team/TeamWorkflow';
import { AgentActivityTimeline } from './AgentActivityTimeline';
import { AgentConversation } from './AgentConversation';
import { AgentWorkSummary } from './AgentWorkSummary';
import { comparisonState } from './comparisonView';
import { ExecutionHierarchy } from './ExecutionHierarchy';
import { IntentQuestion } from './IntentQuestion';
import { PublishingDecision } from './PublishingDecision';
import { RejectDialog } from './RejectDialog';
import { RunAttention } from './RunAttention';
import { RunCandidates } from './RunCandidates';
import { RunDetailsPanel } from './RunDetailsPanel';
import { RunOverviewHeader } from './RunOverviewHeader';
import { type RunTab, RunTabs } from './RunTabs';
import { canCancelRun, runHasActiveAttempts } from './runControlState';
import { runCandidates } from './runResults';
import { selectionBlocker } from './runReviewState';
import { StaleCandidateRepair } from './StaleCandidateRepair';
import '../../styles/review-work.css';
import { WorkingBranchPanel } from './WorkingBranchPanel';
import type { WorkingBranch } from './workingBranchView';

const ContextUsagePanel = lazy(() =>
  import('../context-usage/ContextUsagePanel').then((module) => ({
    default: module.ContextUsagePanel,
  })),
);

export function RunDetail({
  reviewer = false,
  snapshot,
  run,
  busy,
  canStart,
  onSelectRun,
  onRestart,
  onCancel,
  onRetry,
  onRepairTask,
  onAccept,
  onProviders,
  onContext,
  onContinueBranch,
  onAnswerIntent,
  onComparisonAction,
  onRefresh,
  onReject,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  run: Record<string, any>;
  busy: boolean;
  canStart: boolean;
  onSelectRun: (id: string) => void;
  onRestart: () => void;
  onCancel: () => void;
  onRetry: (task: Record<string, any>) => void;
  onRepairTask: (request: Record<string, unknown>) => Promise<boolean>;
  onAccept: (
    candidate: string,
    rationale: string,
    alternatives: { candidate: string; reason: string }[],
  ) => Promise<boolean>;
  onProviders?: () => void;
  onContext: () => void;
  onContinueBranch?: (branch: WorkingBranch) => void;
  onAnswerIntent?: (question: string, answer: string) => Promise<boolean>;
  onComparisonAction?: ComparisonAction;
  onRefresh?: () => Promise<void>;
  onReject?: (candidate: string, reason: string) => Promise<boolean>;
}) {
  const [tab, setTab] = useState<RunTab>('results');
  const [focusTarget, setFocusTarget] = useState('');
  const [selected, setSelected] = useState('');
  const [comparing, setComparing] = useState(false);
  const [rejecting, setRejecting] = useState('');
  const [resultFocus, setResultFocus] = useState<{ candidate: string; request: number }>();
  const team = run.mode === 'collaborate';
  const activeAttempts = runHasActiveAttempts(snapshot, run);
  const coding = snapshot.executions.filter(
    (execution) => execution.run_id === run.id && execution.role === 'coding',
  );
  const roots = coding.filter(
    (execution) => !execution.parent_execution && execution.comparison_role !== 'repair',
  ).length;
  const previousRun =
    run.restart_of ??
    snapshot.decisions.find((decision) => decision.id === run.continuation_of)?.run_id;
  const candidates: Record<string, any>[] = runCandidates(snapshot, run).map((candidate) => ({
    ...candidate,
    strategy: team
      ? candidate.conflict_id
        ? 'Reconciled team result'
        : 'Integrated team result'
      : (snapshot.executions.find((execution) => execution.id === candidate.execution)?.strategy ??
        candidate.summary),
  }));
  const chosen = candidates.find((candidate) => candidate.id === selected);
  const blocker = selected ? selectionBlocker(snapshot, run, chosen) : undefined;
  function review(id: string) {
    setSelected(id);
  }
  function openEvidence(next: RunTab, target = `run-panel-${next}`) {
    setTab(next);
    setFocusTarget(target);
  }
  // Each inspect request reveals the exact result again, even when Results is already open.
  function openResult(candidate: string) {
    setTab('results');
    setResultFocus((current) => ({ candidate, request: (current?.request ?? 0) + 1 }));
  }
  useEffect(() => {
    if (!focusTarget) return;
    const element = document.getElementById(focusTarget);
    element?.focus();
    element?.scrollIntoView({ block: 'nearest' });
    setFocusTarget('');
  }, [focusTarget]);
  return (
    <>
      <RunOverviewHeader
        run={run}
        roots={roots}
        subagents={coding.length - roots}
        previousRun={previousRun}
        onSelectRun={onSelectRun}
      />
      <RunSourceProgress snapshot={snapshot} run={run} busy={busy} onRefresh={onRefresh} />
      <IntentQuestion
        key={`${run.intent_question?.id}:${run.intent_question?.status}`}
        run={run}
        reviewer={reviewer}
        busy={busy}
        onAnswer={onAnswerIntent}
      />
      <RunAttention
        snapshot={snapshot}
        run={run}
        busy={busy}
        onCancel={canCancelRun(run, activeAttempts) ? onCancel : undefined}
        onAction={(action, candidate) => {
          if ((action === 'review' || action === 'results') && candidate) openResult(candidate);
          else if (action === 'review') openEvidence('results');
          else if (
            action === 'details' &&
            snapshot.decisions.some((decision) => decision.run_id === run.id)
          )
            openEvidence('details', 'recorded-shipping-decision');
          else openEvidence(action);
        }}
      />
      <WorkingBranchPanel
        snapshot={snapshot}
        run={run}
        reviewer={reviewer}
        busy={busy}
        canStart={canStart}
        onContinue={onContinueBranch}
      />
      <RunTabs active={tab} onSelect={setTab}>
        {(panel) =>
          panel === 'results' ? (
            <>
              <StaleCandidateRepair
                reviewer={reviewer}
                snapshot={snapshot}
                run={run}
                busy={busy}
                canStart={canStart}
                onRepair={onRestart}
              />
              <RunCandidates
                snapshot={snapshot}
                run={run}
                selected={selected}
                busy={busy}
                comparing={comparing}
                candidates={candidates}
                onCompare={() => setComparing(!comparing)}
                onSelect={review}
                onProviders={reviewer ? undefined : onProviders}
                onInspectTask={(id) => openEvidence('activity', `team-task-${id}`)}
                onContext={() => openEvidence('context')}
                onGraph={onContext}
                onComparisonAction={onComparisonAction}
                onRefresh={onRefresh}
                onReject={onReject ? setRejecting : undefined}
                focus={resultFocus}
              />
              <AgentWorkSummary
                snapshot={snapshot}
                run={run}
                onInspect={() => openEvidence('activity')}
              />
            </>
          ) : panel === 'activity' ? (
            <>
              <AgentConversation
                key={run.id}
                snapshot={snapshot}
                run={run}
                onContext={() => openEvidence('context')}
              />
              <AgentActivityTimeline snapshot={snapshot} run={run} />
              {team ? (
                <TeamWorkflow
                  reviewer={reviewer}
                  snapshot={snapshot}
                  run={run}
                  busy={busy}
                  onProviders={reviewer ? undefined : onProviders}
                  onRetry={onRetry}
                  onRepair={onRepairTask}
                />
              ) : (
                <ExecutionHierarchy
                  snapshot={snapshot}
                  run={run}
                  onInspect={(id) => openEvidence('results', `approach-${id}`)}
                />
              )}
            </>
          ) : panel === 'context' ? (
            <>
              <button type="button" className="text-button context-link" onClick={onContext}>
                Read this run’s evidence trail
              </button>
              <Suspense fallback={<p role="status">Loading context evidence…</p>}>
                <ContextUsagePanel key={run.id} snapshot={snapshot} run={run} />
              </Suspense>
            </>
          ) : (
            <RunDetailsPanel
              reviewer={reviewer}
              snapshot={snapshot}
              run={run}
              busy={busy}
              canStart={canStart}
              activeAttempts={activeAttempts}
              hasRoots={roots > 0 || (team && !!run.agents?.length)}
              onRestart={onRestart}
              onCancel={onCancel}
            />
          )
        }
      </RunTabs>
      {rejecting && onReject && candidates.some((item) => item.id === rejecting) && (
        <RejectDialog
          key={rejecting}
          candidate={candidates.find((item) => item.id === rejecting) ?? {}}
          busy={busy}
          onClose={() => setRejecting('')}
          onReject={onReject}
        />
      )}
      {selected && (
        <PublishingDecision
          key={selected}
          chosen={chosen}
          candidates={candidates}
          busy={busy}
          blocker={blocker}
          onClose={() => setSelected('')}
          onAccept={onAccept}
          comparison={comparisonState(run)}
        />
      )}
    </>
  );
}

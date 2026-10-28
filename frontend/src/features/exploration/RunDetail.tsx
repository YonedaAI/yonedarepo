import { lazy, Suspense, useEffect, useState } from 'react';
import type { ComparisonAction } from '../../lib/comparison';
import type { Snapshot } from '../../lib/types';
import { RunSourceProgress } from '../source-workspace/RunSourceProgress';
import { SandboxTeam } from '../team/SandboxTeam';
import { AgentActivityTimeline } from './AgentActivityTimeline';
import { AgentWorkSummary } from './AgentWorkSummary';
import { comparisonState } from './comparisonView';
import { ExecutionHierarchy } from './ExecutionHierarchy';
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
import { isSandboxTeam } from './sandboxActivityView';
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
  onDelete,
  onAccept,
  onProviders,
  onContext,
  onContinueBranch,
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
  onDelete?: () => void;
  onAccept: (
    candidate: string,
    rationale: string,
    alternatives: { candidate: string; reason: string }[],
  ) => Promise<boolean>;
  onProviders?: () => void;
  onContext: () => void;
  onContinueBranch?: (branch: WorkingBranch) => void;
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
  const roots = snapshot.executions.filter(
    (execution) => execution.run_id === run.id && execution.role === 'coding',
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
        previousRun={previousRun}
        onSelectRun={onSelectRun}
      />
      <RunSourceProgress snapshot={snapshot} run={run} busy={busy} onRefresh={onRefresh} />
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
              <AgentActivityTimeline snapshot={snapshot} run={run} />
              {isSandboxTeam(run) ? (
                <section className="team-workflow" aria-labelledby="team-workflow-heading">
                  <h2 id="team-workflow-heading">Build together</h2>
                  <SandboxTeam
                    snapshot={snapshot}
                    run={run}
                    onProviders={reviewer ? undefined : onProviders}
                  />
                </section>
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
              onDelete={onDelete}
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

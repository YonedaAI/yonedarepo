import { lazy, Suspense, useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { TeamWorkflow } from '../team/TeamWorkflow';
import { runCandidates } from '../team/teamView';
import { AgentActivityTimeline } from './AgentActivityTimeline';
import { DecisionForm } from './DecisionForm';
import { ExecutionHierarchy } from './ExecutionHierarchy';
import { ModelBudgetUsage } from './ModelBudgetUsage';
import { RunAttention } from './RunAttention';
import { RunBrief } from './RunBrief';
import { RunCandidates } from './RunCandidates';
import { RunControls } from './RunControls';
import { type RunTab, RunTabs } from './RunTabs';
import { RunWorkflow } from './RunWorkflow';
import { runHasActiveAttempts } from './runControlState';
import { runAttention, selectionBlocker } from './runReviewState';
import { runTitle } from './runTitle';
import { StaleCandidateRepair } from './StaleCandidateRepair';

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
}) {
  const [tab, setTab] = useState<RunTab>(() =>
    runAttention(snapshot, run).action === 'activity' ? 'activity' : 'results',
  );
  const [focusTarget, setFocusTarget] = useState('');
  const [selected, setSelected] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const [comparing, setComparing] = useState(false);
  const repo = snapshot.repository;
  const team = run.mode === 'collaborate';
  const activeAttempts = runHasActiveAttempts(snapshot, run);
  const coding = snapshot.executions.filter(
    (execution) => execution.run_id === run.id && execution.role === 'coding',
  );
  const roots = coding.filter((execution) => !execution.parent_execution).length;
  const previousRun =
    run.restart_of ??
    snapshot.decisions.find((decision) => decision.id === run.continuation_of)?.run_id;
  const candidates: Record<string, any>[] = runCandidates(snapshot, run).map((candidate) => ({
    ...candidate,
    strategy: team
      ? 'Integrated team result'
      : (snapshot.executions.find((execution) => execution.id === candidate.execution)?.strategy ??
        candidate.summary),
  }));
  const chosen = candidates.find((candidate) => candidate.id === selected);
  const blocker = selected ? selectionBlocker(snapshot, run, chosen) : undefined;
  function review(id: string) {
    setSelectionError('');
    setSelected(id);
  }
  function openEvidence(next: RunTab, target = `run-panel-${next}`) {
    setTab(next);
    setFocusTarget(target);
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
      <div className="intent-row">
        <div className="run-heading">
          <h2>{runTitle(run.intent)}</h2>
          <div className="run-meta">
            <span>
              Base <code>{short(run.base.commit)}</code>
            </span>
            <span>
              {team
                ? `${run.agents?.length ?? roots} team agents · Build together`
                : `${roots} root agents · ${coding.length - roots} subagents`}
            </span>
            {previousRun && (
              <button
                type="button"
                className="text-button"
                onClick={() => onSelectRun(previousRun)}
              >
                {run.continuation_of ? 'View published base' : 'View previous run'}
              </button>
            )}
          </div>
        </div>
      </div>
      <RunAttention
        snapshot={snapshot}
        run={run}
        busy={busy}
        onAction={(action, candidate) => {
          if (action === 'review' && candidate) review(candidate);
          else if (
            action === 'details' &&
            snapshot.decisions.some((decision) => decision.run_id === run.id)
          )
            openEvidence('details', 'recorded-shipping-decision');
          else openEvidence(action === 'review' ? 'results' : action);
        }}
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
              />
            </>
          ) : panel === 'activity' ? (
            <>
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
            <>
              <div className="run-detail-controls">
                <div>
                  <h3>Run controls</h3>
                  <p>
                    Recorded status: {run.status.replaceAll('_', ' ')}
                    {reviewer
                      ? '.'
                      : activeAttempts
                        ? '. Finish or cancel active work before restarting.'
                        : '. Restart opens a new attempt with these settings.'}
                  </p>
                </div>
                <RunControls
                  reviewer={reviewer}
                  run={run}
                  busy={busy}
                  canStart={canStart}
                  activeAttempts={activeAttempts}
                  hasRoots={roots > 0 || (team && !!run.agents?.length)}
                  supportsRestart={snapshot.capabilities?.model_budgets === 1}
                  onRestart={onRestart}
                  onCancel={onCancel}
                />
              </div>
              <RunBrief intent={run.intent} criteria={run.criteria} />
              <RunWorkflow snapshot={snapshot} run={run} />
              <p className="subtle">
                Independent evaluator: {repo.policy?.suite ?? 'configured policy'}
              </p>
              <ModelBudgetUsage run={run} />
            </>
          )
        }
      </RunTabs>
      {selected && (
        <Dialog
          initialFocus="textarea"
          title="Review shipping decision"
          onClose={() => setSelected('')}
          locked={busy}
        >
          <p className="selection-summary">
            <strong>{chosen?.strategy}</strong>
            <br />
            Exact revision <code>{short(chosen?.revision?.commit)}</code>
          </p>
          {(selectionError || blocker) && (
            <p role="alert" className="form-error">
              {selectionError || blocker}
            </p>
          )}
          <DecisionForm
            key={selected}
            busy={busy}
            blocked={!!blocker}
            alternatives={candidates.filter((candidate) => candidate.id !== selected)}
            onClose={() => setSelected('')}
            onAccept={async (rationale, alternatives) => {
              if (blocker) return;
              try {
                if (await onAccept(selected, rationale, alternatives)) setSelected('');
              } catch (error) {
                setSelectionError((error as Error).message);
              }
            }}
          />
        </Dialog>
      )}
    </>
  );
}

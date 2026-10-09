import { lazy, Suspense, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { api, short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { runCandidates } from '../team/teamView';
import { DecisionForm } from './DecisionForm';
import { ExecutionHierarchy } from './ExecutionHierarchy';
import { ModelBudgetUsage } from './ModelBudgetUsage';
import { RunBrief } from './RunBrief';
import { RunCandidates } from './RunCandidates';
import { RunControls } from './RunControls';
import { RunHistory } from './RunHistory';
import { RunToolbar } from './RunToolbar';
import { RunWorkflow } from './RunWorkflow';
import { initialRun } from './restartRun';
import { runHasActiveAttempts } from './runControlState';
import { hasPublishedWork } from './runDefaults';
import { runTitle } from './runTitle';

const RunComposer = lazy(() =>
  import('./RunComposer').then((module) => ({ default: module.RunComposer })),
);
const TeamWorkflow = lazy(() =>
  import('../team/TeamWorkflow').then((module) => ({ default: module.TeamWorkflow })),
);
const ContextUsagePanel = lazy(() =>
  import('../context-usage/ContextUsagePanel').then((module) => ({
    default: module.ContextUsagePanel,
  })),
);

export function Exploration({
  snapshot,
  onChange,
  onError,
  onProviders,
  onAgents,
  onContext,
}: {
  snapshot: Snapshot;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
  onProviders: () => void;
  onAgents: () => void;
  onContext: () => void;
}) {
  const [selectionError, setSelectionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const [runId, setRunId] = useState('');
  const [composing, setComposing] = useState(false);
  const [restartId, setRestartId] = useState('');
  const [comparing, setComparing] = useState(false);
  const repo = snapshot.repository;
  const run = snapshot.runs.find((r) => r.id === runId) ?? snapshot.runs.at(-1);
  const publishedRun = snapshot.decisions.some(
    (d) => d.run_id === run?.id && d.status === 'published',
  );
  const candidates = runCandidates(snapshot, run);
  const coding = snapshot.executions.filter((e) => e.run_id === run?.id && e.role === 'coding');
  const roots = coding.filter((e) => !e.parent_execution).length;
  const team = run?.mode === 'collaborate';
  const activeAttempts = runHasActiveAttempts(snapshot, run);
  const restartSource = snapshot.runs.find((record) => record.id === restartId);
  const previousRun =
    run?.restart_of ??
    snapshot.decisions.find((decision) => decision.id === run?.continuation_of)?.run_id;
  const codeCandidates: Record<string, any>[] = candidates.map((c) => ({
    ...c,
    strategy: team
      ? 'Integrated team result'
      : (snapshot.executions.find((e) => e.id === c.execution)?.strategy ?? c.summary),
  }));
  const canStart = !busy && !repo.pending && repo.status === 'ready';
  async function act(action: string, body: unknown): Promise<boolean> {
    setBusy(true);
    try {
      await api(`repos/${repo.id}/${action}`, body);
      await onChange();
      setSelected('');
      return true;
    } catch (e) {
      if (action === 'start_run') throw e;
      if (action === 'accept') setSelectionError((e as Error).message);
      else onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="exploration">
      <RunToolbar
        snapshot={snapshot}
        canStart={canStart}
        onNewRun={() => {
          setRestartId('');
          setComposing(true);
        }}
      />
      {composing && (
        <Dialog
          title={
            restartSource
              ? 'Restart development run'
              : hasPublishedWork(snapshot)
                ? repo.site
                  ? 'Update website'
                  : 'Update project'
                : 'New development run'
          }
          onClose={() => setComposing(false)}
          locked={busy}
          wide
        >
          <Suspense fallback={<p role="status">Loading run settings…</p>}>
            <RunComposer
              key={restartSource?.id ?? 'new-run'}
              initialRun={restartSource ? initialRun(snapshot, restartSource) : undefined}
              busy={busy}
              onProviders={() => {
                setComposing(false);
                onProviders();
              }}
              snapshot={snapshot}
              onClose={() => setComposing(false)}
              onStart={async (brief) => {
                const id = `run-${crypto.randomUUID()}`;
                if (await act('start_run', { id, ...brief })) {
                  setRunId(id);
                  setComposing(false);
                  setRestartId('');
                  setComparing(false);
                }
              }}
            />
          </Suspense>
        </Dialog>
      )}
      {run ? (
        <>
          <RunHistory
            runs={snapshot.runs}
            selected={run.id}
            onSelect={(id) => {
              setRunId(id);
              setSelected('');
              setComparing(false);
            }}
          />
          <div className="intent-row">
            <div className="run-heading">
              <h2>{runTitle(run.intent)}</h2>
              <div className="run-meta">
                <span className={`status ${run.status}`}>
                  {publishedRun ? 'published' : run.status}
                </span>
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
                    onClick={() => {
                      setRunId(previousRun);
                      setSelected('');
                      setComparing(false);
                    }}
                  >
                    {run.continuation_of ? 'View published base' : 'View previous run'}
                  </button>
                )}
              </div>
            </div>
            <RunControls
              run={run}
              busy={busy}
              canStart={canStart}
              activeAttempts={activeAttempts}
              hasRoots={roots > 0 || (team && !!run.agents?.length)}
              supportsRestart={snapshot.capabilities?.model_budgets === 1}
              onRestart={() => {
                setRestartId(run.id);
                setComposing(true);
              }}
              onCancel={() => void act('cancel_run', { run_id: run.id })}
            />
          </div>
          <RunBrief key={run.id} intent={run.intent} criteria={run.criteria} />
          {publishedRun && !activeAttempts && (
            <p className="subtle">
              This published run is recorded history. Choose Update{' '}
              {repo.site ? 'website' : 'project'} to continue from the published approach and
              context.
            </p>
          )}
          {activeAttempts && (
            <p className="subtle">Finish or cancel active attempts to restart this run.</p>
          )}
          <RunWorkflow snapshot={snapshot} run={run} />
          <Suspense fallback={<p role="status">Loading context evidence…</p>}>
            <ContextUsagePanel key={run.id} snapshot={snapshot} run={run} />
          </Suspense>
          <ModelBudgetUsage run={run} />
          {team ? (
            <Suspense fallback={<p role="status">Loading team tasks…</p>}>
              <TeamWorkflow
                snapshot={snapshot}
                run={run}
                busy={busy}
                onProviders={onProviders}
                onRetry={(task) =>
                  void act('retry_team_task', {
                    run_id: run.id,
                    task_id: task.task_id,
                    expected_epoch: task.epoch,
                    expected_revision: task.revision,
                  })
                }
              />
            </Suspense>
          ) : (
            <ExecutionHierarchy snapshot={snapshot} run={run} />
          )}
          <button type="button" className="text-button context-link" onClick={onContext}>
            Explore this repository’s context →
          </button>
          <RunCandidates
            snapshot={snapshot}
            run={run}
            selected={selected}
            busy={busy}
            comparing={comparing}
            candidates={codeCandidates}
            onCompare={() => setComparing(!comparing)}
            onSelect={(id) => {
              setSelectionError('');
              setSelected(id);
            }}
            onProviders={onProviders}
          />
          {selected && (
            <Dialog
              initialFocus="textarea"
              title="Review shipping decision"
              onClose={() => setSelected('')}
              locked={busy}
            >
              <p className="selection-summary">
                <strong>{codeCandidates.find((c) => c.id === selected)?.strategy}</strong>
                <br />
                Exact revision{' '}
                <code>{short(candidates.find((c) => c.id === selected)?.revision.commit)}</code>
              </p>
              {selectionError && (
                <p role="alert" className="form-error">
                  {selectionError}
                </p>
              )}
              <DecisionForm
                key={selected}
                busy={busy}
                alternatives={codeCandidates.filter((c) => c.id !== selected)}
                onClose={() => setSelected('')}
                onAccept={async (rationale, alternatives) => {
                  await act('accept', {
                    request_id: crypto.randomUUID(),
                    candidate: selected,
                    expected_commit: repo.head_commit,
                    expected_version: repo.version,
                    rationale,
                    alternatives,
                  });
                }}
              />
            </Dialog>
          )}
        </>
      ) : (
        <div className="empty-run">
          <h2>What will you build next?</h2>
          <p>
            Start concurrent agents with a shared brief, or connect your local agent to contribute
            code and context.
          </p>
          <button type="button" className="quiet" onClick={onAgents}>
            Connect local agent
          </button>
        </div>
      )}
    </section>
  );
}

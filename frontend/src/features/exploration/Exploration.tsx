import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { api } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { PendingReviews } from './RunAttention';
import { RunEvidenceBoundary } from './RunEvidenceBoundary';
import { RunHistory } from './RunHistory';
import { RunToolbar } from './RunToolbar';
import { type InitialRun, initialRun } from './restartRun';
import { hasPublishedWork } from './runDefaults';
import { supportsWorkingBranches, type WorkingBranch, workingBranches } from './workingBranchView';
import { workingRun } from './workingRun';

const RunComposer = lazy(() =>
  import('./RunComposer').then((module) => ({ default: module.RunComposer })),
);
const RunDetail = lazy(() =>
  import('./RunDetail').then((module) => ({ default: module.RunDetail })),
);

export function Exploration({
  reviewer = false,
  snapshot,
  onChange,
  onError,
  onProviders,
  onAgents,
  onContext,
  onSelectedRun,
  initialRunId = '',
  requestedRunError = '',
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
  onProviders: () => void;
  onAgents: () => void;
  onContext: (runId: string) => void;
  onSelectedRun: (runId: string) => void;
  initialRunId?: string;
  requestedRunError?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState(initialRunId);
  const [composing, setComposing] = useState(false);
  const [restartId, setRestartId] = useState('');
  const [branchSource, setBranchSource] = useState<InitialRun>();
  const openingBranch = useRef(false);
  const createdBranch = useRef<WorkingBranch | null>(null);
  const repo = snapshot.repository;
  const run = runId ? snapshot.runs.find((record) => record.id === runId) : snapshot.runs.at(-1);
  useEffect(() => {
    if (run?.id) onSelectedRun(run.id);
  }, [run?.id, onSelectedRun]);
  const restartSource = snapshot.runs.find((record) => record.id === restartId);
  const canStart = !reviewer && !busy && !repo.pending && repo.status === 'ready';
  function continueBranch(branch: WorkingBranch) {
    if (!canStart || branch.status !== 'active') return;
    const source =
      snapshot.runs.find(
        (item) =>
          item.id ===
          snapshot.candidates.find((candidate) => candidate.id === branch.latest_candidate_id)
            ?.run_id,
      ) ?? run;
    setRestartId('');
    setBranchSource(workingRun(snapshot, branch, source));
    setComposing(true);
  }
  async function newRun() {
    if (!canStart || openingBranch.current) return;
    if (!supportsWorkingBranches(snapshot)) {
      setRestartId('');
      setBranchSource(undefined);
      setComposing(true);
      return;
    }
    openingBranch.current = true;
    setBusy(true);
    try {
      let branch =
        workingBranches(snapshot).find(
          (item) => item.id === run?.working_branch_id && item.status === 'active',
        ) ??
        workingBranches(snapshot)
          .filter((item) => item.status === 'active')
          .at(-1) ??
        createdBranch.current;
      if (!branch) {
        const value = await api<unknown>(`repos/${repo.id}/create_working_branch`, {
          id: `work-${crypto.randomUUID()}`,
          expected_commit: repo.published_commit,
          expected_version: repo.version,
        });
        branch = workingBranches({ ...snapshot, working_branches: [value] } as Snapshot)[0];
        if (!branch)
          throw new Error('The working branch response was incomplete. Refresh before continuing.');
        createdBranch.current = branch;
      }
      continueBranch(branch);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      openingBranch.current = false;
      setBusy(false);
    }
  }
  async function act(action: string, body: unknown): Promise<boolean> {
    setBusy(true);
    try {
      await api(`repos/${repo.id}/${action}`, body);
      await onChange();
      return true;
    } catch (error) {
      if (['start_run', 'accept', 'answer_intent'].includes(action)) throw error;
      onError((error as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="exploration">
      <RunToolbar
        reviewer={reviewer}
        snapshot={snapshot}
        canStart={canStart}
        onNewRun={() => newRun()}
      />
      <PendingReviews snapshot={snapshot} selected={run?.id} onSelect={setRunId} />
      {composing && !reviewer && (
        <Dialog
          title={
            branchSource
              ? 'Continue working branch'
              : restartSource
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
              key={
                branchSource?.workingBranch
                  ? `${branchSource.workingBranch.id}:${branchSource.workingBranch.version}`
                  : (restartSource?.id ?? 'new-run')
              }
              initialRun={
                branchSource ?? (restartSource ? initialRun(snapshot, restartSource) : undefined)
              }
              busy={busy}
              snapshot={snapshot}
              onProviders={() => {
                setComposing(false);
                onProviders();
              }}
              onClose={() => setComposing(false)}
              onStart={async (brief) => {
                const id = `run-${crypto.randomUUID()}`;
                if (await act('start_run', { id, ...brief })) {
                  setRunId(id);
                  setComposing(false);
                  setRestartId('');
                  setBranchSource(undefined);
                }
              }}
            />
          </Suspense>
        </Dialog>
      )}
      {run ? (
        <>
          <RunHistory snapshot={snapshot} selected={run.id} onSelect={setRunId} />
          <RunEvidenceBoundary label="run results">
            <Suspense fallback={<p role="status">Loading run results…</p>}>
              <RunDetail
                reviewer={reviewer}
                key={run.id}
                snapshot={snapshot}
                run={run}
                busy={busy}
                canStart={canStart}
                onSelectRun={setRunId}
                onRestart={() => {
                  setBranchSource(undefined);
                  setRestartId(run.id);
                  setComposing(true);
                }}
                onCancel={() => void act('cancel_run', { run_id: run.id })}
                onRetry={(task) =>
                  void act('retry_team_task', {
                    run_id: run.id,
                    task_id: task.task_id,
                    expected_epoch: task.epoch,
                    expected_revision: task.revision,
                  })
                }
                onRepairTask={(request) => act('repair_team', request)}
                onAccept={(candidate, rationale, alternatives) =>
                  act('accept', {
                    request_id: crypto.randomUUID(),
                    candidate,
                    expected_commit: repo.head_commit,
                    expected_version: repo.version,
                    rationale,
                    alternatives,
                  })
                }
                onProviders={reviewer ? undefined : onProviders}
                onContext={() => onContext(run.id)}
                onContinueBranch={continueBranch}
                onAnswerIntent={(question, answer) =>
                  act('answer_intent', { run_id: run.id, question_id: question, answer })
                }
              />
            </Suspense>
          </RunEvidenceBoundary>
        </>
      ) : runId ? (
        <div className="empty-run">
          {requestedRunError ? (
            <p role="alert">{requestedRunError}</p>
          ) : (
            <p role="status">Loading run {runId}…</p>
          )}
        </div>
      ) : (
        <div className="empty-run">
          <h2>{reviewer ? 'Your trial results will appear here' : 'What will you build next?'}</h2>
          {reviewer ? (
            <p>Start a funded trial to explore captured source and independent checks.</p>
          ) : (
            <>
              <p>
                Start agents with a shared brief, or connect your local agent to contribute code and
                context.
              </p>
              <button type="button" className="quiet" onClick={onAgents}>
                Connect local agent
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

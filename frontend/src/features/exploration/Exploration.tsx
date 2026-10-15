import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { type RunSample, runSamples } from '../../../../shared/run-samples';
import { Dialog } from '../../components/Dialog';
import { api } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { comparisonBusy } from './comparisonView';
import { PendingReviews } from './RunAttention';
import { RunEvidenceBoundary } from './RunEvidenceBoundary';
import { RunHistory } from './RunHistory';
import { RunSamples } from './RunSamples';
import { RunToolbar } from './RunToolbar';
import { type InitialRun, initialRun } from './restartRun';
import { createRunStart } from './runStart';
import { sampleBrief } from './sampleBrief';
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
  onContext,
  onSelectedRun,
  initialRunId = '',
  requestedRunError = '',
  onGuidedDemo,
  focusedRunId,
  focusRequest = 0,
  focusedCandidateId,
  onGuidedContinue,
}: {
  reviewer?: boolean;
  snapshot: Snapshot;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
  onProviders: (refresh?: () => void) => void;
  onAgents: () => void;
  onContext: (runId: string) => void;
  onSelectedRun: (runId: string) => void;
  initialRunId?: string;
  requestedRunError?: string;
  onGuidedDemo?: () => void;
  focusedRunId?: string;
  /** Increments when the focused run should be scrolled to and focused. */
  focusRequest?: number;
  /** A result within the focused run to reveal on each focus request. */
  focusedCandidateId?: string;
  onGuidedContinue?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState(focusedRunId || initialRunId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a repeated request reselects the same run.
  useEffect(() => {
    if (focusedRunId) setRunId(focusedRunId);
  }, [focusedRunId, focusRequest]);
  const [composing, setComposing] = useState(false);
  const [restartId, setRestartId] = useState('');
  const [branchSource, setBranchSource] = useState<InitialRun>();
  const [sampleProfileId, setSampleProfileId] = useState<string>();
  const launcher = useRef<ReturnType<typeof createRunStart> | undefined>(undefined);
  const openingBranch = useRef(false);
  const createdBranch = useRef<WorkingBranch | null>(null);
  const repo = snapshot.repository;
  const run = runId
    ? snapshot.runs.find((record) => record.id === runId)
    : snapshot.runs.filter((record) => !record.hidden).at(-1);
  useEffect(() => {
    if (run?.id) onSelectedRun(run.id);
  }, [run?.id, onSelectedRun]);
  const restartSource = snapshot.runs.find((record) => record.id === restartId);
  const canStart =
    !busy &&
    !repo.pending &&
    repo.status === 'ready' &&
    !(run?.mode === 'compare' && comparisonBusy(snapshot, run));
  function openBrief(branch?: WorkingBranch, sample?: RunSample) {
    const base = branch ? workingRun(snapshot, branch) : undefined;
    setBranchSource(sample ? sampleBrief(snapshot, base, sample) : base);
    setSampleProfileId(sample?.id);
    launcher.current = createRunStart(repo.id);
    setRestartId('');
    setComposing(true);
  }
  function continueBranch(branch: WorkingBranch) {
    if (canStart && branch.status === 'active') openBrief(branch);
  }
  async function newRun(sample?: RunSample) {
    if (!canStart || openingBranch.current) return;
    if (!supportsWorkingBranches(snapshot)) {
      openBrief(undefined, sample);
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
      openBrief(branch, sample);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      openingBranch.current = false;
      setBusy(false);
    }
  }
  const onCompose = () => newRun();
  async function act(action: string, body: unknown): Promise<boolean> {
    setBusy(true);
    try {
      await api(`repos/${repo.id}/${action}`, body);
      await onChange();
      return true;
    } catch (error) {
      if (
        [
          'start_run',
          'accept',
          'reject_candidate',
          'answer_intent',
          'approve_comparison_review',
          'select_comparison_candidate',
        ].includes(action)
      )
        throw error;
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
        onNewRun={onCompose}
        onGuidedDemo={onGuidedDemo}
        onGuidedContinue={onGuidedContinue}
      />
      <RunSamples
        disabled={!canStart}
        onChoose={(sample) => {
          void newRun(sample);
        }}
      />
      <PendingReviews snapshot={snapshot} selected={run?.id} onSelect={setRunId} />
      {composing && (
        <Dialog
          title={
            restartSource
              ? 'Restart run'
              : (runSamples.find((item) => item.id === sampleProfileId)?.label ?? 'Start a Run')
          }
          onClose={() => setComposing(false)}
          locked={busy}
          wide
        >
          <RunEvidenceBoundary label="run settings" onClose={() => setComposing(false)}>
            <Suspense fallback={<p role="status">Loading run settings…</p>}>
              <RunComposer
                key={`${sampleProfileId ?? 'custom'}:${branchSource?.workingBranch ? `${branchSource.workingBranch.id}:${branchSource.workingBranch.version}` : (restartSource?.id ?? 'new-run')}`}
                initialRun={
                  branchSource ?? (restartSource ? initialRun(snapshot, restartSource) : undefined)
                }
                sampleProfileId={sampleProfileId}
                startUncertain={launcher.current?.uncertain}
                busy={busy}
                snapshot={snapshot}
                onProviders={onProviders}
                onClose={() => setComposing(false)}
                onStart={async (brief) => {
                  setBusy(true);
                  try {
                    launcher.current ??= createRunStart(repo.id);
                    const id = await launcher.current.start(brief);
                    setRunId(id);
                    setComposing(false);
                    setRestartId('');
                    setBranchSource(undefined);
                    await onChange();
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </Suspense>
          </RunEvidenceBoundary>
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
                focusRequest={run.id === focusedRunId ? focusRequest : 0}
                focusCandidate={run.id === focusedRunId ? focusedCandidateId : undefined}
                busy={busy}
                canStart={canStart}
                onGuidedContinue={onGuidedContinue}
                onSelectRun={setRunId}
                onRestart={() => {
                  launcher.current = createRunStart(repo.id);
                  setSampleProfileId(undefined);
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
                onComparisonAction={act}
                onRefresh={onChange}
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
                onReject={(candidate, reason) =>
                  act('reject_candidate', {
                    request_id: crypto.randomUUID(),
                    candidate,
                    expected_commit: repo.head_commit,
                    expected_version: repo.version,
                    reason,
                  })
                }
                onProviders={onProviders}
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
          <h2>What will you build next?</h2>
          <p>Describe what to build, a feature to add, or a bug to fix.</p>
          <button type="button" disabled={!canStart} onClick={onCompose}>
            Start a Run
          </button>
        </div>
      )}
    </section>
  );
}

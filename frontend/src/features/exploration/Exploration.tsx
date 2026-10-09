import { lazy, Suspense, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { api } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { PendingReviews } from './RunAttention';
import { RunEvidenceBoundary } from './RunEvidenceBoundary';
import { RunHistory } from './RunHistory';
import { RunToolbar } from './RunToolbar';
import { initialRun } from './restartRun';
import { hasPublishedWork } from './runDefaults';

const RunComposer = lazy(() =>
  import('./RunComposer').then((module) => ({ default: module.RunComposer })),
);
const RunDetail = lazy(() =>
  import('./RunDetail').then((module) => ({ default: module.RunDetail })),
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
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState('');
  const [composing, setComposing] = useState(false);
  const [restartId, setRestartId] = useState('');
  const repo = snapshot.repository;
  const run = snapshot.runs.find((record) => record.id === runId) ?? snapshot.runs.at(-1);
  const restartSource = snapshot.runs.find((record) => record.id === restartId);
  const canStart = !busy && !repo.pending && repo.status === 'ready';
  async function act(action: string, body: unknown): Promise<boolean> {
    setBusy(true);
    try {
      await api(`repos/${repo.id}/${action}`, body);
      await onChange();
      return true;
    } catch (error) {
      if (['start_run', 'accept'].includes(action)) throw error;
      onError((error as Error).message);
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
      <PendingReviews snapshot={snapshot} selected={run?.id} onSelect={setRunId} />
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
                key={run.id}
                snapshot={snapshot}
                run={run}
                busy={busy}
                canStart={canStart}
                onSelectRun={setRunId}
                onRestart={() => {
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
                onProviders={onProviders}
                onContext={onContext}
              />
            </Suspense>
          </RunEvidenceBoundary>
        </>
      ) : (
        <div className="empty-run">
          <h2>What will you build next?</h2>
          <p>
            Start agents with a shared brief, or connect your local agent to contribute code and
            context.
          </p>
          <button type="button" className="quiet" onClick={onAgents}>
            Connect local agent
          </button>
        </div>
      )}
    </section>
  );
}

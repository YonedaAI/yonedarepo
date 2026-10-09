import { GitCompareArrows } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { api, short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { CandidateCard } from './CandidateCard';
import { CandidateComparison } from './CandidateComparison';
import { DecisionForm } from './DecisionForm';
import { ExecutionHierarchy } from './ExecutionHierarchy';
import { ModelBudgetUsage } from './ModelBudgetUsage';
import { RunComposer } from './RunComposer';
import { RunControls } from './RunControls';
import { RunToolbar } from './RunToolbar';
import { RunWorkflow } from './RunWorkflow';
import { initialRun } from './restartRun';
import { hasPublishedWebsite } from './runDefaults';

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
  const candidates = snapshot.candidates.filter((c) => c.run_id === run?.id);
  const coding = snapshot.executions.filter((e) => e.run_id === run?.id && e.role === 'coding');
  const roots = coding.filter((e) => !e.parent_execution).length;
  const activeAttempts = snapshot.executions.some(
    (execution) =>
      execution.run_id === run?.id &&
      ['queued', 'running', 'capturing', 'evaluating'].includes(execution.status),
  );
  const restartSource = snapshot.runs.find((record) => record.id === restartId);
  const codeCandidates: Record<string, any>[] = candidates.map((c) => ({
    ...c,
    strategy: snapshot.executions.find((e) => e.id === c.execution)?.strategy ?? c.summary,
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
              : hasPublishedWebsite(snapshot)
                ? 'Update website'
                : 'New development run'
          }
          onClose={() => setComposing(false)}
          locked={busy}
          wide
        >
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
        </Dialog>
      )}
      {run ? (
        <>
          <div className="run-picker">
            <label htmlFor="recorded-run">Run history</label>
            <select
              id="recorded-run"
              value={run.id}
              onChange={(e) => {
                setRunId(e.target.value);
                setSelected('');
                setComparing(false);
              }}
            >
              {[...snapshot.runs].reverse().map((r) => (
                <option key={r.id} value={r.id}>
                  {r.intent} · {r.status} · {new Date(r.created_at).toLocaleDateString()}
                </option>
              ))}
            </select>
          </div>
          <div className="intent-row">
            <div>
              <h2>{run.intent}</h2>
              <div className="run-meta">
                <span className={`status ${run.status}`}>
                  {publishedRun ? 'published' : run.status}
                </span>
                <span>
                  Base <code>{short(run.base.commit)}</code>
                </span>
                <span>
                  {roots} root agents · {coding.length - roots} subagents
                </span>
                {run.restart_of && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setRunId(run.restart_of);
                      setSelected('');
                      setComparing(false);
                    }}
                  >
                    View previous run
                  </button>
                )}
              </div>
            </div>
            <RunControls
              run={run}
              busy={busy}
              canStart={canStart}
              activeAttempts={activeAttempts}
              hasRoots={roots > 0}
              supportsRestart={snapshot.capabilities?.model_budgets === 1}
              onRestart={() => {
                setRestartId(run.id);
                setComposing(true);
              }}
              onCancel={() => void act('cancel_run', { run_id: run.id })}
            />
          </div>
          {publishedRun && !activeAttempts && (
            <p className="subtle">
              This published run is recorded history. Choose Update website to start a fresh change.
            </p>
          )}
          {activeAttempts && (
            <p className="subtle">Finish or cancel active attempts to restart this run.</p>
          )}
          <RunWorkflow snapshot={snapshot} run={run} />
          <ModelBudgetUsage run={run} />
          <ExecutionHierarchy snapshot={snapshot} run={run} />
          <button type="button" className="text-button context-link" onClick={onContext}>
            Explore this repository’s context →
          </button>
          <div className="comparison-heading" id="approaches">
            <h2>{coding.length === 1 ? 'Review change' : 'Compare approaches'}</h2>
            {coding.length > 1 && (
              <button
                type="button"
                className="quiet"
                disabled={candidates.length < 2}
                aria-expanded={comparing}
                onClick={() => setComparing(!comparing)}
              >
                <GitCompareArrows size={17} />
                {comparing ? 'Close comparison' : 'Compare changes'}
              </button>
            )}
          </div>
          <div className="candidate-grid">
            {coding.map((execution) => {
              const strategy = execution.strategy;
              const candidate = candidates.find((c) => c.execution === execution?.id);
              const evaluation = snapshot.evaluations.find((e) => e.id === candidate?.evaluation);
              return (
                <CandidateCard
                  key={execution.id}
                  strategy={strategy}
                  repo={repo.id}
                  execution={execution}
                  candidate={candidate}
                  evaluation={evaluation}
                  decision={snapshot.decisions.find((d) => d.run_id === run.id)}
                  selected={!!candidate && selected === candidate.id}
                  disabled={
                    candidate?.status !== 'eligible' ||
                    !!repo.pending ||
                    busy ||
                    ['accepted', 'cancelled'].includes(run.status) ||
                    candidate?.base.commit !== repo.head_commit ||
                    evaluation?.policy !== repo.policy?.version
                  }
                  onSelect={() => {
                    setSelectionError('');
                    setSelected(candidate?.id ?? '');
                  }}
                  onProviders={onProviders}
                />
              );
            })}
          </div>
          {comparing && <CandidateComparison key={run.id} candidates={codeCandidates} />}
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

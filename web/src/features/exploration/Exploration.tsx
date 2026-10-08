import { Check, GitCommitHorizontal, LoaderCircle, Play, StopCircle, X } from 'lucide-react';
import { useState } from 'react';
import { api, short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
export function Exploration({
  snapshot,
  onChange,
  onError,
}: {
  snapshot: Snapshot;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [intent, setIntent] = useState(
    'Add safe retries for transient upstream failures within a bounded total deadline.',
  );
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const [rationale, setRationale] = useState('');
  const repo = snapshot.repository;
  const run = snapshot.runs.at(-1);
  const candidates = snapshot.candidates.filter((c) => c.run_id === run?.id);
  async function act(action: string, body: unknown) {
    setBusy(true);
    try {
      await api(`repos/${repo.id}/${action}`, body);
      await onChange();
      setSelected('');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="exploration">
      <div className="intent-row">
        <div>
          <h1>{run?.intent ?? 'Give your code a reason.'}</h1>
          <p>
            {run
              ? 'Research is shared. Approaches are independent. Every decision stays connected.'
              : 'Explore several approaches to one intent, and preserve why you chose.'}
          </p>
        </div>
        {run && run.status !== 'accepted' && run.status !== 'cancelled' && (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => void act('cancel_run', { run_id: run.id })}
          >
            <StopCircle size={16} />
            Cancel run
          </button>
        )}
      </div>
      {(!run || ['accepted', 'cancelled', 'failed'].includes(run.status)) && (
        <form
          className="intent-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act('start_run', {
              id: `run-${crypto.randomUUID()}`,
              intent,
              criteria: [
                'Retry GET only',
                'Respect total deadline',
                'Read README.md before publishing guidance; preserve its CLI contract, including repeating the final supplied status when the status list is exhausted',
                'Keep the contract deterministic',
              ],
            });
          }}
        >
          <label className="sr-only" htmlFor="intent">
            Exploration intent
          </label>
          <input
            id="intent"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            required
            maxLength={16000}
          />
          <button type="submit" disabled={busy || Boolean(repo.pending) || repo.status !== 'ready'}>
            <Play size={16} />
            Start exploration
          </button>
        </form>
      )}
      {run && (
        <div className="run-meta">
          <span className={`status ${run.status}`}>{run.status}</span>
          <span>
            Base <code>{short(run.base.commit)}</code>
          </span>
          <span>{snapshot.executions.filter((e) => e.run_id === run.id).length} executions</span>
        </div>
      )}
      <div className="candidate-grid">
        {['minimal', 'defensive', 'maintainable'].map((strategy) => {
          const execution = snapshot.executions.find(
            (e) => e.run_id === run?.id && e.strategy === strategy,
          );
          const candidate = candidates.find((c) => c.execution === execution?.id);
          const evaluation = snapshot.evaluations.find((e) => e.id === candidate?.evaluation);
          const status = candidate?.status ?? execution?.status ?? 'waiting';
          return (
            <article
              className={`candidate ${selected === candidate?.id ? 'focused' : ''}`}
              key={strategy}
            >
              <div className="candidate-title">
                <span className="strategy-mark" />
                <h2>{strategy}</h2>
                <span>
                  {execution?.model ??
                    execution?.harness ??
                    (strategy === 'defensive' ? 'claude' : 'codex')}
                </span>
              </div>
              <div className="candidate-content">
                <span className={`status ${status}`}>
                  {status === 'eligible' ? (
                    <Check size={13} />
                  ) : status === 'rejected' || status === 'failed' ? (
                    <X size={13} />
                  ) : ['running', 'capturing', 'evaluating'].includes(status) ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : null}
                  {status}
                </span>
                <p>
                  {candidate?.summary ??
                    (execution?.role === 'coding'
                      ? 'Working from the same frozen research.'
                      : 'Shared research runs before this approach begins.')}
                </p>
                {execution?.error && <p role="alert">{execution.error}</p>}
                {candidate && (
                  <>
                    <div className="revision">
                      <GitCommitHorizontal size={15} />
                      <code>{short(candidate.revision.commit)}</code>
                      <span>{candidate.paths.length} paths</span>
                    </div>
                    <div className="checks">
                      {evaluation?.checks.map((c: Record<string, string>) => (
                        <span key={c.name} className={c.status}>
                          {c.status === 'pass' ? <Check size={12} /> : <X size={12} />} {c.name}
                        </span>
                      ))}
                    </div>
                    <details>
                      <summary>Review changes</summary>
                      <pre>{candidate.diff || 'No source changes'}</pre>
                    </details>
                    <button
                      type="button"
                      className="select-candidate"
                      disabled={
                        status !== 'eligible' ||
                        Boolean(repo.pending) ||
                        busy ||
                        ['accepted', 'cancelled'].includes(run?.status) ||
                        candidate.base.commit !== repo.head_commit
                      }
                      onClick={() => setSelected(candidate.id)}
                    >
                      Select approach
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {selected && (
        <form
          className="decision-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act('accept', {
              request_id: crypto.randomUUID(),
              candidate: selected,
              expected_commit: repo.head_commit,
              expected_version: repo.version,
              rationale,
              alternatives: candidates
                .filter((c) => c.id !== selected)
                .map((c) => ({ candidate: c.id, reason: 'Considered during comparison' })),
            });
          }}
        >
          <label htmlFor="rationale">Why choose this approach?</label>
          <textarea
            id="rationale"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            required
            placeholder="Record the tradeoff future readers should understand."
          />
          <div>
            <button type="submit" disabled={busy || !rationale.trim()}>
              Record decision and publish
            </button>
            <button type="button" className="quiet" onClick={() => setSelected('')}>
              Keep comparing
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

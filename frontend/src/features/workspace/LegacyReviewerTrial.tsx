import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { runHasActiveAttempts } from '../exploration/runControlState';

type ReviewerStatus = {
  active_trial: string | null;
  active_trial_state: 'reserved' | 'running' | null;
  budget: { limit: number; charged: number };
};

export function LegacyReviewerTrial({
  snapshot,
  live = false,
  onChange,
  onError,
}: {
  snapshot: Snapshot;
  live?: boolean;
  onChange: () => Promise<void>;
  onError: (e: string) => void;
}) {
  const request = useRef<string | null>(null);
  const action = useRef(false);
  const pending = useRef<Promise<ReviewerStatus> | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<ReviewerStatus | null>(null);
  const activeTrial = status?.active_trial ?? null;
  const remaining = status ? (status.budget.limit - status.budget.charged) / 1e6 : null;
  const activeRun = snapshot.runs.find((run) => run.id === activeTrial);
  const working = Boolean(
    activeTrial &&
      (status?.active_trial_state === 'running' ||
        runHasActiveAttempts(snapshot, activeRun ?? { id: activeTrial })),
  );
  // Only a confirmed reservation without a run can be resumed. Unknown status fails closed.
  const recoverable = Boolean(activeTrial && status?.active_trial_state === 'reserved' && !working);
  const blocked = busy || loading || Boolean(activeTrial && !recoverable);
  const checkedRun = [...snapshot.runs]
    .filter(
      (run) =>
        ['ready', 'accepted'].includes(run.status) &&
        snapshot.candidates.some(
          (candidate) => candidate.run_id === run.id && candidate.status === 'eligible',
        ),
    )
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  const loadStatus = useCallback(
    async (isActive: () => boolean = () => true, foreground = true) => {
      if (foreground) setLoading(true);
      try {
        if (!pending.current) {
          const read = api<ReviewerStatus>('reviewer');
          pending.current = read;
          void read
            .finally(() => {
              if (pending.current === read) pending.current = null;
            })
            .catch(() => {});
        }
        const result = await pending.current;
        if (isActive()) {
          setStatus(result);
          setLoaded(true);
        }
      } catch (e) {
        if (isActive()) {
          setLoaded(false);
          onError((e as Error).message);
        }
      } finally {
        if (isActive() && foreground) setLoading(false);
      }
    },
    [onError],
  );
  useEffect(() => {
    if (!live) return;
    let active = true;
    void loadStatus(() => active);
    return () => {
      active = false;
    };
  }, [loadStatus, live]);
  useEffect(() => {
    if (!live || !activeTrial) return;
    let active = true;
    const timer = setInterval(() => void loadStatus(() => active, false), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeTrial, loadStatus, live]);
  if (!live)
    return (
      <section className="workspace-notice" aria-label="Historical reviewer results">
        <div>
          <strong>Historical reviewer results</strong>
          <p>
            Earlier captured source, checks and context remain available. Legacy live trials are
            disabled.
          </p>
          {checkedRun && (
            <a
              href={`/?repo=${encodeURIComponent(snapshot.repository.id)}&run=${encodeURIComponent(checkedRun.id)}`}
            >
              Review historical checked result
            </a>
          )}
        </div>
      </section>
    );
  return (
    <section className="workspace-notice" aria-label="Evaluate YonedaRepo">
      <div>
        <strong>Evaluate YonedaRepo</strong>
        <p>
          See how two agents build one change together. The trail guide is the example; review how
          YonedaRepo coordinates, verifies and explains their work.
        </p>
        <ol>
          <li>Preview the result and inspect the changed source and independent checks.</li>
          <li>Open Agent activity to see task ownership, dependencies and captured handoffs.</li>
          <li>Open Evidence trail to trace the intent, exact revision and publication decision.</li>
        </ol>
        <p>
          Publishing in this sandbox is optional. Viewing an existing result starts no paid work.
        </p>
        {checkedRun && (
          <p>
            <a
              href={`/?repo=${encodeURIComponent(snapshot.repository.id)}&run=${encodeURIComponent(checkedRun.id)}`}
            >
              Review checked result
            </a>
          </p>
        )}
        <p role="status">
          {working
            ? 'A trial is already running. Progress updates automatically; no resume is needed.'
            : recoverable
              ? 'The previous start was interrupted. Resume that same trial without creating another.'
              : activeTrial
                ? 'Checking the existing trial. Starting another is disabled.'
                : 'Optional: start a new two-agent example, up to $5.'}
          {remaining === null ? '' : ` $${remaining.toFixed(2)} shared allowance remaining.`}
        </p>
        <code>node tools/reviewer.mjs --checked</code>
      </div>
      <button
        type="button"
        disabled={blocked}
        onClick={async () => {
          if (action.current || blocked) return;
          onError('');
          if (!loaded) {
            await loadStatus();
            return;
          }
          action.current = true;
          setBusy(true);
          try {
            if (recoverable) await api('reviewer/resume', {});
            else {
              request.current ??= crypto.randomUUID();
              await api('reviewer/trial', { request_id: request.current });
            }
            request.current = null;
            await onChange();
          } catch (e) {
            onError((e as Error).message);
          } finally {
            await loadStatus(() => true, false);
            action.current = false;
            setBusy(false);
          }
        }}
      >
        {busy
          ? recoverable
            ? 'Resuming…'
            : 'Starting…'
          : working
            ? 'Trial running…'
            : loading
              ? 'Checking trial status…'
              : !loaded
                ? 'Retry trial status'
                : recoverable
                  ? 'Resume interrupted start'
                  : activeTrial
                    ? 'Trial status pending…'
                    : 'Start new $5 trial'}
      </button>
      <button
        type="button"
        className="text-button"
        disabled={loading || busy}
        onClick={() => {
          onError('');
          void loadStatus();
        }}
      >
        Refresh trial status
      </button>
    </section>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

type ReviewerStatus = {
  active_trial: string | null;
  budget: { limit: number; charged: number };
};

export function ReviewerTrial({
  onChange,
  onError,
}: {
  onChange: () => Promise<void>;
  onError: (e: string) => void;
}) {
  const request = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [activeTrial, setActiveTrial] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const loadStatus = useCallback(
    async (isActive: () => boolean = () => true) => {
      setLoading(true);
      try {
        const p = await api<ReviewerStatus>('reviewer');
        if (isActive()) {
          setActiveTrial(p.active_trial);
          setRemaining((p.budget.limit - p.budget.charged) / 1e6);
          setLoaded(true);
        }
      } catch (e) {
        if (isActive()) {
          setLoaded(false);
          onError((e as Error).message);
        }
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [onError],
  );
  useEffect(() => {
    let active = true;
    void loadStatus(() => active);
    return () => {
      active = false;
    };
  }, [loadStatus]);
  useEffect(() => {
    if (!activeTrial) return;
    const timer = setInterval(() => void loadStatus(), 5000);
    return () => clearInterval(timer);
  }, [activeTrial, loadStatus]);
  return (
    <section className="workspace-notice" aria-label="Funded reviewer trial">
      <div>
        <strong>Reviewer sandbox</strong>
        <p aria-live="polite">
          Two agents build a bilingual trail guide together. Up to $5 per trial
          {remaining === null ? '' : ` · $${remaining.toFixed(2)} shared allowance remaining`}.
          Review and publish the checked result here.
        </p>
        <code>node tools/reviewer.mjs</code>
      </div>
      <button
        type="button"
        disabled={busy || loading}
        onClick={async () => {
          onError('');
          if (!loaded) {
            await loadStatus();
            return;
          }
          setBusy(true);
          try {
            if (activeTrial) {
              await api('reviewer/resume', {});
            } else {
              request.current ??= crypto.randomUUID();
              await api('reviewer/trial', { request_id: request.current });
            }
            request.current = null;
            await onChange();
          } catch (e) {
            onError((e as Error).message);
          } finally {
            // A failed response may still have reserved or started the trial.
            await loadStatus();
            setBusy(false);
          }
        }}
      >
        {loading
          ? 'Loading trial…'
          : busy
            ? activeTrial
              ? 'Resuming…'
              : 'Starting…'
            : !loaded
              ? 'Retry trial status'
              : activeTrial
                ? 'Resume trial'
                : 'Run prepared example'}
      </button>
      <button
        type="button"
        className="text-button"
        disabled={loading || busy}
        onClick={() => void loadStatus()}
      >
        Refresh allowance and trial status
      </button>
    </section>
  );
}

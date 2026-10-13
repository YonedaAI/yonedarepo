import { useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { runHasActiveAttempts } from '../exploration/runControlState';
import type { CampaignStatus } from './campaignView';

export function ReviewerCampaignActions({
  status,
  snapshot,
  onChange,
  onRefresh,
  onError,
}: {
  status: CampaignStatus;
  snapshot: Snapshot;
  onChange: () => Promise<void>;
  onRefresh: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const request = useRef<string | null>(null);
  const active = typeof status.active_trial === 'string' ? status.active_trial : null;
  const run = snapshot.runs.find((item) => item.id === active);
  const working =
    !!active &&
    (status.active_trial_state === 'running' ||
      runHasActiveAttempts(snapshot, run ?? { id: active }));
  const recoverable = !!active && status.active_trial_state === 'reserved' && !working;
  const budget = status.budget;
  const allowance =
    budget &&
    Number.isSafeInteger(budget.limit_microusd) &&
    Number.isSafeInteger(budget.charged_microusd) &&
    budget.limit_microusd >= 0 &&
    budget.charged_microusd >= 0
      ? Math.max(0, budget.limit_microusd - budget.charged_microusd)
      : null;
  const knownIdle = status.active_trial === null && status.active_trial_state === null;
  const blocked =
    busy ||
    working ||
    (!recoverable && (!knownIdle || allowance === null || allowance < 5_000_000));
  return (
    <section className="reviewer-campaign-actions" aria-label="Optional campaign run">
      <p role="status">
        {working
          ? 'Campaign agents are working. Progress updates automatically.'
          : recoverable
            ? 'The previous start was interrupted. Resume the same approved run.'
            : active
              ? 'Checking the existing campaign run; another start is disabled.'
              : 'Optional metered run: up to $5 using the campaign’s approved brief, models and limits.'}
        {allowance !== null && ` $${(allowance / 1e6).toFixed(2)} shared allowance remaining.`}
      </p>
      {active && (
        <a
          href={`/?repo=${encodeURIComponent(status.approval.entry.repo_id)}&run=${encodeURIComponent(active)}`}
        >
          Inspect current campaign run
        </a>
      )}
      <button
        type="button"
        className="quiet"
        disabled={blocked}
        onClick={async () => {
          if (blocked || submitting.current) return;
          submitting.current = true;
          setBusy(true);
          setError('');
          onError('');
          try {
            if (recoverable) await api('reviewer/campaign/resume', {});
            else {
              request.current ??= crypto.randomUUID();
              await api('reviewer/campaign/trial', { request_id: request.current });
            }
            request.current = null;
            await onChange();
          } catch (failure) {
            setError((failure as Error).message);
            onError((failure as Error).message);
          } finally {
            submitting.current = false;
            setBusy(false);
            onRefresh();
          }
        }}
      >
        {busy
          ? recoverable
            ? 'Resuming…'
            : 'Starting…'
          : working
            ? 'Campaign running…'
            : recoverable
              ? 'Resume interrupted campaign start'
              : active
                ? 'Campaign status pending…'
                : 'Start optional $5 run'}
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

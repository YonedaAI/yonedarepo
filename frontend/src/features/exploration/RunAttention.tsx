import { CircleAlert, CircleCheck, ClipboardCheck, LoaderCircle } from 'lucide-react';
import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { runAttention } from './runReviewState';
import { runTitle } from './runTitle';
import { SiteLink } from './SiteLink';

export function RunAttention({
  snapshot,
  run,
  busy,
  onAction,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  busy: boolean;
  onAction: (action: 'review' | 'activity' | 'results' | 'details', candidate?: string) => void;
}) {
  const attention = runAttention(snapshot, run);
  const decision = snapshot.decisions.find((item) => item.run_id === run.id);
  const evaluation = snapshot.evaluations.find(
    (item) => item.id === attention.candidate?.evaluation,
  );
  const Icon =
    attention.tone === 'review'
      ? ClipboardCheck
      : attention.tone === 'blocked'
        ? CircleAlert
        : attention.tone === 'working'
          ? LoaderCircle
          : CircleCheck;
  return (
    <section
      className={`run-attention attention-${attention.tone}`}
      aria-labelledby="run-attention-heading"
    >
      <div className="attention-message">
        <Icon size={22} aria-hidden="true" />
        <div>
          <h3 id="run-attention-heading">{attention.title}</h3>
          <p>{attention.detail}</p>
          {(attention.candidate || decision?.target) && (
            <small>
              {decision ? 'Selected revision' : 'Checked revision'}{' '}
              <code>{short((attention.candidate?.revision ?? decision?.target)?.commit)}</code>
            </small>
          )}
        </div>
      </div>
      <div className="attention-actions">
        {attention.action && (
          <button
            type="button"
            className={attention.tone === 'review' ? undefined : 'quiet'}
            disabled={busy}
            onClick={() => {
              if (attention.action) onAction(attention.action, attention.candidate?.id);
            }}
          >
            {attention.actionLabel}
          </button>
        )}
        {evaluation?.deployment?.digest && (
          <SiteLink key={evaluation.id} repo={snapshot.repository.id} evaluation={evaluation.id} />
        )}
        {decision?.status === 'published' &&
          snapshot.repository.site?.commit === decision.target?.commit && (
            <SiteLink repo={snapshot.repository.id} publishedCommit={decision.target.commit} />
          )}
      </div>
    </section>
  );
}

export function PendingReviews({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: Snapshot;
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const pending = snapshot.runs.filter(
    (run) => run.id !== selected && runAttention(snapshot, run).tone === 'review',
  );
  if (!pending.length) return null;
  return (
    <aside className="pending-reviews" aria-label="Other runs awaiting review">
      <strong>
        {pending.length} other run{pending.length === 1 ? '' : 's'} awaiting review
      </strong>
      <ul>
        {pending.map((run) => (
          <li key={run.id}>
            <button type="button" className="text-button" onClick={() => onSelect(run.id)}>
              {runTitle(run.intent)}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

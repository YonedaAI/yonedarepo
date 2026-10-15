import { CircleAlert, CircleCheck, ClipboardCheck, LoaderCircle } from 'lucide-react';
import { short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import {
  type GuidedBlockerKind,
  guidedBlockerTitle,
  guidedPublicationState,
} from '../guided-demo/guidedPublication';
import { activeDecision } from './agentsPick';
import { runAttention } from './runReviewState';
import { runTitle } from './runTitle';
import { SiteLink } from './SiteLink';

/** Guide continuation opens the guided demo; the others open run evidence directly. */
const guideActions: Record<GuidedBlockerKind, 'guide' | 'activity' | 'details'> = {
  refresh_evidence: 'guide',
  active_work: 'activity',
  failed_work: 'guide',
  final_result: 'guide',
  recorded_decision: 'details',
};

export function RunAttention({
  snapshot,
  run,
  busy,
  onAction,
  onGuidedContinue,
  onCancel,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  busy: boolean;
  onGuidedContinue?: () => void;
  /** Shown beside the status while the run can still be stopped. */
  onCancel?: () => void;
  onAction: (action: 'review' | 'activity' | 'results' | 'details', candidate?: string) => void;
}) {
  const recorded = runAttention(snapshot, run);
  const eligible = snapshot.candidates.find(
    (item) => item.run_id === run.id && item.status === 'eligible' && !item.owner_rejection,
  );
  const decision = activeDecision(snapshot, run);
  // One distinct guide blocker and one action; recorded decisions keep their own attention.
  const guide =
    eligible && !decision && recorded.tone !== 'neutral'
      ? guidedPublicationState(snapshot, run, eligible)
      : undefined;
  const guideAction = guide ? guideActions[guide.kind] : undefined;
  const attention = guide
    ? {
        ...recorded,
        tone: guide.kind === 'active_work' ? ('working' as const) : ('blocked' as const),
        title: guidedBlockerTitle(guide.kind),
        detail: guide.message,
        actionLabel: guide.action,
        action: guideAction === 'guide' ? ('results' as const) : guideAction,
        candidate: eligible,
      }
    : recorded;
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
            className={guide ? 'primary' : attention.tone === 'review' ? undefined : 'quiet'}
            disabled={busy}
            onClick={() => {
              if (guideAction === 'guide' && onGuidedContinue) {
                onGuidedContinue();
                return;
              }
              if (attention.action) onAction(attention.action, attention.candidate?.id);
            }}
          >
            {attention.actionLabel}
          </button>
        )}
        {onCancel && (
          <button type="button" className="quiet" disabled={busy} onClick={onCancel}>
            Cancel run
          </button>
        )}
        {(evaluation?.deployment?.digest || evaluation?.app?.bundle_digest) && (
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

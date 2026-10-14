import { RefreshCw } from 'lucide-react';
import { type GuidedSession, type GuidedStepId, guidedSteps } from '../../../../shared/guided-runs';
import { short } from '../../lib/api';
import { GuidedEvidenceList } from './GuidedEvidenceList';
import { GuidedProgress } from './GuidedProgress';
import { runningExplanations } from './guidedEvidenceView';
import { type GuideRefreshState, guideRefreshText } from './guidedRefresh';
import './guided-demo.css';

const statusLabels = {
  ready: 'Ready',
  running: 'In progress',
  complete: 'Complete',
  needs_attention: 'Needs attention',
  locked: 'Later stage',
};
export function GuidedSessionPanel({
  session,
  busy,
  onStart,
  onInspect,
  onRefresh,
  refresh = { refreshing: false },
}: {
  session: GuidedSession;
  busy: boolean;
  onStart: (step: GuidedStepId) => void;
  onInspect: (run: string, step: GuidedStepId, candidate?: string, kind?: string) => void;
  onRefresh: () => void;
  refresh?: GuideRefreshState;
}) {
  const next = session.steps.find((step) => step.id === session.next_step);
  const definition = guidedSteps.find((step) => step.id === session.next_step);
  const humanReview =
    next?.id === 'review' &&
    next.status === 'running' &&
    next.next_action === 'review_and_publish' &&
    !!next.candidate_id;
  const active = session.steps.some((step) => step.status === 'running' && step.id !== 'review');
  const actionable = humanReview || (next?.status === 'ready' && !!next.next_action && !active);
  const lastRun = (step: (typeof session.steps)[number]) => step.run_ids.at(-1);
  return (
    <section className="guided-demo" aria-label="Guided demo">
      <div className="section-heading">
        <div>
          <h2>Your guided task board</h2>
          <p>A fresh project. Progress comes from this session’s recorded work and checks.</p>
        </div>
        <div className="guided-refresh">
          <button
            className="icon-button"
            type="button"
            disabled={busy || refresh.refreshing}
            aria-busy={refresh.refreshing}
            onClick={onRefresh}
            aria-label="Refresh guide"
            title="Refresh guide"
          >
            <RefreshCw
              size={16}
              aria-hidden="true"
              className={refresh.refreshing ? 'spin' : undefined}
            />
          </button>
          <small
            className={`guided-refresh-status${refresh.error && !refresh.refreshing ? ' failed' : ''}`}
            aria-live="polite"
          >
            {guideRefreshText(refresh)}
          </small>
        </div>
      </div>
      <GuidedProgress session={session} />
      <ol className="guided-stages">
        {guidedSteps.map((definition) => {
          const step = session.steps.find((item) => item.id === definition.id);
          if (!step) return null;
          const runId = lastRun(step);
          return (
            <li key={step.id} className={session.next_step === step.id ? 'current' : undefined}>
              <div className="guided-stage-heading">
                <h3>{definition.title}</h3>
                <span className={`guided-status guided-${step.status}`}>
                  {step.id === 'review' &&
                  step.status === 'running' &&
                  step.next_action === 'review_and_publish'
                    ? 'Awaiting your decision'
                    : statusLabels[step.status]}
                </span>
              </div>
              <p>{definition.description}</p>
              {step.status === 'running' &&
                !(step.id === 'review' && step.next_action === 'review_and_publish') && (
                  <p className="guided-running-note">{runningExplanations[step.id]}</p>
                )}
              {step.revision && (
                <p className="guided-revision">
                  <code title={step.revision.commit}>rev {short(step.revision.commit)}</code>
                </p>
              )}
              {!!step.evidence.length && (
                <GuidedEvidenceList
                  stepId={step.id}
                  evidence={step.evidence}
                  fallbackRun={runId}
                  busy={busy}
                  onInspect={onInspect}
                />
              )}
              {(!!runId || (step.id === 'concurrent' && step.run_ids.length > 1)) && (
                <div className="guided-run-links">
                  {!!runId && (
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy}
                      onClick={() => onInspect(runId, step.id, step.candidate_id ?? undefined)}
                    >
                      {step.status === 'running' || !step.candidate_id ? 'View run' : 'View result'}
                    </button>
                  )}
                  {step.id === 'concurrent' &&
                    step.run_ids.length > 1 &&
                    step.run_ids.map((id, index) => (
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy}
                        key={id}
                        onClick={() => onInspect(id, step.id)}
                      >
                        Inspect concurrent run {index + 1}
                      </button>
                    ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="guided-next" aria-live="polite">
        {actionable && next && definition ? (
          <>
            <h3>Next: {definition.title}</h3>
            <p>
              {next.id === 'review'
                ? 'Review the exact changes, reasons, checks and unresolved issues. Publishing remains your explicit decision.'
                : 'Uses your connected models and automatic roles. Work starts only when you choose this action.'}
            </p>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                humanReview
                  ? onInspect('', next.id, next.candidate_id ?? undefined)
                  : onStart(next.id)
              }
            >
              {busy ? 'Starting…' : definition.action}
            </button>
          </>
        ) : active ? (
          <p role="status">The next step unlocks when this one finishes.</p>
        ) : next?.status === 'needs_attention' ? (
          <p role="status">
            This stage needs attention. Inspect its result and recorded checks before continuing.
          </p>
        ) : session.next_step === null ? (
          <p role="status">
            {session.steps.every((step) => step.status === 'complete')
              ? 'Guided demo complete. Inspect your recorded results and published revision above.'
              : 'The guide has no next action. Review its recorded work above.'}
          </p>
        ) : (
          <p role="status">
            Waiting for the server to confirm the next stage. Refresh the guide to check its
            evidence.
          </p>
        )}
      </div>
    </section>
  );
}

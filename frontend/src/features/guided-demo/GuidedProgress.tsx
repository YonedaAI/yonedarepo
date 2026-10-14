import { Check, Lock } from 'lucide-react';
import type { GuidedSession } from '../../../../shared/guided-runs';
import { type GuidedProgressState, guidedProgress } from './guidedEvidenceView';

const stateText: Record<GuidedProgressState, string> = {
  done: 'complete',
  current: 'current step',
  attention: 'needs attention',
  upcoming: 'locked',
};

export function GuidedProgress({ session }: { session: GuidedSession }) {
  const { steps, complete } = guidedProgress(session);
  const current = steps.find((step) => step.state === 'current' || step.state === 'attention');
  return (
    <div className="guided-progress">
      <p className="guided-progress-count">
        {complete} of {steps.length} complete
      </p>
      <ol aria-label="Guided demo progress">
        {steps.map((step) => (
          <li
            key={step.id}
            className={`guided-progress-${step.state}`}
            aria-current={step === current ? 'step' : undefined}
          >
            <span className="guided-progress-marker" aria-hidden="true">
              {step.state === 'done' ? (
                <Check size={14} strokeWidth={2.5} />
              ) : step.state === 'upcoming' ? (
                <Lock size={12} />
              ) : (
                <i />
              )}
            </span>
            <span>{step.label}</span>
            <span className="sr-only">, {stateText[step.state]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

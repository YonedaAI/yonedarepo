import { Check, Circle } from 'lucide-react';
import type { GuidedEvidence, GuidedStepId } from '../../../../shared/guided-runs';
import { ClampedText } from '../../components/ClampedText';
import { designChoiceText, evidenceInspectKind, evidenceLabel } from './guidedEvidenceView';

export function GuidedEvidenceList({
  stepId,
  evidence,
  fallbackRun,
  busy,
  onInspect,
}: {
  stepId: GuidedStepId;
  evidence: GuidedEvidence[];
  fallbackRun?: string;
  busy: boolean;
  onInspect: (run: string, step: GuidedStepId, candidate?: string, kind?: string) => void;
}) {
  return (
    <ul className="guided-evidence">
      {evidence.map((item, index) => {
        const kind = evidenceInspectKind(item);
        const evidenceRun = item.run_id ?? (item.candidate_id ? '' : fallbackRun);
        const label = evidenceLabel(item);
        const decision = designChoiceText(item);
        return (
          <li key={`${item.kind}:${item.record_id ?? index}`}>
            <div className="guided-evidence-row">
              <span
                className={`guided-evidence-icon ${item.verified ? 'verified' : 'pending'}`}
                aria-hidden="true"
              >
                {item.verified ? <Check size={14} strokeWidth={2.5} /> : <Circle size={12} />}
              </span>
              <span title={item.label}>{label}</span>
              <span className="sr-only">
                {item.kind === 'design_choice'
                  ? '(source-linked decision)'
                  : item.verified
                    ? '(Verified)'
                    : '(Not yet verified)'}
              </span>
              {(evidenceRun || item.candidate_id) && (
                <button
                  className="text-button guided-evidence-details"
                  type="button"
                  disabled={busy}
                  aria-label={`Details: ${label}`}
                  title={item.label}
                  onClick={() => onInspect(evidenceRun ?? '', stepId, item.candidate_id, kind)}
                >
                  Details
                </button>
              )}
            </div>
            {decision && (
              <ClampedText
                text={decision}
                lines={2}
                characters={160}
                className="guided-decision"
                showLabel="Show decision"
                hideLabel="Hide"
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

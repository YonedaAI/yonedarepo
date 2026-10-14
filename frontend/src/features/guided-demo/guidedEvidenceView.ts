import type { GuidedEvidence, GuidedSession, GuidedStepId } from '../../../../shared/guided-runs';

const plainLabels: Record<string, string> = {
  checked_source: 'Passed independent checks',
  shared_contract: 'Agents agreed on a shared contract',
  collaboration: 'Agents worked in parallel',
  design_choice: 'Design decision recorded',
  scoped_resolution: 'Overlapping changes reconciled and re-checked',
  publication_readback: 'Published by you',
  owner_rejection: 'Rejected by you',
};

/** Plain wording for a recorded evidence kind; unknown kinds keep the server's own label. */
export function evidenceLabel(evidence: Pick<GuidedEvidence, 'kind' | 'label'>) {
  if (plainLabels[evidence.kind]) return plainLabels[evidence.kind];
  if (evidence.kind.includes('continuation') || evidence.kind.includes('context'))
    return 'Reused the earlier decision';
  return evidence.label;
}

const designChoicePrefix = 'Recorded design choice: ';
/** The recorded decision text itself, without the server's sentence prefix. */
export function designChoiceText(evidence: Pick<GuidedEvidence, 'kind' | 'label'>) {
  if (evidence.kind !== 'design_choice') return '';
  return evidence.label.startsWith(designChoicePrefix)
    ? evidence.label.slice(designChoicePrefix.length)
    : evidence.label;
}

/** Which workspace view the existing inspect target opens for this evidence. */
export function evidenceInspectKind(evidence: Pick<GuidedEvidence, 'kind' | 'verified'>) {
  if (evidence.kind.includes('context') || evidence.kind === 'design_choice') return 'context';
  if (evidence.kind.includes('resolution') && evidence.verified) return 'conflict';
  return evidence.kind;
}

export type GuidedProgressState = 'done' | 'current' | 'attention' | 'upcoming';
export const progressLabels: Record<GuidedStepId, string> = {
  build: 'Build together',
  extend: 'Continue from context',
  concurrent: 'Reconcile changes',
  review: 'Review & publish',
};

/** One progress state per step, driven only by server step status and `next_step`. */
export function guidedProgress(session: GuidedSession) {
  const steps = (Object.keys(progressLabels) as GuidedStepId[]).flatMap((id) => {
    const step = session.steps.find((item) => item.id === id);
    if (!step) return [];
    const state: GuidedProgressState =
      step.status === 'complete'
        ? 'done'
        : step.status === 'needs_attention'
          ? 'attention'
          : step.status === 'running' || session.next_step === id
            ? 'current'
            : 'upcoming';
    return [{ id, label: progressLabels[id], state }];
  });
  return { steps, complete: steps.filter((step) => step.state === 'done').length };
}

/** Plain description of what a running step is doing; durations are typical, not promised. */
export const runningExplanations: Record<GuidedStepId, string> = {
  build:
    'Specialist agents are building the task logic and its interface against a shared contract, then independent checks run on the combined result. Usually 10–30 min.',
  extend:
    'New agents are adding bookmarks, reusing the earlier decision about stable task IDs, then fresh checks run. Usually 10–20 min.',
  concurrent:
    'Two agents are making overlapping changes from the same starting point. A coordinator will reconcile them, then fresh checks run. Usually 20–40 min.',
  review: 'Publishing your decision and confirming it in the repository. Usually under a minute.',
};

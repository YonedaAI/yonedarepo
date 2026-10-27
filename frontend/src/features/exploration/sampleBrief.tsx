import type { RunSample } from '../../../../shared/run-samples';
import type { Snapshot } from '../../lib/types';
import { automaticAgent } from './adaptiveDraft';
import type { InitialRun } from './restartRun';
import { runDraft } from './runDraft';

/** Examples change the requested goal while retaining the project's source, context and checks. */
export function sampleBrief(
  snapshot: Snapshot,
  base: InitialRun | undefined,
  sample: RunSample,
): InitialRun {
  const draft = runDraft(snapshot, base);
  return {
    ...base,
    id: '',
    intent: sample.intent,
    criteria: [...new Set([...draft.criteria.split('\n'), ...sample.criteria])],
    agents: Array.from({ length: sample.id === 'build-together' ? 2 : 1 }, automaticAgent),
    context: draft.context,
    budgets: draft.budgets,
    policy: draft.policy,
    // Building together means a team on a task list the owner writes before starting.
    mode: sample.id === 'build-together' ? 'collaborate' : 'compare',
  };
}

export function SampleBriefSummary({ sample }: { sample?: RunSample }) {
  return sample ? <p className="sample-brief-summary">{sample.summary}</p> : null;
}

export const briefStarters = [
  {
    label: 'Build new',
    placeholder: 'Describe what you want to build, who it is for, and how you will know it works…',
  },
  {
    label: 'Add feature',
    placeholder:
      'Describe the feature, where it belongs in this project, and the behavior to preserve…',
  },
  {
    label: 'Fix bug',
    placeholder: 'What happens now? What should happen? Include steps to reproduce the problem…',
  },
];

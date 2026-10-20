import plans from '../../backend/crates/yoneda-agents-core/src/guided_plans.json';
import type { GuidedStepId } from '../../shared/guided-runs';
import { guidedFailure } from './guided-profile';
import type { ModelMix } from './model-mix';
import type { Json } from './types';

/** Guide v2 data shared with the Rust tests that run the planner-output validator on it. */
export const guidedPlanVersion = plans.version;
export const guidedModelMix: ModelMix = plans.model_mix;

/** The fixed roster roles and validated team DAG for one guided run. */
export function guidedFixedPlan(
  step: GuidedStepId,
  ordinal: number,
): { roles: string[]; plan: Json } {
  const runs: Array<{ roles: string[]; plan: Json }> =
    step === 'build' || step === 'extend' || step === 'concurrent' ? plans.steps[step] : [];
  const entry = runs[ordinal];
  if (!entry)
    throw guidedFailure('GUIDED_PROFILE_UNAVAILABLE', 'This guide step has no fixed team plan.');
  // Copy so an approval never aliases the shared module data.
  return structuredClone(entry);
}

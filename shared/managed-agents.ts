// The maintained reviewer catalog. Public model and wire contracts remain available here.

import type { ManagedAgentDefinition, Trigger } from './managed-agent-types';
import { MANAGED_INSTRUCTIONS } from './managed-instructions';

export * from './managed-agent-types';
export * from './managed-contracts';
export * from './managed-models';

const TRIGGER: Trigger = { when: 'push', changes: 'ready_for_review', paths: [], branches: [] };

export const MANAGED_AGENTS: readonly ManagedAgentDefinition[] = [
  {
    id: 'code-review',
    pitch: 'Reads every change like a careful colleague and flags the bugs worth fixing first.',
    icon: 'code',
    check: 'code-review',
    value_type: 'pass_fail',
    polarity: 'lower_is_better',
    defaults: {
      name: 'Code review',
      description: 'Finds correctness bugs, broken edge cases and risky changes, line by line.',
      // Live on dev (2026-10-30): GLM-5.3 Flash missed the seeded off-by-one once and failed
      // to run once; GPT-5.6 Luna found all three seeded problems for $0.007.
      harness: 'codex',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      reasoning: 'medium',
      timeout_minutes: 20,
      instructions: MANAGED_INSTRUCTIONS['code-review'],
      trigger: TRIGGER,
      block_at: null,
    },
    // No fallback: the cheaper GLM-5.3 Flash failed this agent's acceptance, and a reviewer that
    // misses bugs would pass the check; a failed run is the honest outcome.
    fallback: [],
    cost_cap_usd: 1,
  },
  {
    id: 'security-review',
    pitch: 'Checks each change for the holes attackers look for, before it lands.',
    icon: 'shield',
    check: 'security-review',
    value_type: 'pass_fail',
    polarity: 'lower_is_better',
    defaults: {
      name: 'Security review',
      description:
        'Looks for injection, missing access checks, leaked secrets and unsafe input handling.',
      harness: 'claude-code',
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      reasoning: 'medium',
      timeout_minutes: 20,
      instructions: MANAGED_INSTRUCTIONS['security-review'],
      trigger: TRIGGER,
      block_at: null,
    },
    fallback: [],
    cost_cap_usd: 3,
  },
  {
    id: 'slop-review',
    pitch:
      'Catches dead code, debug leftovers and drift from your conventions while they are small.',
    icon: 'siren',
    check: 'slop-review',
    value_type: 'level',
    polarity: 'lower_is_better',
    defaults: {
      name: 'Slop review',
      description:
        'Spots sloppy patterns before they spread: leftovers, duplication, vague comments, filler.',
      harness: 'codex',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      reasoning: 'low',
      timeout_minutes: 15,
      instructions: MANAGED_INSTRUCTIONS['slop-review'],
      trigger: TRIGGER,
      block_at: 'high',
    },
    // Keep the configured model and cap: an unavailable reviewer fails instead of silently
    // switching models. Retained-repository acceptance is recorded separately from local tests.
    fallback: [],
    cost_cap_usd: 0.5,
  },
  {
    id: 'intent-drift',
    pitch: 'Compares each change with the flight plan filed for it and says if the work drifted.',
    icon: 'compass',
    verdict: true,
    check: 'intent-drift',
    value_type: 'level',
    polarity: 'lower_is_better',
    defaults: {
      name: 'Intent drift',
      description:
        'Reads the goal filed before the work against the diff. A change with no plan costs nothing.',
      harness: 'codex',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      reasoning: 'low',
      timeout_minutes: 15,
      instructions: MANAGED_INSTRUCTIONS['intent-drift'],
      trigger: TRIGGER,
      block_at: 'high',
    },
    fallback: [],
    cost_cap_usd: 0.5,
  },
];

/** Medium findings on distinct lines of a change that make a level agent's result `high`. */
export const HIGH_LEVEL_FINDINGS = 5;

export const managedAgent = (id: string) => MANAGED_AGENTS.find((a) => a.id === id);

/** Brief starters request evidence; they are never receipts that the behavior occurred. */
export interface RunSample {
  id: string;
  version: 1;
  label: string;
  summary: string;
  starter: 'feature' | 'bug';
  intent: string;
  criteria: string[];
  evidence_targets: string[];
}

export const runSamples: RunSample[] = [
  {
    id: 'build-together',
    version: 1,
    label: 'Build together',
    summary: 'Two agents contribute complementary changes to one checked result.',
    starter: 'feature',
    intent:
      'Inspect this project and implement one useful feature as complementary tasks, one per agent, that can run concurrently on the same base. Use the existing source and checks. Each agent lands its task on the team branch; the merge is the result to check. Do not replace the project with a new example.',
    criteria: [
      'Preserve existing behavior and checks',
      'Each task changes only its own files, so the landings merge cleanly',
      'Record independent verification of the merged revision',
    ],
    evidence_targets: ['concurrent_contributions', 'team_branch_merge', 'checked_integration'],
  },
  {
    id: 'context-continuation',
    version: 1,
    label: 'Continue from context',
    summary: 'Use previous decisions to add a feature or fix a bug.',
    starter: 'feature',
    intent:
      'Inspect the current project and its prior run decisions. Identify a useful small follow-up feature or bug fix. Retrieve relevant prior intent and evidence, explain which earlier decisions constrain this change, coordinate the work and integrate one independently checked result. Ask for clarification if prior intent is missing or contradictory.',
    criteria: [
      'Preserve the previous approved intent',
      'Cite relevant earlier context when it exists',
      'Check the exact updated revision',
    ],
    evidence_targets: ['prior_context_access', 'revision_bound_citations', 'checked_continuation'],
  },
  {
    id: 'conflict-resolution',
    version: 1,
    label: 'Resolve conflicting changes',
    summary: 'Reconcile an existing conflict using the original intent.',
    starter: 'bug',
    intent:
      'Inspect this project for recorded stale candidates or unresolved source conflicts. Resolve an existing conflict using the original intent and both contributions, preserving unrelated changes, and independently check the resolved revision. If no source conflict exists, report that clearly and ask which changes should be reconciled. Do not manufacture a conflict receipt or claim a merge that did not occur.',
    criteria: [
      'Preserve both intended contributions',
      'Explain the resolution and unresolved tradeoffs',
      'Independently check the exact resolved revision',
    ],
    evidence_targets: [
      'recorded_source_conflict',
      'intent_based_resolution',
      'fresh_resolution_checks',
    ],
  },
];

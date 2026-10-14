/** Public guide contracts. The repository ledger decides progress from recorded evidence. */
export const guidedProfileId = 'task-board-v1' as const;
/** Brief versions of the one profile; all share the starter and the immutable oracle.
 * A project and its session stay pinned to the version recorded at creation. */
export const guidedProfileVersions = [1, 2] as const;
export type GuidedProfileVersion = (typeof guidedProfileVersions)[number];
export const isGuidedProfileVersion = (value: unknown): value is GuidedProfileVersion =>
  guidedProfileVersions.includes(value as GuidedProfileVersion);
export type GuidedStepId = 'build' | 'extend' | 'concurrent' | 'review';
export type GuidedCheckPhase = 'build' | 'extend' | 'parallel' | 'final';
export type GuidedStepStatus = 'ready' | 'running' | 'complete' | 'needs_attention' | 'locked';
export interface GuidedRunBinding {
  session_id: string;
  profile_id: typeof guidedProfileId;
  version: GuidedProfileVersion;
  step_id: Exclude<GuidedStepId, 'review'>;
  check_phase: GuidedCheckPhase;
  variant?: 'filter' | 'sort';
}

export interface GuidedEvidence {
  kind: string;
  label: string;
  verified: boolean;
  run_id?: string;
  candidate_id?: string;
  record_id?: string;
  revision?: string;
  /** Owner rejection evidence: the recorded decision and its reason. */
  decision_id?: string;
  reason?: string;
}
export interface GuidedStep {
  id: GuidedStepId;
  status: GuidedStepStatus;
  run_ids: string[];
  candidate_id?: string | null;
  revision?: { repository: string; commit: string } | null;
  evidence: GuidedEvidence[];
  next_action?: string | null;
  /** Attempt that `run_ids` belongs to; 1 until a step is retried. */
  attempt?: number;
  /** Runs of earlier attempts, kept as history but no longer judged. */
  previous_run_ids?: string[];
}
export interface GuidedSession {
  session_id: string;
  profile_id: typeof guidedProfileId;
  version: GuidedProfileVersion;
  steps: GuidedStep[];
  next_step: GuidedStepId | null;
  working_branch_id?: string | null;
  working_revision?: { repository: string; commit: string } | null;
  working_version?: number;
}
export interface StartGuidedStep {
  request_id: string;
  session_id: string;
  profile_id: typeof guidedProfileId;
  step_id: GuidedStepId;
  expected_commit: string;
  expected_version: number;
  /** Start a fresh attempt of a step that needs attention; prior runs must all be terminal. */
  retry?: true;
}
/** Deterministic run identity; must match the native ledger's allocation exactly. */
export const guidedRunId = (prefix: string, step: GuidedStepId, ordinal: number, attempt = 1) =>
  `guide-${prefix}-${step}-${ordinal}${attempt > 1 ? `-r${attempt}` : ''}`;
export const guidedSteps: ReadonlyArray<{
  id: GuidedStepId;
  title: string;
  description: string;
  action: string;
}> = [
  {
    id: 'build',
    title: 'Build together',
    description: 'Agents coordinate task behavior and its interface into one checked result.',
    action: 'Build together',
  },
  {
    id: 'extend',
    title: 'Continue from context',
    description: 'New agents add bookmarks using decisions from the previous run.',
    action: 'Continue from context',
  },
  {
    id: 'concurrent',
    title: 'Reconcile concurrent changes',
    description: 'Two enhancements start from the same source, then agents reconcile their edits.',
    action: 'Start concurrent changes',
  },
  {
    id: 'review',
    title: 'Review and publish',
    description: 'Inspect the changes, reasons and checks, then decide what ships.',
    action: 'Review result',
  },
];

export const guidedBuildIntent =
  'Build a small task board in this fresh project. Implement add, complete and search behavior in public/tasks.mjs, and a clear keyboard-accessible interface in public/index.html, public/app.mjs and public/style.css. Coordinate at least two complementary specialists through a shared interface contract, then integrate their captured contributions. Task records use {id,title,completed}; export addTask(tasks,title,id), completeTask(tasks,id), and visibleTasks(tasks,options). Return arrays of task records; keep IDs assigned once and stable. Search title text case-insensitively. Record the stable-identity decision and why replacing IDs during edits would lose references. Independently check the integrated revision.';

export const guidedExtendIntent =
  'Continue this task board with bookmarkable links to individual tasks. Inspect prior decisions and source before editing, cite the relevant decision, and explain how it influenced your implementation. Add taskLink(task) returning a #task= URL fragment and resolveTaskLink(tasks,fragment) returning the matching task or null. Wire links into the interface and preserve earlier behavior. Review the exact resulting files and independent checks.';

export const guidedConcurrentIntents = [
  'Add status filtering to the existing task board. Modify visibleTasks(tasks,options) in public/tasks.mjs to support options.status: all, active or completed. Preserve existing title search and task identity. Implement only this enhancement; title sorting belongs to the concurrent run. Integrate this feature with the existing interface contract and retrieve relevant prior decisions. This run shares a frozen source base with a concurrent sorting enhancement; coordinate recovery if your captured result becomes stale. Read actual conflict evidence, preserve both enhancements, record why the resolution is correct, and obtain fresh checks.',
  'Add title sorting to the existing task board. Modify visibleTasks(tasks,options) in public/tasks.mjs to support options.sort: title-asc or title-desc; omitted sort preserves source order. Preserve existing title search and task identity. Implement only this enhancement; status filtering belongs to the concurrent run. Integrate this feature with the existing interface contract and retrieve relevant prior decisions. This run shares a frozen source base with a concurrent status-filter enhancement; coordinate recovery if your captured result becomes stale. Read actual conflict evidence, preserve both enhancements, record why the resolution is correct, and obtain fresh checks.',
] as const;

/** Version 2: one short plain prompt per step; the starter and the oracle are the same as version 1. */
export const guidedIntentsV2 = {
  build:
    "Build a simple, polished task board website: add, complete, delete and search tasks, with three sample tasks, clean responsive cards and dark mode. Put the task logic in public/tasks.mjs as addTask(tasks,title,id), completeTask(tasks,id) and visibleTasks(tasks,options) using {id,title,completed}, where options.query searches titles case-insensitively; keep each task's id stable, and record that decision with your reason so later agents can build on it. Save tasks in localStorage when the browser allows it and keep working in memory when it is blocked.",
  extend:
    'Add bookmark links to the task board so each task can be shared and opened directly, with the linked task highlighted. In public/tasks.mjs, add taskLink(task) returning a #task= URL fragment and resolveTaskLink(tasks,fragment) returning the matching task or null. Keep everything that already works, and check the earlier design note before you start.',
  concurrent: [
    'Add a status filter to the task board so people can show all, active or completed tasks. Support it in public/tasks.mjs through visibleTasks(tasks,options) with options.status set to all, active or completed, and keep search working. Someone else is adding title sorting at the same time, so if your changes overlap, keep both features working.',
    'Add title sorting to the task board so people can sort tasks A to Z or Z to A. Support it in public/tasks.mjs through visibleTasks(tasks,options) with options.sort set to title-asc or title-desc, keep the original order when no sort is chosen, and keep search working. Someone else is adding a status filter at the same time, so if your changes overlap, keep both features working.',
  ],
} as const;

export interface GuidedIntents {
  build: string;
  extend: string;
  concurrent: readonly [string, string];
}
/** The briefs a session's recorded version was created with. */
export function guidedIntents(version: GuidedProfileVersion): GuidedIntents {
  return version === 2
    ? guidedIntentsV2
    : { build: guidedBuildIntent, extend: guidedExtendIntent, concurrent: guidedConcurrentIntents };
}

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import plans from '../../../../backend/crates/yoneda-agents-core/src/guided_plans.json';
import type { Snapshot } from '../../lib/types';
import { RunComposer } from './RunComposer';
import { RunEvidenceBoundary } from './RunEvidenceBoundary';
import { initialRun } from './restartRun';
import { workingBranches } from './workingBranchView';
import { workingRun } from './workingRun';

// Mirrors a guided v2 run after adaptive approval (cloudflare/worker/guided-preparation.ts and
// adaptive-approval.ts): collaborate mode, a fixed team plan, per-role low effort and a model mix.
const fixed = plans.steps.build[0];
const resolved = fixed.roles.map((role, index) => ({
  connection: index < 2 ? 'codex-specialist' : 'zai-coordinator',
  provider: index < 2 ? 'codex' : 'zai',
  model: index < 2 ? 'gpt-5.6-luna' : 'glm-5.3-flash',
  label: 'Workspace model',
  reasoning_effort: 'low',
  role_hint: role,
  strategy: `${role} team participant ${index + 1}`,
}));
const run = {
  id: 'guided-build-0-1',
  intent: 'Build the task board.',
  mode: 'collaborate',
  criteria: ['Preserve all earlier behavior', 'Pass the immutable phase-specific checks'],
  context: [],
  adaptive_team: {
    version: 1,
    requested_agents: fixed.roles.map((role) => ({
      connection: null,
      role,
      reasoning_effort: 'low',
    })),
    model_mix: plans.model_mix,
  },
  agents: resolved,
  team_plan: fixed.plan,
  team_plan_revision: 1,
  model_budgets: resolved.map((agent) => ({
    provider: agent.provider,
    model: agent.model,
    max_requests: 144,
    max_output_tokens: 4096,
    max_execution_ms: 600000,
    spend_limit_microusd: 5_000_000,
    pricing: {
      input_microusd_per_million: 1_000_000,
      output_microusd_per_million: 4_000_000,
      source: 'provider price list',
    },
  })),
  delegation: { enabled: false, max_depth: 0, max_executions: 3 },
  autonomy_policy: { version: 1, enabled: true, max_repair_rounds: 2 },
  working_branch_id: 'work-1',
  guided: { session_id: 'guide-1', step_id: 'build', ordinal: 0, attempt: 1 },
  status: 'completed',
};
const branch = {
  id: 'work-1',
  status: 'active',
  version: 2,
  working_commit: 'w2',
  working_revision: { repository: 'repo/fork', commit: 'w2' },
  canonical_base_commit: 'c1',
  canonical_base_version: 1,
  latest_candidate_id: 'cand-1',
};
const snapshot = {
  capabilities: {
    collaborative_runs: 1,
    team_planning: 1,
    working_branches: 1,
    agent_limits: {
      min_root_agents: 1,
      max_root_agents: 6,
      max_run_executions: 12,
      max_delegation_depth: 1,
      max_run_model_requests: null,
    },
  },
  repository: {
    id: 'repo',
    version: 1,
    status: 'ready',
    pending: null,
    head_commit: 'c1',
    published_commit: 'c1',
    policy: { build: { setup: [], checks: [{ name: 'test', command: ['npm', 'test'] }] } },
  },
  working_branches: [branch],
  runs: [run],
  executions: resolved.map((agent, index) => ({
    id: `exec-${index}`,
    run_id: run.id,
    role: 'coding',
    parent_execution: null,
    ...agent,
  })),
  candidates: [
    {
      id: 'cand-1',
      run_id: run.id,
      execution: 'exec-2',
      revision: { repository: 'repo/fork', commit: 'c1' },
    },
  ],
  evaluations: [],
  decisions: [
    {
      id: 'decision-1',
      status: 'published',
      run_id: run.id,
      candidate: 'cand-1',
      target: { commit: 'c1' },
    },
  ],
  nodes: [],
  edges: [],
  artifacts: [],
} as unknown as Snapshot;

function renderComposer(source: Snapshot, initial: ReturnType<typeof workingRun>) {
  return renderToStaticMarkup(
    createElement(RunComposer, {
      snapshot: source,
      busy: false,
      initialRun: initial,
      onStart: async () => {},
      onClose: () => {},
      onProviders: () => {},
    }),
  );
}
function renderContinuation(source: Snapshot) {
  const [active] = workingBranches(source);
  return renderComposer(source, workingRun(source, active));
}
function withRun(patch: Record<string, unknown>) {
  return { ...snapshot, runs: [{ ...run, ...patch }] } as unknown as Snapshot;
}

describe('Continue checked work on a guided-shaped run', () => {
  it('renders an editable brief for collaborate + fixed plan + per-role effort', () => {
    const html = renderContinuation(snapshot);
    expect(html).toContain('aria-label="Start a run"');
    expect(html).toContain('Continue on working branch work-1');
    expect(html).toContain('Previous manual team plan');
  });

  // Recorded runs are untrusted history: a field the composer does not expect must never blank the app.
  it.each([
    ['a team plan without tasks', { team_plan: { version: 1, contract: 'Shared API' } }],
    [
      'a task without write paths',
      { team_plan: { ...fixed.plan, tasks: [{ id: 'behavior', title: 'Task behavior' }] } },
    ],
    ['a non-text contract', { team_plan: { ...fixed.plan, contract: { text: 'Shared API' } } }],
    ['a team plan that is not an object', { team_plan: 'fixed-v2' }],
    ['criteria recorded as text', { criteria: 'Preserve all earlier behavior' }],
    ['context recorded as an object', { context: { ids: ['decision-0'] } }],
    ['model budgets recorded as an object', { model_budgets: { codex: resolved[0] } }],
  ])('keeps the brief usable with %s', (_label, patch) => {
    const source = withRun(patch);
    for (const initial of [
      workingRun(source, workingBranches(source)[0]),
      initialRun(source, source.runs[0]),
    ]) {
      const html = renderComposer(source, initial);
      expect(html).toContain('What would you like to do?');
      expect(html).toContain('Start a Run</button>');
    }
  });
  it('drops an unreadable previous plan instead of showing a partial one', () => {
    const html = renderContinuation(withRun({ team_plan: { version: 1, contract: 'Shared API' } }));
    expect(html).not.toContain('Previous manual team plan');
  });
});

describe('run settings error boundary', () => {
  it('shows an inline error with Close instead of replacing the app', () => {
    let closed = 0;
    const boundary = new RunEvidenceBoundary({
      children: null,
      label: 'run settings',
      onClose: () => closed++,
    });
    boundary.state = RunEvidenceBoundary.getDerivedStateFromError();
    const tree = boundary.render() as ReturnType<typeof createElement>;
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Couldn’t load run settings');
    expect(html).toContain('>Close</button>');
    type Child = { props: { children?: unknown; onClick?: () => void } } | false | null;
    const children = (tree.props as { children: Child[] }).children.flat();
    const close = children.find((child) => child && child.props.children === 'Close');
    if (!close) throw new Error('Close action is missing');
    close.props.onClick?.();
    expect(closed).toBe(1);
  });
});

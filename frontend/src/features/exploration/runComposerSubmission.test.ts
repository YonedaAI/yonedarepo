import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../lib/types';

const hooks = vi.hoisted(() => ({
  cells: [] as unknown[],
  cursor: 0,
  refs: [] as { current: unknown }[],
  refCursor: 0,
  effects: [] as (() => unknown)[],
  api: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api: hooks.api, short: (s: string) => s }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (initial: unknown) => (hooks.refs[hooks.refCursor++] ??= { current: initial }),
  useEffect: (effect: () => unknown) => {
    hooks.effects.push(effect);
  },
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.cells)) hooks.cells[i] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.cells[i],
      (value: unknown) => {
        hooks.cells[i] = typeof value === 'function' ? value(hooks.cells[i]) : value;
      },
    ];
  },
}));

import { RunModePicker } from '../team/RunModePicker';
import { TeamPlanOptions } from '../team/TeamPlanOptions';
import { AgentRoster } from './AgentRoster';
import { DelegationSettings } from './DelegationSettings';
import { RunComposer } from './RunComposer';
import { readAllowance } from './WorkspaceAllowance';

const snapshot = {
  repository: { id: 'repo', policy: { build: { setup: [], checks: [] } } },
  capabilities: {
    collaborative_runs: 1,
    team_planning: 1,
    agent_limits: {
      min_root_agents: 1,
      max_root_agents: 4,
      max_run_executions: 8,
      max_delegation_depth: 1,
      max_run_model_requests: 60,
    },
  },
  runs: [],
  executions: [],
  candidates: [],
  evaluations: [],
  decisions: [],
  nodes: [],
  edges: [],
} as unknown as Snapshot;
const start = vi.fn();
function find(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, any>>) => boolean,
): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map((item) => find(item, predicate)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement<Record<string, any>>;
  return predicate(el) ? el : find(el.props.children, predicate);
}
function render(extra = {}) {
  hooks.cursor = 0;
  hooks.refCursor = 0;
  return RunComposer({
    snapshot,
    busy: false,
    onStart: start,
    onClose: () => {},
    onProviders: () => {},
    ...extra,
  });
}
function enterBrief() {
  find(render(), (el) => el.type === 'textarea' && el.props.maxLength === 16000)?.props.onChange({
    target: { value: 'Fix duplicate registration' },
  });
}
async function submit(extra = {}) {
  render(extra).props.onSubmit({ preventDefault: () => {} });
  await Promise.resolve();
  await Promise.resolve();
}
beforeEach(() => {
  hooks.cells = [];
  hooks.refs = [];
  hooks.effects = [];
  hooks.api.mockReset();
  start.mockReset().mockResolvedValue(undefined);
});
describe('preference-only brief submission', () => {
  it('submits one Auto seed while provider metadata loads, with no client authority claims', async () => {
    enterBrief();
    await submit({ sampleProfileId: 'build-together' });
    expect(hooks.api).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][0]).toMatchObject({
      mode: 'collaborate',
      intent: 'Fix duplicate registration',
      sample_profile_id: 'build-together',
      adaptive_team: { version: 1, requested_agents: [{ connection: null, role: 'auto' }] },
    });
    for (const field of [
      'agents',
      'model_budgets',
      'autonomy_policy',
      '_approved_model_pool',
      'workspace_spend',
      'delegation',
      'team',
    ])
      expect(start.mock.calls[0][0]).not.toHaveProperty(field);
  });
  it('retains explicit seed roles and compare delegation preferences', async () => {
    enterBrief();
    find(render(), (el) => el.type === AgentRoster)?.props.onChange([
      { id: 'a', connection: '', role: 'backend', strategy: 'Team participant' },
      { id: 'b', connection: '', role: 'testing', strategy: 'Team participant' },
    ]);
    find(render(), (el) => el.type === RunModePicker)?.props.onChange('compare');
    find(render(), (el) => el.type === DelegationSettings)?.props.onChange({
      enabled: true,
      max_depth: 1,
      max_executions: 4,
    });
    await submit();
    expect(start.mock.calls[0][0]).toMatchObject({
      mode: 'compare',
      adaptive_team: {
        requested_agents: [
          { connection: null, role: 'backend' },
          { connection: null, role: 'testing' },
        ],
      },
      delegation: { enabled: true, max_depth: 1, max_executions: 4 },
    });
  });
  it('keeps manual task indices aligned with the requested seed order', async () => {
    enterBrief();
    find(render(), (el) => el.type === AgentRoster)?.props.onChange([
      { id: 'a', connection: '', role: 'backend', strategy: 'Team participant' },
      { id: 'b', connection: '', role: 'review', strategy: 'Team participant' },
    ]);
    const plan = find(render(), (el) => el.type === TeamPlanOptions);
    plan?.props.onManualChange(true);
    plan?.props.onChange({
      contract: 'API schema stays compatible',
      integratorId: 'b',
      integrationPaths: 'src/',
      tasks: [
        {
          id: 'api',
          title: 'Repair API',
          instructions: 'Add the regression test and fix',
          agentId: 'a',
          dependsOn: [],
          writePaths: 'src/api.ts',
        },
      ],
    });
    await submit();
    expect(start.mock.calls[0][0]).toMatchObject({
      mode: 'collaborate',
      team: { integrator_agent: 1, tasks: [{ agent: 0 }] },
      adaptive_team: {
        requested_agents: [
          { connection: null, role: 'backend' },
          { connection: null, role: 'review' },
        ],
      },
    });
  });
  it('retains the submitted brief while checking an unconfirmed start', async () => {
    enterBrief();
    start.mockRejectedValueOnce(new Error('timeout'));
    await submit();
    enterBrief();
    await submit({ startUncertain: true });
    expect(start.mock.calls[1][0]).toBe(start.mock.calls[0][0]);
  });
});
describe('workspace allowance readback', () => {
  it('accepts version zero and reserved funds without inventing a default receipt', () => {
    const value = {
      version: 0,
      limit_microusd: 50000000,
      charged_microusd: 2000000,
      reserved_microusd: 1000000,
      remaining_microusd: 47000000,
    };
    expect(readAllowance(value)).toEqual(value);
    for (const invalid of [
      null,
      {},
      { ...value, remaining_microusd: -1 },
      { ...value, version: 0.5 },
      { ...value, charged_microusd: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(readAllowance(invalid)).toBeUndefined();
  });
});

import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../lib/types';

const state = vi.hoisted(() => ({
  cells: [] as unknown[],
  cursor: 0,
  refs: [] as { current: unknown }[],
  refCursor: 0,
  api: vi.fn(),
}));
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  api: state.api,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: () => {},
  useRef: (initial: unknown) => (state.refs[state.refCursor++] ??= { current: initial }),
  useState: (initial: unknown) => {
    const i = state.cursor++;
    if (!(i in state.cells)) state.cells[i] = typeof initial === 'function' ? initial() : initial;
    return [
      state.cells[i],
      (value: unknown) => {
        state.cells[i] = typeof value === 'function' ? value(state.cells[i]) : value;
      },
    ];
  },
}));

import { Exploration } from './Exploration';
import { RunToolbar } from './RunToolbar';

const branch = {
  id: 'new-branch',
  status: 'active',
  version: 0,
  working_commit: 'published',
  working_revision: { repository: 'fixture/fork', commit: 'published' },
  canonical_base_commit: 'published',
  latest_candidate_id: null,
};
const snapshot = {
  capabilities: { working_branches: 1 },
  repository: {
    id: 'repo',
    version: 1,
    head_commit: 'published',
    published_commit: 'published',
    status: 'ready',
    pending: null,
    policy: { build: { setup: [], checks: [] } },
  },
  working_branches: [],
  executions: [],
  runs: [],
  candidates: [],
  evaluations: [],
  decisions: [],
  nodes: [],
  edges: [],
  artifacts: [],
  seq: 1,
} as unknown as Snapshot;
const props = {
  snapshot,
  onChange: async () => {},
  onError: vi.fn(),
  onProviders: () => {},
  onAgents: () => {},
  onContext: () => {},
  onSelectedRun: () => {},
};
function find(node: ReactNode, type: unknown): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map((item) => find(item, type)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const element = node as ReactElement<Record<string, any>>;
  return element.type === type ? element : find(element.props.children, type);
}
function render() {
  state.cursor = 0;
  state.refCursor = 0;
  return Exploration(props);
}
beforeEach(() => {
  state.cells = [];
  state.refs = [];
  state.api.mockReset();
  props.onError.mockReset();
});
describe('first working build', () => {
  it('creates one canonical-leased branch before opening an editable brief, without starting inference', async () => {
    const callback = find(render(), RunToolbar)?.props.onNewRun;
    let finish: (value: unknown) => void = () => {};
    state.api.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = callback();
    const second = callback();
    expect(state.api).toHaveBeenCalledTimes(1);
    expect(state.api).toHaveBeenCalledWith(
      'repos/repo/create_working_branch',
      expect.objectContaining({ expected_commit: 'published', expected_version: 1 }),
    );
    finish(branch);
    await Promise.all([first, second]);
    expect(state.api.mock.calls.some(([path]) => path.includes('start_run'))).toBe(false);
    expect(state.cells).toContain(true);
  });
  it('reports branch creation failure and leaves the brief closed', async () => {
    state.api.mockRejectedValue(new Error('Canonical lease moved'));
    await find(render(), RunToolbar)?.props.onNewRun();
    expect(props.onError).toHaveBeenCalledWith('Canonical lease moved');
    expect(state.cells[2]).toBe(false);
  });
});

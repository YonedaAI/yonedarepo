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

import { runSamples } from '../../../../shared/run-samples';
import { Dialog } from '../../components/Dialog';
import { Exploration } from './Exploration';
import { RunEvidenceBoundary } from './RunEvidenceBoundary';
import { RunSamples } from './RunSamples';
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
function composer(node: ReactNode): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map(composer).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const element = node as ReactElement<Record<string, any>>;
  return typeof element.props.onStart === 'function' ? element : composer(element.props.children);
}
beforeEach(() => {
  state.cells = [];
  state.refs = [];
  state.api.mockReset();
  props.onError.mockReset();
});
describe('first working build', () => {
  it('shares the exact compose callback between the toolbar and empty card', async () => {
    const tree = render();
    const cardStart = find(tree, 'button');
    expect(cardStart?.props.children).toBe('Start a Run');
    expect(cardStart?.props.onClick).toBe(find(tree, RunToolbar)?.props.onNewRun);
    state.api.mockResolvedValueOnce(branch);
    await cardStart?.props.onClick();
    expect(state.api).toHaveBeenCalledOnce();
    expect(state.api.mock.calls[0][0]).toBe('repos/repo/create_working_branch');
    expect(composer(render())).toBeDefined();
  });
  it('isolates a composer failure inside the dialog with a Close action', async () => {
    state.api.mockResolvedValueOnce(branch);
    await find(render(), RunToolbar)?.props.onNewRun();
    const dialog = find(render(), Dialog);
    const boundary = find(dialog?.props.children, RunEvidenceBoundary);
    expect(boundary?.props.label).toBe('run settings');
    expect(composer(boundary?.props.children)).toBeDefined();
    boundary?.props.onClose();
    expect(composer(render())).toBeUndefined();
  });
  it('keeps the draft mounted during a provider detour and forwards the refresh callback', async () => {
    state.api.mockResolvedValue(branch);
    await find(render(), RunToolbar)?.props.onNewRun();
    const refresh = vi.fn();
    const prior = props.onProviders;
    props.onProviders = vi.fn();
    composer(render())?.props.onProviders(refresh);
    expect(composer(render())).toBeDefined();
    expect(props.onProviders).toHaveBeenCalledWith(refresh);
    props.onProviders = prior;
  });
  it.each(runSamples)(
    'opens $label with its own title and goal, without starting work',
    async (sample) => {
      state.api.mockResolvedValue(branch);
      await find(render(), RunSamples)?.props.onChoose(sample);
      const tree = render();
      const form = composer(tree);
      expect(find(tree, Dialog)?.props.title).toBe(sample.label);
      expect(form?.props.initialRun.intent).toBe(sample.intent);
      expect(form?.props.sampleProfileId).toBe(sample.id);
      expect(form?.props.initialRun.agents).toHaveLength(sample.id === 'build-together' ? 2 : 1);
      expect(
        form?.props.initialRun.agents.every(
          (agent: { connection: string }) => agent.connection === '',
        ),
      ).toBe(true);
      expect(String(form?.key)).toContain(sample.id);
      expect(state.api.mock.calls.some(([path]) => path.includes('start_run'))).toBe(false);
    },
  );
  it('a sample opens a fresh Auto brief with existing checks, without inference', async () => {
    state.api.mockResolvedValue(branch);
    const samples = find(render(), RunSamples);
    expect(samples).toBeDefined();
    await samples?.props.onChoose(runSamples[1]);
    const form = composer(render());
    expect(form?.props.initialRun.intent).toBe(runSamples[1].intent);
    expect(form?.props.initialRun.criteria).toEqual(expect.arrayContaining(runSamples[1].criteria));
    expect(form?.props.initialRun.agents).toHaveLength(1);
    expect(form?.props.initialRun.agents[0].connection).toBe('');
    expect(form?.props.sampleProfileId).toBe('context-continuation');
    expect(state.api.mock.calls.some(([path]) => path.includes('start_run'))).toBe(false);
  });
  it('reconciles a timed-out accepted run before retrying, without a second start', async () => {
    state.api.mockResolvedValueOnce(branch);
    await find(render(), RunToolbar)?.props.onNewRun();
    let accepted = '';
    state.api.mockImplementation(async (path, body) => {
      if (path.includes('start_run')) {
        accepted = body.id;
        throw Object.assign(new Error('20 second timeout'), { code: 'REQUEST_TIMEOUT' });
      }
      if (path.includes('run_detail')) return { run: { id: accepted } };
      throw new Error('unexpected request');
    });
    await expect(composer(render())?.props.onStart({ intent: 'Fix persistence' })).rejects.toThrow(
      'timeout',
    );
    await composer(render())?.props.onStart({ intent: 'Edited after timeout' });
    expect(state.api.mock.calls.filter(([path]) => path.includes('start_run'))).toHaveLength(1);
    expect(state.api.mock.calls.some(([path]) => path.includes(`run_id=${accepted}`))).toBe(true);
    expect(state.cells[1]).toBe(accepted);
  });
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

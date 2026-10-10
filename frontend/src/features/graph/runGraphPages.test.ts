import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Graph, Snapshot } from '../../lib/types';
import { mergeRunGraphPage } from './runGraphPages';

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
}));
const apiMock = vi.hoisted(() => vi.fn());
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (value: unknown) => {
        hooks.states[index] =
          typeof value === 'function'
            ? (value as (current: unknown) => unknown)(hooks.states[index])
            : value;
      },
    ];
  },
  useEffect: (effect: () => unknown) => {
    hooks.effects.push(effect);
  },
}));
vi.mock('../../lib/api', () => ({ api: apiMock }));
vi.mock('./ContextGraph', () => ({ ContextGraph: () => null }));
vi.mock('./EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('./EvidenceTrail', () => ({ EvidenceTrail: () => null }));
vi.mock('./GraphTools', () => ({ GraphTools: () => null }));

import { ContextGraph } from './ContextGraph';
import { GraphTools } from './GraphTools';
import { GraphWorkspace } from './GraphWorkspace';

beforeEach(() => {
  hooks.states = [];
  hooks.cursor = 0;
  hooks.effects = [];
  apiMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const node = (id: string) => ({
  id,
  kind: 'assertion',
  label: id,
  author: 'agent',
  recorded_at: 1,
  data: {},
});

describe('run graph page merging', () => {
  it('appends later pages without erasing assertions or duplicate context edges', () => {
    const first: Graph = {
      nodes: [node('intent'), node('assertion-1')],
      edges: [{ source: 'assertion-1', target: 'intent', relation: 'supports', evidence: 'first' }],
    };
    const merged = mergeRunGraphPage(first, {
      nodes: [node('assertion-2')],
      edges: [
        { source: 'assertion-1', target: 'intent', relation: 'supports' },
        { source: 'assertion-2', target: 'intent', relation: 'supports' },
      ],
      next_cursor: null,
      has_more: false,
      watermark: 9,
    });
    expect(merged.nodes.map((item) => item.id)).toEqual(['intent', 'assertion-1', 'assertion-2']);
    expect(merged.edges).toHaveLength(2);
    expect(merged.truncated).toBe(false);
  });

  it('pins later page requests to the first watermark and uses loaded run graph for paged full view', async () => {
    const snapshot = pagedSnapshot(['run-1']);
    apiMock
      .mockResolvedValueOnce(graphPage(['intent', 'assertion-1'], 'cursor-1', true, 27))
      .mockResolvedValueOnce(graphPage(['assertion-2'], null, false, 27));
    const view = () => GraphWorkspace({ snapshot, runId: 'run-1' });
    let tree = render(view);
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(hooks.states[8]).toBe('cursor-1'));
    await vi.waitFor(() => expect(hooks.states[10]).toBe(false));
    expect(hooks.states[6]).toBe('run-1');
    tree = render(view);
    const more = find(tree, 'button', 'Load more run context');
    expect(more).toBeDefined();
    more?.props.onClick();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock.mock.calls[1][0]).toContain('cursor=cursor-1');
    expect(apiMock.mock.calls[1][0]).toContain('watermark=27');
    await vi.waitFor(() =>
      expect(
        (hooks.states[5] as Graph).nodes.map((item: Graph['nodes'][number]) => item.id),
      ).toEqual(['intent', 'assertion-1', 'assertion-2']),
    );

    tree = render(view);
    find(tree, 'nav')?.props.children[1].props.onClick();
    tree = render(view);
    const tools = find(tree, GraphTools);
    expect(tools?.props.fullGraphLabel).toBe('Show loaded run graph');
    tools?.props.onGraph(null);
    tree = render(view);
    const loadedGraph = find(tree, ContextGraph)?.props.graph as Graph;
    expect(loadedGraph.nodes.map((item) => item.id)).toEqual([
      'intent',
      'assertion-1',
      'assertion-2',
    ]);
    expect(renderToStaticMarkup(tree)).toContain('Loaded run graph');
  });

  it('ignores an in-flight later page after the selected run changes', async () => {
    let resolveOldPage!: (page: ReturnType<typeof graphPage>) => void;
    const oldPage = new Promise<ReturnType<typeof graphPage>>((resolve) => {
      resolveOldPage = resolve;
    });
    apiMock
      .mockResolvedValueOnce(graphPage(['run1-intent'], 'run1-next', true, 31))
      .mockReturnValueOnce(oldPage)
      .mockResolvedValueOnce(graphPage(['run2-intent'], null, false, 42));
    const snapshot = pagedSnapshot(['run-1', 'run-2']);
    let selectedRun = 'run-1';
    const view = () => GraphWorkspace({ snapshot, runId: selectedRun });
    let tree = render(view);
    const firstEffects = hooks.effects.splice(0);
    const cleanupOldRun = firstEffects[1]?.() as (() => void) | undefined;
    await vi.waitFor(() => expect((hooks.states[5] as Graph).nodes[0]?.id).toBe('run1-intent'));
    await vi.waitFor(() => expect(hooks.states[8]).toBe('run1-next'));

    tree = render(view);
    hooks.effects.splice(0);
    find(tree, 'button', 'Load more run context')?.props.onClick();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));

    selectedRun = 'run-2';
    tree = render(view);
    cleanupOldRun?.();
    const newRunEffects = hooks.effects.splice(0);
    newRunEffects[1]?.();
    await vi.waitFor(() => expect((hooks.states[5] as Graph).nodes[0]?.id).toBe('run2-intent'));
    resolveOldPage(graphPage(['stale-run1-node'], null, false, 31));
    await vi.waitFor(() =>
      expect(
        (hooks.states[5] as Graph).nodes.map((item: Graph['nodes'][number]) => item.id),
      ).toEqual(['run2-intent']),
    );
    expect(renderToStaticMarkup(render(view))).toContain('run-2');
  });
});

function graphPage(
  ids: string[],
  next_cursor: string | null,
  has_more: boolean,
  watermark: number,
) {
  return {
    nodes: ids.map(node),
    edges: [],
    next_cursor,
    has_more,
    watermark,
  };
}

function pagedSnapshot(runIds: string[]): Snapshot {
  return {
    repository: {
      id: 'repo',
      name: 'repo',
      version: 1,
      status: 'ready',
      head_commit: 'head',
      published_commit: 'head',
      pending: null,
      remote: { namespace: 'test', name: 'repo' },
    },
    runs: runIds.map((id, index) => ({ id, status: 'ready', created_at: index + 1 })),
    executions: [],
    candidates: [],
    evaluations: [],
    decisions: [],
    artifacts: [],
    nodes: [],
    edges: [],
    seq: 1,
    graph_paged: true,
  };
}

function render(view: () => ReactElement) {
  hooks.cursor = 0;
  return view();
}

function find(
  element: ReactNode,
  type: string | ((...args: any[]) => unknown),
  label?: string,
): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(element)) return element.map((child) => find(child, type, label)).find(Boolean);
  if (!element || typeof element !== 'object' || !('props' in element)) return;
  const item = element as ReactElement<Record<string, any>>;
  if (
    item.type === type &&
    (!label || (typeof item.props.children === 'string' && item.props.children.includes(label)))
  )
    return item;
  return find(item.props.children, type, label);
}

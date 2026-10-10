import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Graph, GraphNode, Snapshot } from '../../lib/types';
import { EvidencePanel } from './EvidencePanel';
import { GraphWorkspace } from './GraphWorkspace';

// Exercise these views' state/effects in the existing Node test runner, without a DOM shim.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (value: unknown) => {
        hooks.states[index] = value;
      },
    ];
  },
  useEffect: (effect: () => unknown) => {
    hooks.effects.push(effect);
  },
}));
vi.mock('./ContextGraph', () => ({
  ContextGraph: ({ graph }: { graph: Graph }) =>
    createElement('div', {}, graph.nodes.map((node) => node.label).join('|')),
}));
vi.mock('./GraphTools', () => ({ GraphTools: () => null }));
vi.mock('./EvidenceTrail', () => ({
  EvidenceTrail: ({ graph }: { graph: Graph }) =>
    createElement(
      'div',
      { 'data-testid': 'trail' },
      graph.nodes.map((item) => item.label).join('|'),
    ),
}));

function node(id: string, kind = 'run', data = {}): GraphNode {
  return { id, label: id, kind, data, author: 'platform_capture', recorded_at: 1000 };
}
function render(view: () => ReactElement) {
  hooks.cursor = 0;
  return view();
}
function find(element: ReactNode, type: string): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(element)) return element.map((child) => find(child, type)).find(Boolean);
  if (!element || typeof element !== 'object' || !('props' in element)) return;
  const item = element as ReactElement<Record<string, any>>;
  return item.type === type ? item : find(item.props.children, type);
}
beforeEach(() => {
  hooks.states = [];
  hooks.cursor = 0;
  hooks.effects = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('review evidence views', () => {
  it('hydrates scoped run context before rendering assertions from an empty paged snapshot', async () => {
    const assertion = node('assertion-1', 'assertion', { run_id: 'run-1' });
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [assertion],
        edges: [],
        next_cursor: null,
        has_more: false,
        watermark: 12,
      }),
    });
    vi.stubGlobal('fetch', fetch);
    const snapshot: Snapshot = {
      repository: {
        id: 'repo',
        name: 'repo',
        version: 1,
        status: 'ready',
        head_commit: 'a',
        published_commit: 'a',
        pending: null,
        remote: { namespace: 'test', name: 'repo' },
      },
      runs: [{ id: 'run-1', intent: 'Preserve the accepted behavior', created_at: 1 }],
      executions: [],
      candidates: [],
      evaluations: [],
      decisions: [],
      artifacts: [],
      nodes: [],
      edges: [],
      seq: 12,
      graph_paged: true,
    };
    let tree = render(() => GraphWorkspace({ snapshot, runId: 'run-1' }));
    expect(renderToStaticMarkup(tree)).not.toContain('Evidence from agent');
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/repos/repo/run_graph_page?run_id=run-1&limit=200',
        expect.objectContaining({ method: 'GET' }),
      ),
    );
    await vi.waitFor(() => expect(hooks.states[5]).toMatchObject({ nodes: [assertion] }));
    tree = render(() => GraphWorkspace({ snapshot, runId: 'run-1' }));
    expect(renderToStaticMarkup(tree)).toContain('assertion-1');
  });

  it('fetches a digest-only candidate through repository-authorized evidence and renders added/removed diff lines', async () => {
    const digest = 'a'.repeat(64);
    const diff =
      'diff --git a/index.html b/index.html\n@@ -1 +1 @@\n-Old heading\n+Reviewed heading';
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: diff }) });
    vi.stubGlobal('fetch', fetch);
    const candidate = node('candidate', 'candidate', { diff_digest: digest });
    const view = () => EvidencePanel({ node: candidate, repo: 'sandbox', onClose: () => {} });
    render(view);
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `/api/repos/sandbox/evidence?digest=${digest}`,
        expect.objectContaining({ method: 'GET' }),
      ),
    );
    await vi.waitFor(() => expect(hooks.states[0]).toBe(diff));
    const html = renderToStaticMarkup(render(view));
    expect(html).toContain('source-diff');
    expect(html).toContain('diff-added');
    expect(html).toContain('+Reviewed heading');
    expect(html).toContain('diff-removed');
    expect(html).toContain('-Old heading');
  });

  it('switches a two-run history graph to the run selected in the picker', () => {
    const old = node('old');
    const current = node('current');
    const snapshot: Snapshot = {
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
      runs: [
        { id: 'old', intent: 'Old run', created_at: 1 },
        { id: 'current', intent: 'Current run', created_at: 2 },
      ],
      nodes: [old, current],
      edges: [],
      executions: [],
      candidates: [],
      evaluations: [],
      decisions: [],
      artifacts: [],
      seq: 1,
    };
    const view = () => GraphWorkspace({ snapshot, initialGraph: { nodes: [old], edges: [] } });
    let tree = render(view);
    // Select the graph presentation through its real event handler.
    const nav = find(tree, 'nav');
    nav?.props.children[1].props.onClick();
    expect(renderToStaticMarkup(render(view))).toContain('>old</div>');
    tree = render(view);
    find(tree, 'select')?.props.onChange({ target: { value: 'current' } });
    for (const effect of hooks.effects.splice(0)) effect();
    const html = renderToStaticMarkup(render(view));
    expect(html).toContain('>current</div>');
    expect(html).not.toContain('>old</div>');
    expect(find(render(view), 'select')?.props.value).toBe('current');
    find(render(view), 'select')?.props.onChange({ target: { value: 'old' } });
    expect(renderToStaticMarkup(render(view))).toContain('>old</div>');
  });
});

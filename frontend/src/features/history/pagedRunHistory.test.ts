import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  useCallback: (callback: (...args: any[]) => unknown) => callback,
}));

import { PagedRunHistory } from './PagedRunHistory';

function find(
  element: ReactNode,
  type: string,
  label?: string,
): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(element)) return element.map((child) => find(child, type, label)).find(Boolean);
  if (!element || typeof element !== 'object' || !('props' in element)) return;
  const item = element as ReactElement<Record<string, any>>;
  if (item.type === type && (!label || String(item.props.children).includes(label))) return item;
  return find(item.props.children, type, label);
}
function render(onGraph = () => {}) {
  hooks.cursor = 0;
  return PagedRunHistory({ repo: 'repo', onGraph });
}
beforeEach(() => {
  hooks.states = [];
  hooks.cursor = 0;
  hooks.effects = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('paged run history', () => {
  it('shows loading then a keyboard-operable page action and appends by cursor', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ id: 'one', intent: 'One' }],
          next_cursor: 'next',
          watermark: 7,
          has_more: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ id: 'two', intent: 'Two' }],
          next_cursor: null,
          watermark: 9,
          has_more: false,
        }),
      });
    vi.stubGlobal('fetch', fetch);
    let tree = render();
    expect(renderToStaticMarkup(tree)).toContain('Loading run history');
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[0]).toEqual([{ id: 'one', intent: 'One' }]));
    tree = render();
    const button = find(tree, 'button', 'Load earlier runs');
    expect(button?.props.type).toBe('button');
    button?.props.onClick();
    await vi.waitFor(() =>
      expect(hooks.states[0]).toEqual([
        { id: 'one', intent: 'One' },
        { id: 'two', intent: 'Two' },
      ]),
    );
    expect(fetch.mock.calls[1][0]).toContain('cursor=next');
    expect(renderToStaticMarkup(render())).toContain('Two');
  });

  it('renders explicit empty and transport error states', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [], next_cursor: null, watermark: 0, has_more: false }),
      }),
    );
    render();
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[3]).toBe(false));
    expect(renderToStaticMarkup(render())).toContain('No runs have been recorded');
    hooks.states = [];
    hooks.cursor = 0;
    hooks.effects = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: { message: 'History unavailable' } }),
      }),
    );
    render();
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[10]).toBe('History unavailable'));
    expect(renderToStaticMarkup(render())).toContain('History unavailable');
  });

  it('loads candidate diffs and intent graph pages only after run selection', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ id: 'run-1', intent: 'Run one' }],
          next_cursor: null,
          watermark: 2,
          has_more: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          repository: { id: 'repo' },
          runs: [{ id: 'run-1' }],
          executions: [],
          candidates: [{ id: 'candidate-1', summary: 'Candidate' }],
          evaluations: [],
          decisions: [],
          artifacts: [],
          team_tasks: [],
          team_handoffs: [],
          nodes: [],
          edges: [],
          graph_paged: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          diff: '+one',
          next_cursor: 'diff-next',
          has_more: true,
          watermark: 2,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          nodes: [
            {
              id: 'intent:1',
              kind: 'intent',
              label: 'Owner intent',
              author: 'owner',
              recorded_at: 1,
              data: {},
            },
          ],
          edges: [],
          next_cursor: null,
          has_more: false,
          watermark: 2,
        }),
      });
    vi.stubGlobal('fetch', fetch);
    const onGraph = vi.fn();
    let tree = render(onGraph);
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[0]).toEqual([{ id: 'run-1', intent: 'Run one' }]));
    tree = render(onGraph);
    find(tree, 'button', 'Run one')?.props.onClick();
    await vi.waitFor(() => expect((hooks.states[5] as any)?.runs?.[0]?.id).toBe('run-1'));
    tree = render(onGraph);
    find(tree, 'button', 'Load diff')?.props.onClick();
    await vi.waitFor(() => expect(fetch.mock.calls[2][0]).toContain('/candidate?'));
    tree = render(onGraph);
    find(tree, 'button', 'Load run context graph')?.props.onClick();
    await vi.waitFor(() => expect(onGraph).toHaveBeenCalled());
    expect(fetch.mock.calls[3][0]).toContain('run_graph_page');
    expect(onGraph.mock.calls[0][0].nodes[0].kind).toBe('intent');
  });
});

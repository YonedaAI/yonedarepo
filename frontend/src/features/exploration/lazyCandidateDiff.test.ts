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
}));

import { LazyCandidateDiff } from './LazyCandidateDiff';

function render() {
  hooks.cursor = 0;
  return LazyCandidateDiff({ repo: 'repo', candidate: { id: 'candidate-1' } });
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

describe('candidate diff hydration', () => {
  it('fetches the scoped candidate detail on expansion and renders its diff', async () => {
    const diff = 'diff --git a/a b/a\n-old\n+new';
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: 'candidate-1', diff }) });
    vi.stubGlobal('fetch', fetch);
    let tree = render();
    expect(renderToStaticMarkup(tree)).not.toContain('No source changes');
    find(tree, 'details')?.props.onToggle({ currentTarget: { open: true } });
    tree = render();
    expect(renderToStaticMarkup(tree)).toContain('Loading captured diff');
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/repos/repo/candidate?id=candidate-1',
        expect.objectContaining({ method: 'GET' }),
      ),
    );
    await vi.waitFor(() => expect(hooks.states[1]).toBe(diff));
    expect(renderToStaticMarkup(render())).toContain('+new');
  });

  it('shows a retry action on error and never fetches an inline scoped diff', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Diff unavailable' } }),
    });
    vi.stubGlobal('fetch', fetch);
    let tree = LazyCandidateDiff({
      repo: 'repo',
      candidate: { id: 'inline', diff: '+already scoped' },
    });
    expect(renderToStaticMarkup(tree)).toContain('+already scoped');
    expect(fetch).not.toHaveBeenCalled();
    hooks.states = [];
    hooks.cursor = 0;
    hooks.effects = [];
    tree = render();
    find(tree, 'details')?.props.onToggle({ currentTarget: { open: true } });
    render();
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[2]).toBe('Diff unavailable'));
    expect(renderToStaticMarkup(render())).toContain('Retry diff');
  });
});

import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  refs: new Map<number, { current: unknown }>(),
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
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!hooks.refs.has(index)) hooks.refs.set(index, { current: initial });
    return hooks.refs.get(index);
  },
  useEffect: (effect: () => unknown) => {
    hooks.effects.push(effect);
  },
}));

import { LazyCandidateDiff } from './LazyCandidateDiff';

function render(repo = 'repo', candidate: Record<string, any> = { id: 'candidate-1' }) {
  hooks.cursor = 0;
  return LazyCandidateDiff({ repo, candidate });
}
function flushLatestEffect() {
  const effects = hooks.effects.splice(0);
  for (const effect of effects.slice(-2)) effect();
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
  hooks.refs = new Map();
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
    flushLatestEffect();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/repos/repo/candidate?id=candidate-1',
        expect.objectContaining({ method: 'GET' }),
      ),
    );
    await vi.waitFor(() => expect(hooks.states[1]).toMatchObject({ value: diff }));
    expect(renderToStaticMarkup(render())).toContain('+new');
  });

  it('labels a stat-only historical diff as a summary and says no patch was recorded', async () => {
    const stat = 'public/index.html | 4 +++-\n1 file changed, 3 insertions(+), 1 deletion(-)';
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'candidate-1', diff: stat }),
    });
    vi.stubGlobal('fetch', fetch);
    let tree = render();
    find(tree, 'details')?.props.onToggle({ currentTarget: { open: true } });
    tree = render();
    flushLatestEffect();
    await vi.waitFor(() => expect(hooks.states[1]).toMatchObject({ value: stat }));
    const html = renderToStaticMarkup(render());
    expect(html).toContain('Change summary');
    expect(html).toContain('change statistics only; the patch was not recorded');
    expect(html).toContain(stat);
    expect(html).not.toContain('class="source-diff"');
    expect(html).toContain('View captured source (read-only)');
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
    flushLatestEffect();
    await vi.waitFor(() => expect(hooks.states[2]).toMatchObject({ message: 'Diff unavailable' }));
    expect(renderToStaticMarkup(render())).toContain('Retry diff');
  });

  it('hides an inline summary immediately when repository and revision identity change', async () => {
    const stat = 'public/index.html | 4 +++-\n1 file changed, 3 insertions(+), 1 deletion(-)';
    let resolveB!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementation(() => new Promise<Response>((resolve) => (resolveB = resolve)));
    vi.stubGlobal('fetch', fetch);
    const a = { id: 'stable-id', revision: { commit: 'a'.repeat(40) }, diff: stat };
    const b = { id: 'stable-id', revision: { commit: 'b'.repeat(40) } };

    let tree = render('repo-a', a);
    expect(renderToStaticMarkup(tree)).toContain('Change summary');
    find(tree, 'details')?.props.onToggle({ currentTarget: { open: true } });
    tree = render('repo-a', a);
    flushLatestEffect();

    tree = render('repo-b', b);
    const switched = renderToStaticMarkup(tree);
    expect(switched).not.toContain('Change summary');
    expect(switched).not.toContain(stat);
    expect(switched).toContain('Loading captured diff');
    flushLatestEffect();
    expect(fetch).toHaveBeenCalledWith(
      '/api/repos/repo-b/candidate?id=stable-id',
      expect.objectContaining({ method: 'GET' }),
    );

    resolveB({
      ok: true,
      json: async () => ({ id: 'stable-id', diff: 'diff --git a/b b/b\n+current repo revision' }),
    } as Response);
    await vi.waitFor(() =>
      expect(renderToStaticMarkup(render('repo-b', b))).toContain('+current repo revision'),
    );
    expect(renderToStaticMarkup(render('repo-b', b))).not.toContain(stat);
  });

  it('ignores a late candidate A response and error after switching to candidate B', async () => {
    let resolveA!: (response: Response) => void;
    let resolveB!: (response: Response) => void;
    const deferred = () =>
      new Promise<Response>((resolve) => {
        if (!resolveA) resolveA = resolve;
        else resolveB = resolve;
      });
    const fetch = vi.fn().mockImplementationOnce(deferred).mockImplementationOnce(deferred);
    vi.stubGlobal('fetch', fetch);
    const a = { id: 'candidate-A', revision: { commit: 'a'.repeat(40) } };
    const b = { id: 'candidate-B', revision: { commit: 'b'.repeat(40) } };

    let tree = render('repo', a);
    find(tree, 'details')?.props.onToggle({ currentTarget: { open: true } });
    tree = render('repo', a);
    flushLatestEffect();
    tree = render('repo', b);
    expect(renderToStaticMarkup(tree)).not.toContain('diff from A');
    flushLatestEffect();
    expect(fetch).toHaveBeenCalledTimes(2);

    resolveA({
      ok: false,
      json: async () => ({ error: { message: 'A response failed late' } }),
    } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const whileBLoads = renderToStaticMarkup(render('repo', b));
    expect(whileBLoads).toContain('Loading captured diff');
    expect(whileBLoads).not.toContain('A response failed late');
    expect(whileBLoads).not.toContain('role="alert"');

    resolveB({
      ok: true,
      json: async () => ({ id: b.id, diff: 'diff --git a/b b/b\n+diff from B' }),
    } as Response);
    await vi.waitFor(() =>
      expect(renderToStaticMarkup(render('repo', b))).toContain('+diff from B'),
    );
    expect(renderToStaticMarkup(render('repo', b))).not.toContain('A response failed late');
  });

  it('hides candidate A error immediately when the revision changes', async () => {
    let resolveB!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: 'Old revision is unavailable' } }),
      })
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveB = resolve)));
    vi.stubGlobal('fetch', fetch);
    const a = { id: 'stable-id', revision: { commit: 'a'.repeat(40) } };
    const b = { id: 'stable-id', revision: { commit: 'b'.repeat(40) } };

    let tree = render('repo', a);
    find(tree, 'details')?.props.onToggle({ currentTarget: { open: true } });
    tree = render('repo', a);
    flushLatestEffect();
    await vi.waitFor(() =>
      expect(renderToStaticMarkup(render('repo', a))).toContain('Old revision is unavailable'),
    );

    tree = render('repo', b);
    const switched = renderToStaticMarkup(tree);
    expect(switched).not.toContain('Old revision is unavailable');
    expect(switched).not.toContain('role="alert"');
    expect(switched).toContain('Loading captured diff');
    flushLatestEffect();
    expect(fetch).toHaveBeenCalledTimes(2);

    resolveB({
      ok: true,
      json: async () => ({ id: b.id, diff: 'diff --git a/b b/b\n+new revision' }),
    } as Response);
    await vi.waitFor(() =>
      expect(renderToStaticMarkup(render('repo', b))).toContain('+new revision'),
    );
  });
});

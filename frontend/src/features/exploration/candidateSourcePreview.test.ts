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
    return [hooks.states[index], (value: unknown) => (hooks.states[index] = value)];
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

import { CandidateSourcePreview } from './CandidateSourcePreview';

function render(
  candidate: Record<string, any> = { id: 'candidate-1', revision: { commit: 'a'.repeat(40) } },
) {
  hooks.cursor = 0;
  return CandidateSourcePreview({
    repo: 'repo-1',
    candidate,
  });
}
function find(element: ReactNode, type: string): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(element)) return element.map((child) => find(child, type)).find(Boolean);
  if (!element || typeof element !== 'object' || !('props' in element)) return;
  const item = element as ReactElement<Record<string, any>>;
  return item.type === type ? item : find(item.props.children, type);
}
async function loadSource() {
  const tree = render();
  find(tree, 'details')?.props.onToggle({ currentTarget: { open: true } });
  render();
  for (const effect of hooks.effects.splice(0)) effect();
}
beforeEach(() => {
  hooks.states = [];
  hooks.cursor = 0;
  hooks.refs = new Map();
  hooks.effects = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('owner candidate source preview', () => {
  it('keeps all bounded paths selectable and initially previews a changed path', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidate_id: 'candidate-1',
        revision: { commit: 'a'.repeat(40) },
        files: {
          '01-readable.txt': { content: 'first captured file' },
          '02-binary.dat': { content: 'YmFzZTY0', encoding: 'base64' },
          '03-changed.txt': { content: 'changed captured file' },
          '04-other.txt': { content: 'another captured file' },
        },
      }),
    });
    vi.stubGlobal('fetch', fetch);
    const tree = render({
      id: 'candidate-1',
      revision: { commit: 'a'.repeat(40) },
      paths: ['03-changed.txt'],
    });
    find(tree, 'details')?.props.onToggle({ currentTarget: { open: true } });
    render({ id: 'candidate-1', revision: { commit: 'a'.repeat(40) }, paths: ['03-changed.txt'] });
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(hooks.states[1]).toMatchObject({ totalFiles: 4 }));
    const html = renderToStaticMarkup(render());
    expect(fetch).toHaveBeenCalledWith(
      '/api/repos/repo-1/candidate_source?id=candidate-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(html).toContain('500 files');
    expect(html).toContain('8 MiB');
    expect(html).toContain('changed captured file');
    const select = find(
      render({
        id: 'candidate-1',
        revision: { commit: 'a'.repeat(40) },
        paths: ['03-changed.txt'],
      }),
      'select',
    );
    expect(
      select?.props.children.map((option: ReactElement<{ value: string }>) => option.props.value),
    ).toEqual(['01-readable.txt', '02-binary.dat', '03-changed.txt', '04-other.txt']);
    expect(select?.props.value).toBe('03-changed.txt');
    expect(html).not.toContain('another captured file');
    select?.props.onChange({ target: { value: '02-binary.dat' } });
    expect(renderToStaticMarkup(render())).toContain('binary and cannot be shown as text');
  });

  it('does not show candidate A source or accept its late response after switching to B', async () => {
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
    const first = render(a);
    find(first, 'details')?.props.onToggle({ currentTarget: { open: true } });
    render(a);
    for (const effect of hooks.effects.splice(0)) effect();

    const switched = render(b);
    expect(renderToStaticMarkup(switched)).not.toContain('A secret source');
    for (const effect of hooks.effects.splice(0)) effect();
    expect(fetch).toHaveBeenCalledTimes(2);

    resolveA({
      ok: true,
      json: async () => ({
        candidate_id: a.id,
        revision: a.revision,
        files: { 'a.txt': { content: 'A secret source' } },
      }),
    } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hooks.states[1]).toBeNull();
    expect(renderToStaticMarkup(render(b))).not.toContain('A secret source');
    expect(renderToStaticMarkup(render(b))).toContain('Loading exact captured source');

    resolveB({
      ok: true,
      json: async () => ({
        candidate_id: b.id,
        revision: b.revision,
        files: { 'b.txt': { content: 'B current source' } },
      }),
    } as Response);
    await vi.waitFor(() => expect(renderToStaticMarkup(render(b))).toContain('B current source'));
    expect(renderToStaticMarkup(render(b))).not.toContain('A secret source');
  });

  it('does not display source returned for a different candidate identity', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidate_id: 'foreign-candidate',
        revision: { commit: 'a'.repeat(40) },
        files: { 'secret.txt': { content: 'foreign bytes' } },
      }),
    });
    vi.stubGlobal('fetch', fetch);
    await loadSource();
    await vi.waitFor(() =>
      expect(hooks.states[2]).toMatchObject({
        message: expect.stringContaining('does not match this captured candidate'),
      }),
    );
    const html = renderToStaticMarkup(render());
    expect(html).toContain('No files were shown.');
    expect(html).not.toContain('foreign bytes');
    expect(html).not.toContain('secret.txt');
  });

  it('reports the per-file preview limit without rendering oversized text', async () => {
    const oversized = 'x'.repeat(256 * 1024 + 1);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidate_id: 'candidate-1',
        revision: { commit: 'a'.repeat(40) },
        files: { 'large.txt': { content: oversized } },
      }),
    });
    vi.stubGlobal('fetch', fetch);
    await loadSource();
    await vi.waitFor(() => expect(hooks.states[1]).toMatchObject({ totalFiles: 1 }));
    const html = renderToStaticMarkup(render());
    expect(html).toContain('exceeds the 256 KiB text preview limit');
    expect(html).not.toContain(oversized);
  });

  it('keeps a failed source read as an isolated actionable error', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Captured source is unavailable.' } }),
    });
    vi.stubGlobal('fetch', fetch);
    await loadSource();
    await vi.waitFor(() =>
      expect(hooks.states[2]).toMatchObject({ message: 'Captured source is unavailable.' }),
    );
    const html = renderToStaticMarkup(render());
    expect(html).toContain('role="alert"');
    expect(html).toContain('Retry source');
    expect(html).not.toContain('foreign bytes');
  });

  it('explains the owner API 500-file and 8 MiB capture limit on an oversized response', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Source exceeds MVP limit' } }),
    });
    vi.stubGlobal('fetch', fetch);
    await loadSource();
    await vi.waitFor(() => expect(renderToStaticMarkup(render())).toContain('500 files / 8 MiB'));
    expect(renderToStaticMarkup(render())).toContain('No source files were shown');
  });
});

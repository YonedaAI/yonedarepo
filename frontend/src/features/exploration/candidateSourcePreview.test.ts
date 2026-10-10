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
    return [hooks.states[index], (value: unknown) => (hooks.states[index] = value)];
  },
  useEffect: (effect: () => unknown) => {
    hooks.effects.push(effect);
  },
}));

import { CandidateSourcePreview } from './CandidateSourcePreview';

function render() {
  hooks.cursor = 0;
  return CandidateSourcePreview({
    repo: 'repo-1',
    candidate: { id: 'candidate-1', revision: { commit: 'a'.repeat(40) } },
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
  hooks.effects = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('owner candidate source preview', () => {
  it('uses the recorded candidate ID and displays only two selectable files', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidate_id: 'candidate-1',
        revision: { commit: 'a'.repeat(40) },
        files: {
          '01-readable.txt': { content: 'first captured file' },
          '02-binary.dat': { content: 'YmFzZTY0', encoding: 'base64' },
          '03-hidden.txt': { content: 'must not render' },
        },
      }),
    });
    vi.stubGlobal('fetch', fetch);
    await loadSource();
    await vi.waitFor(() => expect(hooks.states[1]).toMatchObject({ totalFiles: 3 }));
    const html = renderToStaticMarkup(render());
    expect(fetch).toHaveBeenCalledWith(
      '/api/repos/repo-1/candidate_source?id=candidate-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(html).toContain('Showing the first 2 of 3 captured files.');
    expect(html).toContain('first captured file');
    expect(html).not.toContain('03-hidden.txt');
    const select = find(render(), 'select');
    select?.props.onChange({ target: { value: '02-binary.dat' } });
    expect(renderToStaticMarkup(render())).toContain('binary and cannot be shown as text');
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
      expect(hooks.states[2]).toContain('does not match this captured candidate'),
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
    await vi.waitFor(() => expect(hooks.states[2]).toBe('Captured source is unavailable.'));
    const html = renderToStaticMarkup(render());
    expect(html).toContain('role="alert"');
    expect(html).toContain('Retry source');
    expect(html).not.toContain('foreign bytes');
  });
});

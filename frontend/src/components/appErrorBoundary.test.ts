import type { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppErrorBoundary, reloadAfterStaleChunk } from './AppErrorBoundary';

describe('app crash guard', () => {
  it('reloads once after a stale deploy chunk, then stops', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    let reloads = 0;
    expect(reloadAfterStaleChunk(storage, () => reloads++)).toBe(true);
    expect(reloadAfterStaleChunk(storage, () => reloads++)).toBe(false);
    expect(reloads).toBe(1);
  });

  it('shows a reload screen instead of a blank page', () => {
    const boundary = new AppErrorBoundary({ children: null });
    boundary.state = AppErrorBoundary.getDerivedStateFromError();
    const html = renderToStaticMarkup(boundary.render() as ReturnType<typeof createElement>);
    expect(html).toContain('Something went wrong');
    expect(html).toContain('Reload');
  });
});

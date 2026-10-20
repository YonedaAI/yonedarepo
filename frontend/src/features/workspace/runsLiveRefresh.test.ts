import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { RepositoryWorkspace } from './RepositoryWorkspace';

const guidedRun = vi.hoisted(() => vi.fn());
vi.mock('../guided-demo/useGuidedRun', () => ({ useGuidedRun: guidedRun }));
vi.mock('../exploration/Exploration', () => ({
  Exploration: () => createElement('section', { className: 'exploration' }, 'Rendered run'),
}));

const snapshot = {
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
  runs: [],
  executions: [],
  candidates: [],
  evaluations: [],
  decisions: [],
  artifacts: [],
  nodes: [],
  edges: [],
  seq: 2,
} as unknown as Snapshot;
const render = () =>
  renderToStaticMarkup(
    createElement(RepositoryWorkspace, {
      snapshot,
      onChange: async () => {},
      onError: () => {},
      onPanel: () => {},
    }),
  );

describe('Runs tab during live updates', () => {
  it('keeps the rendered run on screen while a background refresh is in flight', () => {
    guidedRun.mockReturnValue({
      snapshot,
      loading: false,
      refreshing: true,
      error: '',
      refreshError: '',
    });
    const html = render();
    expect(html).toContain('Rendered run');
    expect(html).toContain('Updating…');
    expect(html).not.toContain('Loading this run’s current source and checks');
  });

  it('shows the first-load line inside the page gutter with a spinner instead of the run', () => {
    guidedRun.mockReturnValue({
      snapshot,
      loading: true,
      refreshing: false,
      error: '',
      refreshError: '',
    });
    const html = render();
    expect(html).not.toContain('Rendered run');
    expect(html).toMatch(
      /<p class="workspace-inline-status" role="status"><svg[^>]*class="lucide lucide-loader-circle[^"]* spin"/,
    );
  });
});

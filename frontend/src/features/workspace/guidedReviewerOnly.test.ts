import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { useRepository } from '../../hooks/useRepository';
import type { Snapshot } from '../../lib/types';

vi.mock('../../hooks/useRepository', () => ({ useRepository: vi.fn() }));
const exploration = vi.hoisted(() => vi.fn());
vi.mock('../exploration/Exploration', () => ({ Exploration: exploration }));

const snapshot = {
  repository: {
    id: 'repo',
    name: 'Repo',
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
  seq: 1,
} as unknown as Snapshot;
function state(reviewer: boolean, withSnapshot: boolean) {
  return {
    identity: { role: 'user', username: 'someone', reviewer },
    authenticated: true,
    sessionEnded: false,
    repositories: withSnapshot ? [snapshot.repository] : [],
    snapshot: withSnapshot ? snapshot : null,
    project: undefined,
    id: withSnapshot ? 'repo' : '',
    loading: false,
    error: '',
    refresh: vi.fn(),
    discover: vi.fn(),
    setError: vi.fn(),
    setId: vi.fn(),
  } as unknown as ReturnType<typeof useRepository>;
}
beforeEach(() => exploration.mockReset().mockReturnValue(null));

describe('guided demo is offered to reviewer accounts only', () => {
  it('shows Try guided demo on the empty workspace only for reviewers', () => {
    vi.mocked(useRepository).mockReturnValue(state(false, false));
    expect(renderToStaticMarkup(createElement(App))).not.toContain('Try guided demo');
    vi.mocked(useRepository).mockReturnValue(state(true, false));
    expect(renderToStaticMarkup(createElement(App))).toContain('Try guided demo');
  });

  it('passes the runs-page guided demo launcher only for reviewers', () => {
    vi.mocked(useRepository).mockReturnValue(state(false, true));
    renderToStaticMarkup(createElement(App));
    expect(exploration.mock.calls.at(-1)?.[0].onGuidedDemo).toBeUndefined();
    vi.mocked(useRepository).mockReturnValue(state(true, true));
    renderToStaticMarkup(createElement(App));
    expect(exploration.mock.calls.at(-1)?.[0].onGuidedDemo).toBeTypeOf('function');
  });
});

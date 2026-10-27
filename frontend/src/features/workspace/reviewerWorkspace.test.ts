import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { useRepository } from '../../hooks/useRepository';
import type { Snapshot } from '../../lib/types';
import { HistoryTools } from '../history/HistoryTools';
import { WorkspacePanels } from './WorkspacePanels';

vi.mock('../../hooks/useRepository', () => ({ useRepository: vi.fn() }));
const exploration = vi.hoisted(() => vi.fn());
vi.mock('../exploration/Exploration', () => ({ Exploration: exploration }));
const snapshot: Snapshot = {
  repository: {
    id: 'sandbox',
    name: 'Sandbox',
    version: 1,
    status: 'blocked',
    head_commit: 'head',
    published_commit: 'base',
    pending: null,
    remote: { namespace: 'test', name: 'sandbox' },
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
};
function state(reviewer: boolean): ReturnType<typeof useRepository> {
  return {
    identity: { role: 'user', username: 'reviewer', reviewer },
    authenticated: true,
    repositories: [snapshot.repository],
    snapshot,
    id: 'sandbox',
    loading: false,
    error: '',
    refresh: vi.fn(),
    discover: vi.fn(),
    setError: vi.fn(),
    setId: vi.fn(),
  } as unknown as ReturnType<typeof useRepository>;
}
beforeEach(() => exploration.mockReset().mockReturnValue(null));
describe('reviewer workspace permissions', () => {
  it('keeps history tracing while hiding forbidden recorded observations', () => {
    const props = {
      snapshot: {
        ...snapshot,
        nodes: [
          {
            id: 'assumption',
            kind: 'assumption',
            label: 'Latency',
            author: 'agent',
            recorded_at: 1,
            data: { limit: 100, metric: 'latency' },
          },
        ],
      },
      reviewer: true,
      onGraph: () => {},
      onError: () => {},
    };
    const html = renderToStaticMarkup(createElement(HistoryTools, props));
    expect(html).toContain('Trace history');
    expect(html).not.toContain('Record simulated observation');
  });
  it('gives private-key accounts the same workspace controls without a separate funded trial UI', () => {
    vi.mocked(useRepository).mockReturnValue(state(true));
    const html = renderToStaticMarkup(createElement(App));
    expect(exploration.mock.calls[0][0].reviewer).toBe(false);
    expect(html).toContain('Recover repository');
    for (const label of ['New repository', 'Connect Agents', 'Delete repository'])
      expect(html).toContain(label);
  });
  it('retains ordinary workspace mutations for non-reviewer accounts', () => {
    vi.mocked(useRepository).mockReturnValue(state(false));
    const html = renderToStaticMarkup(createElement(App));
    expect(exploration.mock.calls[0][0].reviewer).toBe(false);
    for (const label of ['New repository', 'Connect Agents', 'Delete repository'])
      expect(html).toContain(label);
  });
  it('cannot open an already selected contribution, provider or project panel after becoming a reviewer', () => {
    for (const panel of ['agents', 'providers', 'project'] as const) {
      const html = renderToStaticMarkup(
        createElement(WorkspacePanels, {
          panel,
          state: state(true),
          reviewer: true,
          onClose: () => {},
        }),
      );
      expect(html).toBe('');
    }
  });
});

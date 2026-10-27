import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Graph, Snapshot } from '../../lib/types';
import { EvidenceTrail } from './EvidenceTrail';

describe('evidence trail candidate lifecycle', () => {
  it('labels stale versus eligible candidates and keeps both exact revisions', () => {
    const snapshot = {
      repository: { head_commit: 'current-head', published_commit: 'published-head' },
      runs: [
        { id: 'run-1', intent: 'Keep the captured work reviewable', base: { commit: 'base' } },
      ],
      executions: [],
      candidates: [
        {
          id: '568eb',
          run_id: 'run-1',
          summary: 'Integrated result',
          status: 'stale',
          base: { commit: 'older-base' },
          revision: { commit: 'older-result' },
          paths: ['src/older.ts'],
        },
        {
          id: 'f552',
          run_id: 'run-1',
          summary: 'Integrated result',
          status: 'eligible',
          base: { commit: 'current-head' },
          revision: { commit: 'current-result' },
          paths: ['src/current.ts'],
        },
      ],
      evaluations: [],
      decisions: [],
      artifacts: [],
      nodes: [],
      edges: [],
      seq: 1,
    } as unknown as Snapshot;
    const graph = { nodes: [], edges: [] } as Graph;

    const html = renderToStaticMarkup(
      EvidenceTrail({ snapshot, runId: 'run-1', graph, onSelect: () => {} }),
    );

    expect(html).toContain('Stale · cannot select; retained in history');
    expect(html).toContain('Eligible for review');
    expect(html).toContain('older-result');
    expect(html).toContain('current-result');
  });
});

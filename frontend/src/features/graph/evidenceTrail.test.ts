import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Graph, Snapshot } from '../../lib/types';
import { EvidenceTrail } from './EvidenceTrail';

describe('evidence trail handoff and candidate lifecycle', () => {
  it('separates assertion, captured and superseded handoffs and labels stale versus eligible candidates', () => {
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
      team_handoffs: [
        {
          id: 'assertion-1',
          run_id: 'run-1',
          task_id: 'task-1',
          authority: 'assertion',
          summary: 'The agent reports its contribution.',
        },
        {
          id: 'capture-1',
          run_id: 'run-1',
          task_id: 'task-1',
          authority: 'captured_revision',
          output: { revision: { commit: 'current-result' }, tree: 'current-tree' },
        },
        {
          id: 'superseded-1',
          run_id: 'run-1',
          task_id: 'task-1',
          authority: 'superseded',
          output: { revision: { commit: 'older-result' }, tree: 'older-tree' },
        },
      ],
      nodes: [],
      edges: [],
      seq: 1,
    } as unknown as Snapshot;
    const graph = {
      nodes: [
        {
          id: 'superseded-1',
          kind: 'team_handoff',
          label: 'Earlier captured handoff',
          author: 'platform_capture',
          recorded_at: 1,
          data: { run_id: 'run-1', authority: 'superseded' },
        },
      ],
      edges: [],
    } as Graph;

    const html = renderToStaticMarkup(
      EvidenceTrail({ snapshot, runId: 'run-1', graph, onSelect: () => {} }),
    );

    expect(html.match(/Agent handoff · assertion/g)).toHaveLength(1);
    expect(html).toContain('The agent reports its contribution.');
    expect(html).toContain('Trusted source capture');
    expect(html).toContain('Superseded source capture');
    expect(html).not.toContain('No summary recorded.');
    expect(html).toContain('Stale · cannot select; retained in history');
    expect(html).toContain('Eligible for review');
    expect(html).toContain('older-result');
    expect(html).toContain('current-result');
  });
});

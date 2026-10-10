import { describe, expect, it } from 'vitest';
import type { RepositoryOverview, RunDetail, Snapshot } from '../lib/types';
import { mergeRunDetails } from './repositorySnapshot';

describe('scoped snapshot refresh', () => {
  it('merges run detail without erasing other runs or lazily paged context graph', () => {
    const graphNode = {
      id: 'context:1',
      kind: 'intent',
      label: 'Owner intent',
      author: 'owner',
      recorded_at: 1,
      data: {},
    };
    const original = {
      repository: { id: 'repo', head_commit: 'old' },
      runs: [
        { id: 'previous', status: 'done' },
        { id: 'active', status: 'running' },
      ],
      executions: [{ id: 'agent', run_id: 'active', status: 'running' }],
      candidates: [],
      evaluations: [],
      decisions: [],
      artifacts: [],
      nodes: [graphNode],
      edges: [
        { source: 'context:1', target: 'run:active', relation: 'addresses', evidence: 'owner' },
      ],
      seq: 4,
    } as unknown as Snapshot;
    const overview = {
      repository: { id: 'repo', head_commit: 'new' },
      v: 1,
      capabilities: {},
      counts: { runs: 2 },
      watermark: 9,
    } as unknown as RepositoryOverview;
    const detail = {
      repository: { id: 'repo' },
      runs: [{ id: 'active', status: 'completed' }],
      executions: [{ id: 'agent', run_id: 'active', status: 'completed' }],
      candidates: [],
      evaluations: [],
      decisions: [],
      artifacts: [],
      team_tasks: [],
      team_handoffs: [],
      nodes: [],
      edges: [],
      graph_paged: true,
    } as unknown as RunDetail;

    const refreshed = mergeRunDetails(original, [detail], overview);
    expect(refreshed.repository.head_commit).toBe('new');
    expect(refreshed.seq).toBe(9);
    expect(refreshed.runs).toEqual([
      { id: 'previous', status: 'done' },
      { id: 'active', status: 'completed' },
    ]);
    expect(refreshed.nodes).toEqual([graphNode]);
    expect(refreshed.edges).toHaveLength(1);
  });
});

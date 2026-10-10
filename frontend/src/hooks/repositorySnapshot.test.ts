import { describe, expect, it } from 'vitest';
import type { RepositoryOverview, RunDetail, Snapshot } from '../lib/types';
import { emptySnapshot, mergeRunDetails, scopedRunIds } from './repositorySnapshot';

describe('scoped snapshot refresh', () => {
  it('hydrates the newest run and active run states without polling completed history', () => {
    expect(
      scopedRunIds(
        [
          { id: 'newest', status: 'accepted' },
          { id: 'ready', status: 'ready' },
          { id: 'planning', status: 'planning' },
          { id: 'exploring', status: 'exploring' },
        ],
        [
          { id: 'remembered-active', status: 'researching' },
          { id: 'done', status: 'accepted' },
        ],
      ),
    ).toEqual(['newest', 'planning', 'exploring', 'remembered-active']);
  });

  it('creates a scoped initial snapshot with an empty graph for on-demand hydration', () => {
    const overview = {
      repository: { id: 'repo' },
      v: 1,
      capabilities: {},
      counts: { runs: 4 },
      watermark: 12,
    } as unknown as RepositoryOverview;
    const snapshot = emptySnapshot(overview);
    expect(snapshot.repository.id).toBe('repo');
    expect(snapshot.watermark).toBe(12);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.graph_paged).toBe(true);
  });

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

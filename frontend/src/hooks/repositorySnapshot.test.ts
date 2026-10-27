import { describe, expect, it } from 'vitest';
import type { RepositoryOverview, RunDetail, Snapshot } from '../lib/types';
import {
  emptySnapshot,
  findRunInPages,
  mergeRunDetails,
  RunHistoryChangedError,
  scopedRunIds,
} from './repositorySnapshot';

describe('scoped snapshot refresh', () => {
  it('replaces preparation markers for one run without retaining stale markers or mixing another run', () => {
    const overview = {
      repository: { id: 'repo' },
      watermark: 1,
      capabilities: { source_api: 1 },
    } as unknown as RepositoryOverview;
    const initial = emptySnapshot(overview);
    const marker = {
      job_id: 'job:source',
      kind: 'agent',
      status: 'pending',
      stage: 'source_preparing',
      epoch: 1,
      observed_at: 10,
      not_before: 20,
      runtime_started_at: null,
    };
    const detail = (id: string, markers: unknown[]) =>
      ({
        ...emptySnapshot(overview),
        run: { id },
        runs: [{ id }],
        source_preparation: markers,
      }) as unknown as RunDetail;
    const first = mergeRunDetails(
      initial,
      [detail('first', [marker]), detail('second', [{ ...marker, job_id: 'job:other' }])],
      overview,
    );
    expect(first.source_preparation?.map((entry) => entry.run_id)).toEqual(['first', 'second']);
    const refreshed = mergeRunDetails(first, [detail('first', [])], overview);
    expect(refreshed.source_preparation?.map((entry) => entry.job_id)).toEqual(['job:other']);
  });
  it('finds a deep-linked run on older history pages and reports missing runs explicitly', async () => {
    const pages = [
      { items: [{ id: 'newest' }], next_cursor: 'older-1', watermark: 8, has_more: true },
      { items: [{ id: 'middle' }], next_cursor: 'older-2', watermark: 8, has_more: true },
      { items: [{ id: 'checked-old-result' }], next_cursor: null, watermark: 8, has_more: false },
    ];
    const requestedPages: [string, number][] = [];
    const loadPage = async (cursor: string, watermark: number) => {
      requestedPages.push([cursor, watermark]);
      return pages[cursor === 'older-1' ? 1 : 2];
    };

    await expect(findRunInPages('checked-old-result', pages[0], loadPage)).resolves.toEqual({
      id: 'checked-old-result',
    });
    expect(requestedPages).toEqual([
      ['older-1', 8],
      ['older-2', 8],
    ]);
    await expect(findRunInPages('absent-run', pages[0], loadPage)).rejects.toThrow(
      'Run "absent-run" was not found in this repository history.',
    );
  });

  it('rejects a requested run page when the history watermark has advanced', async () => {
    const firstPage = {
      items: [{ id: 'newest' }],
      next_cursor: 'older',
      watermark: 8,
      has_more: true,
    };
    await expect(
      findRunInPages('checked-old-result', firstPage, async (_cursor, watermark) => {
        expect(watermark).toBe(8);
        return {
          items: [{ id: 'checked-old-result' }],
          next_cursor: null,
          watermark: 9,
          has_more: false,
        };
      }),
    ).rejects.toBeInstanceOf(RunHistoryChangedError);
  });

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
          { id: 'remembered-active', status: 'exploring' },
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

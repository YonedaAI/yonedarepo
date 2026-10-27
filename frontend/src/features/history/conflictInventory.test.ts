import { describe, expect, it } from 'vitest';
import { normalizeConflictInventory } from './conflictInventory';

describe('conflict inventory boundary', () => {
  it('retains paged conflict/evidence counts and distinguishes missing paths from actual empty legacy scopes', () => {
    const ref = { version: 1, id: 'paths:affected', digest: 'a'.repeat(64), count: 20000 };
    const view = normalizeConflictInventory({
      conflicts: [
        {
          id: 'conflict',
          candidate_id: 'candidate',
          status: 'unresolved',
          conflict_paths_ref: ref,
          evidence: { overlapping_paths_ref: { ...ref, id: 'paths:overlap', count: 4 } },
        },
        { id: 'missing', candidate_id: 'candidate-missing', status: 'failed' },
        { id: 'empty', candidate_id: 'candidate-empty', status: 'clean', conflict_paths: [] },
      ],
      overlaps: [{ conflict_id: 'conflict', candidate_id: 'candidate', status: 'unresolved' }],
    });
    expect(view.records[0].path_sets.conflict_paths).toMatchObject({
      state: 'paged',
      count: 20000,
      reference: ref,
    });
    expect(view.records[1].path_sets.conflict_paths.state).toBe('unknown');
    expect(view.records[2].path_sets.conflict_paths).toMatchObject({ state: 'inline', count: 0 });
    expect(view.overlaps[0].path_set).toMatchObject({ state: 'paged', count: 4 });
  });
  it('names the sandbox run resolving a conflict', () => {
    const view = normalizeConflictInventory({
      conflicts: [
        {
          id: 'conflict',
          candidate_id: 'candidate',
          status: 'unresolved',
          sandbox_resolver: { run_id: 'resolve-abc', request_id: 'r1' },
        },
      ],
    });
    expect(view.records[0].resolver_run_id).toBe('resolve-abc');
  });
  it('does not interpret the empty paths placeholder of a not-analyzed stale candidate as no overlap', () => {
    const view = normalizeConflictInventory({
      conflicts: [
        {
          kind: 'stale_candidate',
          candidate_id: 'candidate',
          captured_paths_ref: {
            version: 1,
            id: 'paths:captured',
            digest: 'b'.repeat(64),
            count: 123,
          },
        },
      ],
      overlaps: [{ candidate_id: 'candidate', paths: [], status: 'not_analyzed' }],
    });
    expect(view.records[0].path_sets.captured_paths).toMatchObject({ state: 'paged', count: 123 });
    expect(view.overlaps[0].path_set.state).toBe('unknown');
  });
  it('normalizes both `records` and route-alias `conflicts` shapes without duplicate rows', () => {
    const normalized = normalizeConflictInventory({
      records: [
        {
          kind: 'stale_candidate',
          candidate_id: 'stale',
          expected_commit: 'old-head',
          paths: ['src/a'],
        },
        {
          id: 'conflict-1',
          kind: 'unresolved_conflict',
          candidate_id: 'candidate-1',
          status: 'unresolved',
          head_commit: 'head',
          expected_version: 4,
          conflict_paths: ['src/b'],
        },
      ],
      conflicts: [
        {
          kind: 'stale_candidate',
          candidate_id: 'stale',
          expected_head: 'old-head',
          paths: ['src/a'],
        },
        {
          id: 'conflict-2',
          candidate_id: 'candidate-2',
          expected_commit: 'older-head',
          paths: ['src/c'],
        },
      ],
      overlaps: [{ candidate_id: 'candidate-2', paths: ['src/c'], status: 'overlap' }],
      seq: 7,
    });
    expect(normalized.records).toEqual([
      expect.objectContaining({
        key: 'candidate:stale',
        kind: 'stale_candidate',
        head_commit: 'old-head',
        conflict_paths: ['src/a'],
      }),
      expect.objectContaining({
        key: 'conflict:conflict-1',
        conflict_id: 'conflict-1',
        head_commit: 'head',
      }),
      expect.objectContaining({
        key: 'conflict:conflict-2',
        conflict_id: 'conflict-2',
        head_commit: 'older-head',
        conflict_paths: ['src/c'],
      }),
    ]);
    expect(normalized.overlaps[0]).toMatchObject({
      key: 'candidate-2:src/c:overlap',
      candidate_id: 'candidate-2',
    });
    expect(normalized.seq).toBe(7);
  });

  it('keeps non-unresolved lifecycle records distinct and retains candidate references', () => {
    const normalized = normalizeConflictInventory({
      conflicts: [
        { id: 'refreshing', candidate_id: 'base-a', status: 'refreshing' },
        {
          id: 'clean',
          candidate_id: 'base-b',
          status: 'clean',
          refreshed_candidate_id: 'candidate-new',
        },
        { id: 'resolving', candidate_id: 'base-c', status: 'resolving' },
        {
          id: 'checking',
          candidate_id: 'base-d',
          status: 'evaluating',
          resolver_candidate_id: 'candidate-check',
        },
        { id: 'stale', candidate_id: 'base-e', status: 'stale' },
        { id: 'failed', candidate_id: 'base-f', status: 'failed' },
        { id: 'open', candidate_id: 'base-g', status: 'unresolved' },
      ],
      overlaps: [],
    });
    expect(normalized.records.map(({ kind, status }) => [kind, status])).toEqual([
      ['refresh_record', 'refreshing'],
      ['refresh_record', 'clean'],
      ['refresh_record', 'resolving'],
      ['refresh_record', 'evaluating'],
      ['refresh_record', 'stale'],
      ['refresh_record', 'failed'],
      ['unresolved_conflict', 'unresolved'],
    ]);
    expect(normalized.records[1]).toMatchObject({ refreshed_candidate_id: 'candidate-new' });
    expect(normalized.records[3]).toMatchObject({ resolver_candidate_id: 'candidate-check' });
  });
});

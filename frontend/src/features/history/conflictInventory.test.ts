import { describe, expect, it } from 'vitest';
import { normalizeConflictInventory } from './conflictInventory';

describe('conflict inventory boundary', () => {
  it('normalizes both `records` and route-alias `conflicts` shapes without duplicate rows', () => {
    const normalized = normalizeConflictInventory({
      records: [
        { kind: 'stale_candidate', candidate_id: 'stale', expected_commit: 'old-head', paths: ['src/a'] },
        { id: 'conflict-1', kind: 'unresolved_conflict', candidate_id: 'candidate-1', head_commit: 'head', expected_version: 4, conflict_paths: ['src/b'] },
      ],
      conflicts: [
        { kind: 'stale_candidate', candidate_id: 'stale', expected_head: 'old-head', paths: ['src/a'] },
        { id: 'conflict-2', candidate_id: 'candidate-2', expected_commit: 'older-head', paths: ['src/c'] },
      ],
      overlaps: [{ candidate_id: 'candidate-2', paths: ['src/c'], status: 'overlap' }],
      seq: 7,
    });
    expect(normalized.records).toEqual([
      expect.objectContaining({ key: 'candidate:stale', kind: 'stale_candidate', head_commit: 'old-head', conflict_paths: ['src/a'] }),
      expect.objectContaining({ key: 'conflict:conflict-1', conflict_id: 'conflict-1', head_commit: 'head' }),
      expect.objectContaining({ key: 'conflict:conflict-2', conflict_id: 'conflict-2', head_commit: 'older-head', conflict_paths: ['src/c'] }),
    ]);
    expect(normalized.overlaps[0]).toMatchObject({ key: 'candidate-2:src/c:overlap', candidate_id: 'candidate-2' });
    expect(normalized.seq).toBe(7);
  });
});

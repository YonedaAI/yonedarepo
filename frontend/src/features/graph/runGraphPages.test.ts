import { describe, expect, it } from 'vitest';
import type { Graph } from '../../lib/types';
import { mergeRunGraphPage } from './runGraphPages';

const node = (id: string) => ({ id, kind: 'assertion', label: id, author: 'agent', recorded_at: 1, data: {} });

describe('run graph page merging', () => {
  it('appends later pages without erasing assertions or duplicate context edges', () => {
    const first: Graph = {
      nodes: [node('intent'), node('assertion-1')],
      edges: [{ source: 'assertion-1', target: 'intent', relation: 'supports', evidence: 'first' }],
    };
    const merged = mergeRunGraphPage(first, {
      nodes: [node('assertion-2')],
      edges: [
        { source: 'assertion-1', target: 'intent', relation: 'supports' },
        { source: 'assertion-2', target: 'intent', relation: 'supports' },
      ],
      next_cursor: null,
      has_more: false,
      watermark: 9,
    });
    expect(merged.nodes.map((item) => item.id)).toEqual(['intent', 'assertion-1', 'assertion-2']);
    expect(merged.edges).toHaveLength(2);
    expect(merged.truncated).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { GraphNode, Snapshot } from '../../lib/types';
import {
  authorityLabel,
  focusedNeighborhood,
  initialNeighborhood,
  runEvidenceGraph,
} from './evidenceView';

function node(id: string, kind: string, data = {}, author = 'platform'): GraphNode {
  return { id, kind, data, author, label: id, recorded_at: 1000 };
}
function fixture(): Snapshot {
  return {
    repository: {
      id: 'repo',
      name: 'repo',
      version: 1,
      status: 'ready',
      head_commit: 'head',
      published_commit: 'base',
      pending: null,
      remote: { namespace: 'test', name: 'repo' },
    },
    runs: [
      { id: 'old', context: ['shared'] },
      { id: 'current', context: ['shared'] },
    ],
    executions: [
      { id: 'agent', run_id: 'current' },
      { id: 'older-agent', run_id: 'old' },
    ],
    candidates: [{ id: 'candidate', run_id: 'current', execution: 'agent' }],
    evaluations: [{ id: 'evaluation', candidate: 'candidate' }],
    decisions: [{ id: 'decision', run_id: 'current' }],
    artifacts: [],
    seq: 5,
    nodes: [
      node('current', 'run'),
      node('intent:current', 'intent'),
      node('shared', 'finding'),
      node('old', 'run'),
      node('older-agent', 'execution', { run_id: 'old' }),
      node('agent', 'execution', { run_id: 'current' }),
      node('candidate', 'candidate', { run_id: 'current' }),
      node('evaluation', 'evaluation'),
      node('decision', 'decision'),
      node('source', 'source', { decision: 'decision' }),
      node('assertion', 'finding', {}, 'agent'),
    ],
    edges: [
      { source: 'shared', target: 'old', relation: 'provided_to', evidence: '' },
      { source: 'shared', target: 'agent', relation: 'provided_to', evidence: '' },
    ],
  };
}
describe('review evidence scope', () => {
  it('focuses immediate relationships without pulling in a neighboring record’s unrelated history', () => {
    const graph = fixture();
    const focused = focusedNeighborhood(graph, 'agent');
    expect(focused.nodes.map((item) => item.id)).toEqual(['shared', 'agent']);
    expect(focused.edges.map((edge) => edge.target)).toEqual(['agent']);
    expect(focusedNeighborhood(graph, 'missing').nodes).toEqual([]);
  });
  it('includes selected run captures, checks, decision and cited context without older runs through shared context', () => {
    const graph = runEvidenceGraph(fixture(), 'current');
    expect(graph.nodes.map((item) => item.id)).toEqual([
      'current',
      'intent:current',
      'shared',
      'agent',
      'candidate',
      'evaluation',
      'decision',
      'source',
      'assertion',
    ]);
    expect(graph.edges.map((edge) => edge.target)).toEqual(['agent']);
  });
  it('does not fall back to all repository evidence for a missing run', () => {
    expect(runEvidenceGraph(fixture(), 'missing')).toEqual({ nodes: [], edges: [] });
  });
  it('bounds the initial graph and omits dangling edges while retaining workflow records first', () => {
    const graph = runEvidenceGraph(fixture(), 'current');
    const bounded = initialNeighborhood(graph, 3);
    expect(bounded.nodes.map((item) => item.id)).toEqual([
      'current',
      'intent:current',
      'candidate',
    ]);
    expect(bounded.truncated).toBe(true);
    expect(bounded.edges).toEqual([]);
  });
  it('does not promote a handoff assertion or an automated fixture decision to owner authority', () => {
    expect(
      authorityLabel(node('handoff', 'team_handoff', { authority: 'assertion' }, 'agent')),
    ).toBe('Agent assertion');
    expect(
      authorityLabel(
        node('capture', 'team_handoff', { authority: 'captured_revision' }, 'platform_capture'),
      ),
    ).toBe('Trusted source capture');
    expect(
      authorityLabel(
        node('decision', 'decision', { decision_kind: 'development_verification' }, 'owner'),
      ),
    ).toBe('Automated fixture decision');
  });
});

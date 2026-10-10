import type { Graph, GraphNode, Snapshot } from '../../lib/types';

/** Scope by ledger identities, never by a label or a shared source's whole ancestry. */
export function runEvidenceGraph(snapshot: Snapshot, runId: string): Graph {
  const run = snapshot.runs.find((item) => item.id === runId);
  if (!run) return { nodes: [], edges: [] };
  const executions = snapshot.executions.filter((item) => item.run_id === runId);
  const authors = new Set(executions.map((item) => item.id));
  const candidates = snapshot.candidates.filter((item) => item.run_id === runId);
  const candidateIds = new Set(candidates.map((item) => item.id));
  const decisions = snapshot.decisions.filter((item) => item.run_id === runId);
  const ids = new Set<string>([
    runId,
    `intent:${runId}`,
    ...(run.context ?? []),
    ...executions.flatMap((execution) => execution.context ?? []),
    ...candidates.flatMap((candidate) => (candidate.evaluation ? [candidate.evaluation] : [])),
    ...authors,
    ...candidateIds,
    ...snapshot.evaluations
      .filter((item) => candidateIds.has(item.candidate))
      .map((item) => item.id),
    ...decisions.map((item) => item.id),
    ...snapshot.artifacts.filter((item) => authors.has(item.producer)).map((item) => item.id),
  ]);
  const decisionIds = new Set(decisions.map((item) => item.id));
  const nodes = snapshot.nodes.filter(
    (node) =>
      ids.has(node.id) ||
      node.data.run_id === runId ||
      authors.has(node.author) ||
      authors.has(node.data.producer) ||
      decisionIds.has(node.data.decision),
  );
  const included = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: snapshot.edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
  };
}

/** Start with the durable workflow, plus a small immediate context neighborhood. */
export function initialNeighborhood(graph: Graph, limit = 32): Graph {
  const primary = graph.nodes.filter((node) =>
    ['intent', 'run', 'candidate', 'evaluation', 'decision', 'team_handoff'].includes(node.kind),
  );
  const ordered = [...primary, ...graph.nodes.filter((node) => !primary.includes(node))];
  const nodes = ordered.slice(0, limit);
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    truncated: graph.truncated || nodes.length < graph.nodes.length,
  };
}

export function authorityLabel(node: GraphNode) {
  if (node.kind === 'evaluation') return 'Independent check';
  if (node.kind === 'candidate' || node.data.authority === 'captured_revision')
    return 'Trusted source capture';
  if (node.kind === 'decision')
    return node.data.decision_kind === 'development_verification'
      ? 'Automated fixture decision'
      : 'Owner decision';
  if (
    node.data.authority === 'assertion' ||
    !['owner', 'platform', 'platform_capture'].includes(node.author)
  )
    return 'Agent assertion';
  return node.author === 'owner' ? 'Owner request' : 'Platform record';
}

export const fieldLabel = (key: string) =>
  key.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());

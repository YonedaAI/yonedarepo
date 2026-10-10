import type { RepositoryOverview, RunDetail, Snapshot } from '../lib/types';

function mergeRows(before: Record<string, any>[], after: Record<string, any>[]) {
  const rows = new Map(before.map((row) => [row.id, row]));
  for (const row of after) rows.set(row.id, row);
  return [...rows.values()];
}

export function mergeRunDetails(
  snapshot: Snapshot,
  details: RunDetail[],
  overview: RepositoryOverview,
) {
  const next = {
    ...snapshot,
    repository: overview.repository,
    capabilities: overview.capabilities as Snapshot['capabilities'],
    seq: overview.watermark,
    watermark: overview.watermark,
  };
  for (const detail of details) {
    next.runs = mergeRows(next.runs, detail.runs);
    next.executions = mergeRows(next.executions, detail.executions);
    next.candidates = mergeRows(next.candidates, detail.candidates);
    next.evaluations = mergeRows(next.evaluations, detail.evaluations);
    next.decisions = mergeRows(next.decisions, detail.decisions);
    next.artifacts = mergeRows(next.artifacts, detail.artifacts);
    next.team_tasks = mergeRows(next.team_tasks ?? [], detail.team_tasks ?? []);
    next.team_handoffs = mergeRows(next.team_handoffs ?? [], detail.team_handoffs ?? []);
    if (!detail.graph_paged) {
      next.nodes = mergeRows(next.nodes, detail.nodes) as Snapshot['nodes'];
      const edges = new Map(
        next.edges.map((edge) => [`${edge.source}:${edge.target}:${edge.relation}`, edge]),
      );
      for (const edge of detail.edges)
        edges.set(`${edge.source}:${edge.target}:${edge.relation}`, edge);
      next.edges = [...edges.values()];
    }
  }
  return next;
}

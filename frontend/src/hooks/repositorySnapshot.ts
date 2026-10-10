import type { RepositoryOverview, RunDetail, RunsPage, Snapshot } from '../lib/types';

const ACTIVE_RUN_STATES = new Set(['planning', 'researching', 'exploring']);

export class RequestedRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run "${runId}" was not found in this repository history.`);
    this.name = 'RequestedRunNotFoundError';
  }
}

export class RunHistoryChangedError extends Error {
  constructor() {
    super('Run history changed while following this link. Refresh the repository and try again.');
    this.name = 'RunHistoryChangedError';
  }
}

export async function findRunInPages(
  runId: string,
  firstPage: RunsPage,
  loadPage: (cursor: string, watermark: number) => Promise<RunsPage>,
): Promise<Record<string, any>> {
  let page = firstPage;
  const watermark = firstPage.watermark;
  const visited = new Set<string>();
  while (true) {
    if (page.watermark !== watermark) throw new RunHistoryChangedError();
    const match = page.items.find((item) => item.id === runId);
    if (match) return match;
    const cursor = page.has_more ? page.next_cursor : null;
    if (!cursor || visited.has(cursor)) throw new RequestedRunNotFoundError(runId);
    visited.add(cursor);
    page = await loadPage(cursor, watermark);
  }
}

export function scopedRunIds(
  pageItems: Record<string, any>[],
  currentRuns: Record<string, any>[] = [],
): string[] {
  const ids = new Set<string>();
  if (typeof pageItems[0]?.id === 'string') ids.add(pageItems[0].id);
  for (const run of [...pageItems, ...currentRuns])
    if (ACTIVE_RUN_STATES.has(run.status) && typeof run.id === 'string') ids.add(run.id);
  return [...ids];
}

export function emptySnapshot(overview: RepositoryOverview): Snapshot {
  return {
    repository: overview.repository,
    runs: [],
    executions: [],
    candidates: [],
    evaluations: [],
    decisions: [],
    artifacts: [],
    nodes: [],
    edges: [],
    seq: overview.watermark,
    watermark: overview.watermark,
    graph_paged: true,
    capabilities: overview.capabilities as Snapshot['capabilities'],
    team_tasks: [],
    team_handoffs: [],
  };
}

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

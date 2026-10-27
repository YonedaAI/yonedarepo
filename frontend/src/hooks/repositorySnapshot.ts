import type { RepositoryOverview, RunDetail, RunsPage, Snapshot } from '../lib/types';

const ACTIVE_RUN_STATES = new Set(['planning', 'exploring', 'coordinating', 'awaiting_intent']);

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
    working_branches: overview.working_branches ?? [],
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
    working_branches: overview.working_branches ?? [],
  };
  for (const detail of details) {
    const runId = detail.run?.id ?? (detail.runs.length === 1 ? detail.runs[0].id : undefined);
    if (typeof runId === 'string') {
      next.source_preparation = [
        ...(next.source_preparation ?? []).filter((entry) => entry.run_id !== runId),
        ...(detail.source_preparation ?? []).map((entry) => ({ ...entry, run_id: runId })),
      ];
    }
    next.runs = mergeRows(next.runs, detail.runs);
    next.executions = mergeRows(next.executions, detail.executions);
    next.candidates = mergeRows(next.candidates, detail.candidates);
    next.evaluations = mergeRows(next.evaluations, detail.evaluations);
    next.decisions = mergeRows(next.decisions, detail.decisions);
    next.artifacts = mergeRows(next.artifacts, detail.artifacts);
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

/**
 * Overlay an older run detail beneath a newer snapshot: repository state and every row the
 * snapshot already has stay current; the detail only fills rows the snapshot has not loaded.
 */
export function preferSnapshotRows(snapshot: Snapshot, detail: RunDetail): Snapshot {
  const merged = mergeRunDetails(snapshot, [detail], {
    repository: snapshot.repository,
    v: 1,
    counts: {},
    watermark: snapshot.seq,
    capabilities: snapshot.capabilities ?? {},
    working_branches: snapshot.working_branches,
  });
  const keep = <T extends Record<string, any>>(rows: T[], current: T[]) =>
    mergeRows(rows, current) as T[];
  return {
    ...merged,
    source_preparation: snapshot.source_preparation ?? merged.source_preparation,
    runs: keep(merged.runs, snapshot.runs),
    executions: keep(merged.executions, snapshot.executions),
    candidates: keep(merged.candidates, snapshot.candidates),
    evaluations: keep(merged.evaluations, snapshot.evaluations),
    decisions: keep(merged.decisions, snapshot.decisions),
    artifacts: keep(merged.artifacts, snapshot.artifacts),
    nodes: keep(merged.nodes, snapshot.nodes),
  };
}

import {
  type ConflictPathSection,
  type ConflictPathSet,
  conflictPathSet,
  conflictPathSets,
  isRecord,
} from './conflictPaths';

export interface ConflictInventoryItem {
  key: string;
  kind: 'stale_candidate' | 'unresolved_conflict' | 'refresh_record';
  candidate_id: string;
  conflict_id?: string;
  refreshed_candidate_id?: string;
  resolver_candidate_id?: string;
  /** The sandbox run resolving this conflict (deployments with sandboxes). */
  resolver_run_id?: string;
  head_commit?: string;
  expected_version?: number;
  /** Only complete legacy inline paths may enter the existing mutation envelope; never page results. */
  conflict_paths: string[];
  path_sets: Record<ConflictPathSection, ConflictPathSet>;
  evidence?: Record<string, unknown>;
  status?: string;
  /** Server reason a refresh would be refused (published or cancelled run). */
  refresh_blocked?: string;
}
export interface ConflictOverlapItem {
  key: string;
  conflict_id?: string;
  candidate_id: string;
  paths: string[];
  path_set: ConflictPathSet;
  status: string;
}
export interface ConflictInventoryView {
  records: ConflictInventoryItem[];
  overlaps: ConflictOverlapItem[];
  seq: number;
}

/** Preserve paged/unknown path metadata independently of legacy inline mutation scopes. */
export function normalizeConflictInventory(raw: unknown): ConflictInventoryView {
  const inventory = isRecord(raw) ? raw : {},
    normalized = new Map<string, ConflictInventoryItem>();
  const rows = [
    ...(Array.isArray(inventory.records) ? inventory.records : []),
    ...(Array.isArray(inventory.conflicts) ? inventory.conflicts : []),
  ];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.candidate_id !== 'string' || !row.candidate_id) continue;
    const stale = row.kind === 'stale_candidate';
    if (!stale && (typeof row.id !== 'string' || !row.id)) continue;
    const headCommit = [
      row.head_commit,
      row.expected_head,
      row.expected_commit,
      row.candidate_base,
    ].find((value): value is string => typeof value === 'string');
    const sets = conflictPathSets(row);
    if (sets.conflict_paths.state === 'unknown' && Array.isArray(row.paths))
      sets.conflict_paths = conflictPathSet(row, 'paths');
    const item: ConflictInventoryItem = {
      key: stale ? `candidate:${row.candidate_id}` : `conflict:${row.id}`,
      kind: stale
        ? 'stale_candidate'
        : row.status === 'unresolved'
          ? 'unresolved_conflict'
          : 'refresh_record',
      candidate_id: row.candidate_id,
      ...(!stale ? { conflict_id: String(row.id) } : {}),
      ...(typeof row.refreshed_candidate_id === 'string'
        ? { refreshed_candidate_id: row.refreshed_candidate_id }
        : {}),
      ...(typeof row.resolver_candidate_id === 'string'
        ? { resolver_candidate_id: row.resolver_candidate_id }
        : {}),
      ...(isRecord(row.sandbox_resolver) && typeof row.sandbox_resolver.run_id === 'string'
        ? { resolver_run_id: row.sandbox_resolver.run_id }
        : {}),
      ...(headCommit ? { head_commit: headCommit } : {}),
      ...(typeof row.expected_version === 'number'
        ? { expected_version: row.expected_version }
        : {}),
      conflict_paths: sets.conflict_paths.state === 'inline' ? sets.conflict_paths.items : [],
      path_sets: sets,
      ...(isRecord(row.evidence) ? { evidence: row.evidence } : {}),
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
      ...(typeof row.refresh_blocked === 'string' ? { refresh_blocked: row.refresh_blocked } : {}),
    };
    normalized.set(item.key, item);
  }
  const records = [...normalized.values()],
    overlaps: ConflictOverlapItem[] = [];
  for (const row of Array.isArray(inventory.overlaps) ? inventory.overlaps : []) {
    if (!isRecord(row) || typeof row.candidate_id !== 'string' || typeof row.status !== 'string')
      continue;
    const conflictId = typeof row.conflict_id === 'string' ? row.conflict_id : undefined;
    let paths = conflictPathSet(row, 'paths');
    if (paths.state === 'unknown' && conflictId)
      paths =
        records.find((item) => item.conflict_id === conflictId)?.path_sets.overlapping_paths ??
        paths;
    if (row.status === 'not_analyzed') paths = { state: 'unknown', items: [] };
    const inline = paths.state === 'inline' ? paths.items : [];
    overlaps.push({
      key: `${conflictId ?? row.candidate_id}:${paths.state === 'paged' ? paths.reference.digest : inline.join('|')}:${row.status}`,
      ...(conflictId ? { conflict_id: conflictId } : {}),
      candidate_id: row.candidate_id,
      paths: inline,
      path_set: paths,
      status: row.status,
    });
  }
  return { records, overlaps, seq: typeof inventory.seq === 'number' ? inventory.seq : 0 };
}

import type { ConflictStatusContract } from '../../../../shared/provenance';

export interface ConflictInventoryItem {
  key: string;
  kind: 'stale_candidate' | 'unresolved_conflict' | 'refresh_record';
  candidate_id: string;
  conflict_id?: string;
  refreshed_candidate_id?: string;
  resolver_candidate_id?: string;
  head_commit?: string;
  expected_version?: number;
  conflict_paths: string[];
  evidence?: Record<string, unknown>;
  status?: string;
}

export interface ConflictOverlapItem {
  key: string;
  conflict_id?: string;
  candidate_id: string;
  paths: string[];
  status: string;
}

export interface ConflictInventoryView {
  records: ConflictInventoryItem[];
  overlaps: ConflictOverlapItem[];
  seq: number;
}

/** Convert the backend inventory shape to renderable rows without assuming IDs on stale entries. */
export function normalizeConflictInventory(raw: unknown): ConflictInventoryView {
  const inventory =
    raw && typeof raw === 'object'
      ? (raw as Partial<ConflictStatusContract> & {
          conflicts?: ConflictStatusContract['conflicts'];
        })
      : {};
  const records: ConflictInventoryItem[] = [];
  const normalized = new Map<string, ConflictInventoryItem>();
  const rows = [
    ...(Array.isArray(inventory.records) ? inventory.records : []),
    ...(Array.isArray(inventory.conflicts) ? inventory.conflicts : []),
  ];
  for (const row of rows) {
    if (!row || typeof row.candidate_id !== 'string' || !row.candidate_id) continue;
    const stale = row.kind === 'stale_candidate';
    if (!stale && (typeof row.id !== 'string' || !row.id)) continue;
    const unresolved = !stale && row.status === 'unresolved';
    const headCommit = [row.head_commit, row.expected_head, row.expected_commit].find(
      (value): value is string => typeof value === 'string',
    );
    const item: ConflictInventoryItem = {
      key: stale ? `candidate:${row.candidate_id}` : `conflict:${row.id}`,
      kind: stale ? 'stale_candidate' : unresolved ? 'unresolved_conflict' : 'refresh_record',
      candidate_id: row.candidate_id,
      ...(!stale ? { conflict_id: row.id } : {}),
      ...(typeof row.refreshed_candidate_id === 'string'
        ? { refreshed_candidate_id: row.refreshed_candidate_id }
        : {}),
      ...(typeof row.resolver_candidate_id === 'string'
        ? { resolver_candidate_id: row.resolver_candidate_id }
        : {}),
      ...(headCommit ? { head_commit: headCommit } : {}),
      ...(typeof row.expected_version === 'number'
        ? { expected_version: row.expected_version }
        : {}),
      conflict_paths: (Array.isArray(row.conflict_paths)
        ? row.conflict_paths
        : Array.isArray(row.paths)
          ? row.paths
          : []
      ).filter((path): path is string => typeof path === 'string'),
      ...(row.evidence && typeof row.evidence === 'object' ? { evidence: row.evidence } : {}),
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
    };
    normalized.set(item.key, item);
  }
  records.push(...normalized.values());
  const overlaps: ConflictOverlapItem[] = [];
  for (const row of Array.isArray(inventory.overlaps) ? inventory.overlaps : []) {
    if (!row || typeof row.candidate_id !== 'string' || typeof row.status !== 'string') continue;
    const paths = Array.isArray(row.paths)
      ? row.paths.filter((path): path is string => typeof path === 'string')
      : [];
    const conflictId = typeof row.conflict_id === 'string' ? row.conflict_id : undefined;
    overlaps.push({
      key: `${conflictId ?? row.candidate_id}:${paths.join('|')}:${row.status}`,
      ...(conflictId ? { conflict_id: conflictId } : {}),
      candidate_id: row.candidate_id,
      paths,
      status: row.status,
    });
  }
  return {
    records,
    overlaps,
    seq: typeof inventory.seq === 'number' ? inventory.seq : 0,
  };
}

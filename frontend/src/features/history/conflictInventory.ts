import type { ConflictStatusContract } from '../../../../shared/provenance';

export interface ConflictInventoryItem {
  key: string;
  kind: 'stale_candidate' | 'unresolved_conflict';
  candidate_id: string;
  conflict_id?: string;
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
  const inventory = raw && typeof raw === 'object' ? (raw as Partial<ConflictStatusContract>) : {};
  const records: ConflictInventoryItem[] = [];
  for (const row of Array.isArray(inventory.records) ? inventory.records : []) {
    if (!row || typeof row.candidate_id !== 'string' || !row.candidate_id) continue;
    const stale = row.kind === 'stale_candidate';
    if (!stale && (typeof row.id !== 'string' || !row.id)) continue;
    records.push({
      key: stale ? `candidate:${row.candidate_id}` : `conflict:${row.id}`,
      kind: stale ? 'stale_candidate' : 'unresolved_conflict',
      candidate_id: row.candidate_id,
      ...(!stale ? { conflict_id: row.id } : {}),
      ...(typeof row.head_commit === 'string' ? { head_commit: row.head_commit } : {}),
      ...(typeof row.expected_version === 'number'
        ? { expected_version: row.expected_version }
        : {}),
      conflict_paths: Array.isArray(row.conflict_paths)
        ? row.conflict_paths.filter((path): path is string => typeof path === 'string')
        : [],
      ...(row.evidence && typeof row.evidence === 'object' ? { evidence: row.evidence } : {}),
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
    });
  }
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

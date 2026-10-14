import type { SourcePathListRef } from '../../lib/sourceWorkspace';
import { capturedPathRef } from '../source-workspace/sourcePathCount';

export const conflictPathSections = [
  'conflict_paths',
  'declared_paths',
  'merged_paths',
  'captured_paths',
  'intervening_paths',
  'overlapping_paths',
] as const;
export type ConflictPathSection = (typeof conflictPathSections)[number];
export type ConflictPathSet =
  | { state: 'inline'; items: string[]; count: number }
  | { state: 'paged'; items: []; count: number; reference: SourcePathListRef }
  | { state: 'unknown'; items: [] };
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function conflictPathSet(row: unknown, key: string): ConflictPathSet {
  if (!isRecord(row)) return { state: 'unknown', items: [] };
  const reference = capturedPathRef({ paths_ref: row[`${key}_ref`] });
  if (reference) return { state: 'paged', items: [], count: reference.count, reference };
  const values = row[key];
  if (Array.isArray(values) && values.every((p): p is string => typeof p === 'string'))
    return { state: 'inline', items: [...values], count: values.length };
  return { state: 'unknown', items: [] };
}
export function conflictPathSets(
  row: Record<string, unknown>,
): Record<ConflictPathSection, ConflictPathSet> {
  const evidence = isRecord(row.evidence) ? row.evidence : {};
  return {
    conflict_paths: conflictPathSet(row, 'conflict_paths'),
    declared_paths: conflictPathSet(row, 'declared_paths'),
    merged_paths: conflictPathSet(row, 'merged_paths'),
    captured_paths: conflictPathSet(
      row.kind === 'stale_candidate' ? row : evidence,
      'captured_paths',
    ),
    intervening_paths: conflictPathSet(evidence, 'intervening_paths'),
    overlapping_paths: conflictPathSet(evidence, 'overlapping_paths'),
  };
}

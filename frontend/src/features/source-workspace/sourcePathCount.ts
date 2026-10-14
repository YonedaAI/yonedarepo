import type { SourcePathListRef } from '../../lib/sourceWorkspace';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function capturedPathRef(candidate: unknown): SourcePathListRef | undefined {
  const value = record(candidate) ? candidate.paths_ref : undefined;
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    typeof value.count !== 'number' ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  )
    return;
  return { version: 1, id: value.id, digest: value.digest, count: value.count };
}
/** Native immutable list count; missing metadata is unknown, never fabricated as zero. */
export function capturedPathCount(candidate: unknown): number | undefined {
  const ref = capturedPathRef(candidate);
  if (ref) return ref.count;
  return record(candidate) && Array.isArray(candidate.paths) ? candidate.paths.length : undefined;
}

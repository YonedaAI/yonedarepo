import type { SourcePathListRef } from '../../lib/sourceWorkspace';
import type { ChangedPathPage } from '../source-workspace/changedPathReader';
import { SourceViewUnavailable } from '../source-workspace/sourceApiReader';
import { capturedPathRef } from '../source-workspace/sourcePathCount';
import { type ConflictPathSection, isRecord } from './conflictPaths';

function check(value: unknown): asserts value {
  if (!value)
    throw new SourceViewUnavailable(
      'The path page does not match this recorded conflict and section. Refresh conflict status.',
    );
}
function path(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || /[\\\0]/.test(value))
    return false;
  const parts = value.split('/');
  if (parts.at(-1) === '') parts.pop();
  return parts.every(
    (part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git',
  );
}
/** Read-only recorded conflict metadata; complete resolver scopes remain native, not page-derived. */
export function createConflictPathReader(fetcher: typeof fetch = fetch) {
  return async (
    repo: string,
    conflictId: string,
    section: ConflictPathSection,
    ref: SourcePathListRef,
    after: string | null,
  ): Promise<ChangedPathPage> => {
    const query = new URLSearchParams({
      conflict_id: conflictId,
      section,
      limit: '50',
      expected_digest: ref.digest,
      ...(after ? { after } : {}),
    });
    const response = await fetcher(
      `/api/repos/${encodeURIComponent(repo)}/conflict_paths?${query}`,
      { method: 'GET', signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceViewUnavailable(
        'This recorded conflict path list is unavailable. Refresh status or retry this read after the service update.',
      );
    }
    const reader = response.body?.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          check(size <= 256 * 1024);
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel();
      }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new SourceViewUnavailable();
    }
    check(
      isRecord(value) &&
        value.version === 1 &&
        value.conflict_id === conflictId &&
        value.section === section &&
        value.digest === ref.digest &&
        value.total === ref.count,
    );
    const actual = capturedPathRef({ paths_ref: value.paths_ref });
    check(
      actual && actual.id === ref.id && actual.digest === ref.digest && actual.count === ref.count,
    );
    check(
      Array.isArray(value.items) &&
        value.items.length <= 50 &&
        value.items.every(path) &&
        new Set(value.items).size === value.items.length &&
        typeof value.has_more === 'boolean',
    );
    check(
      value.has_more
        ? value.items.length > 0 &&
            path(value.next_cursor) &&
            value.next_cursor === value.items.at(-1) &&
            value.next_cursor !== after
        : value.next_cursor === null,
    );
    return {
      items: value.items,
      next_cursor: typeof value.next_cursor === 'string' ? value.next_cursor : null,
      has_more: value.has_more,
      total: ref.count,
    };
  };
}

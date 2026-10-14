import type { SourcePathListRef } from '../../lib/sourceWorkspace';
import { SourceViewUnavailable } from './sourceApiReader';
import { capturedPathRef } from './sourcePathCount';

export interface ChangedPathPage {
  items: string[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function valid(condition: unknown): asserts condition {
  if (!condition)
    throw new SourceViewUnavailable(
      'Changed paths do not match this captured result. Refresh the result before continuing.',
    );
}
function path(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !!value &&
    !value.startsWith('/') &&
    !/[\\\0]/.test(value) &&
    value
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  );
}
/** Owner-only immutable candidate metadata pages; no model, grant, source write or Git ref input. */
export function createChangedPathReader(fetcher: typeof fetch = fetch) {
  return async (
    repo: string,
    candidateId: string,
    ref: SourcePathListRef,
    after: string | null,
  ): Promise<ChangedPathPage> => {
    const query = new URLSearchParams({
      candidate_id: candidateId,
      limit: '50',
      expected_digest: ref.digest,
      ...(after ? { after } : {}),
    });
    const response = await fetcher(
      `/api/repos/${encodeURIComponent(repo)}/candidate_paths?${query}`,
      { method: 'GET', signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceViewUnavailable(
        'The recorded changed-path list is unavailable. Refresh the result and try again.',
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
          valid(size <= 256 * 1024);
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
    valid(
      record(value) &&
        value.version === 1 &&
        value.candidate_id === candidateId &&
        value.digest === ref.digest &&
        value.total === ref.count,
    );
    const actual = capturedPathRef({ paths_ref: value.paths_ref });
    valid(
      actual && actual.id === ref.id && actual.digest === ref.digest && actual.count === ref.count,
    );
    valid(
      Array.isArray(value.items) &&
        value.items.length <= 50 &&
        value.items.every(path) &&
        new Set(value.items).size === value.items.length &&
        typeof value.has_more === 'boolean',
    );
    valid(
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

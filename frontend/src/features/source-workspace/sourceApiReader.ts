import type { SourceFileEntry, SourceReader, SourceSelection } from '../../lib/sourceWorkspace';
import { parseSourceProvenance } from './sourceProvenance';

export class SourceViewUnavailable extends Error {
  constructor(
    message = 'This source version is unavailable. Refresh source status or choose a recorded capture.',
    readonly reason: 'unavailable' | 'preparing' = 'unavailable',
  ) {
    super(message);
  }
}
function check(value: unknown): asserts value {
  if (!value)
    throw new SourceViewUnavailable(
      'The source response does not match the selected version. No new content was shown.',
    );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hex(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function query(source: SourceSelection) {
  if (source.kind === 'proposed')
    throw new SourceViewUnavailable(
      'The proposed source is unavailable for this attempt. Read its captured or published Git version instead.',
    );
  return new URLSearchParams(
    source.kind === 'published' ? { published: 'true' } : { candidate_id: source.candidate_id },
  );
}
function frame(
  value: unknown,
  source: SourceSelection,
): asserts value is Record<string, unknown> & { revision: Record<string, unknown> } {
  check(
    source.kind !== 'proposed' &&
      record(value) &&
      value.version === 1 &&
      value.authority === 'git' &&
      record(value.revision),
  );
  check(
    value.candidate_id === (source.kind === 'published' ? null : source.candidate_id) &&
      value.revision.repository === source.revision.repository &&
      value.revision.commit === source.revision.commit &&
      hex(value.revision.tree) &&
      (!source.revision.tree || value.revision.tree === source.revision.tree),
  );
}
function fileEntry(value: unknown): SourceFileEntry {
  check(
    record(value) &&
      typeof value.path === 'string' &&
      integer(value.size) &&
      integer(value.file_version) &&
      hex(value.blob_id) &&
      ['100644', '100755'].includes(String(value.mode)),
  );
  return {
    path: value.path,
    blob_id: value.blob_id,
    file_version: value.file_version,
    size_bytes: value.size,
    encoding: 'unknown',
  };
}
async function boundedBytes(response: Response, limit: number) {
  const chunks: Uint8Array[] = [],
    reader = response.body?.getReader();
  let length = 0;
  if (reader) {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        check(length <= limit);
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
/** Frozen owner GET wire only. No caller Git refs, grants, source writes or workflow commands. */
export function createSourceApiReader(fetcher: typeof fetch = fetch): SourceReader {
  async function get(source: SourceSelection, op: string, parameters: Record<string, string>) {
    const params = query(source);
    for (const [key, value] of Object.entries(parameters)) params.set(key, value);
    const response = await fetcher(
      `/api/repos/${encodeURIComponent(source.repo_id)}/source/${op}?${params}`,
      { method: 'GET', signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) {
      let failure: unknown;
      if (response.status === 409) {
        try {
          failure = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536)));
        } catch {
          /* Unrecognized diagnostics use static copy below. */
        }
      } else await response.body?.cancel();
      if (record(failure) && record(failure.error) && failure.error.code === 'SOURCE_PREPARING')
        throw new SourceViewUnavailable(
          'Still preparing source file metadata. Refresh files to continue preparation.',
          'preparing',
        );
      throw new SourceViewUnavailable(
        response.status === 409
          ? 'This source version is unavailable or has changed. Refresh source status or choose a recorded capture.'
          : undefined,
      );
    }
    return response;
  }
  async function json(source: SourceSelection, op: string, parameters: Record<string, string>) {
    const bytes = await boundedBytes(await get(source, op, parameters), 1024 * 1024);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new SourceViewUnavailable();
    }
    frame(value, source);
    return value;
  }
  return {
    async list(source, cursor, limit) {
      check(Number.isInteger(limit) && limit >= 1 && limit <= 200);
      const value = await json(source, 'list', {
        limit: String(limit),
        ...(cursor ? { cursor } : {}),
      });
      check(
        Array.isArray(value.items) &&
          (value.next_cursor === null || typeof value.next_cursor === 'string') &&
          typeof value.has_more === 'boolean',
      );
      return {
        source,
        items: value.items.map(fileEntry),
        next_cursor: value.next_cursor,
        has_more: value.has_more,
      };
    },
    async read(source, file, offset, limit) {
      check(integer(offset) && integer(limit) && limit >= 1 && limit <= 65536);
      const response = await get(source, 'file', {
        path: file.path,
        offset: String(offset),
        limit: String(limit),
      });
      let metadata: unknown;
      try {
        metadata = JSON.parse(decodeURIComponent(response.headers.get('x-yoneda-source') ?? ''));
      } catch {
        await response.body?.cancel();
        throw new SourceViewUnavailable();
      }
      try {
        frame(metadata, source);
        const current = fileEntry(metadata.file);
        check(
          current.path === file.path &&
            current.blob_id === file.blob_id &&
            current.size_bytes === file.size_bytes &&
            current.file_version === file.file_version &&
            metadata.offset === offset &&
            integer(metadata.length) &&
            metadata.length <= limit,
        );
        const bytes = await boundedBytes(response, limit);
        check(bytes.length === metadata.length && offset + bytes.length <= file.size_bytes);
        return {
          source,
          path: file.path,
          blob_id: file.blob_id,
          file_version: current.file_version,
          offset,
          bytes,
          total_bytes: file.size_bytes,
          has_more: offset + bytes.length < file.size_bytes,
        };
      } catch (failure) {
        await response.body?.cancel().catch(() => {});
        throw failure;
      }
    },
    async provenance(source, path) {
      const value = await json(source, 'provenance', { path });
      check(value.path === path);
      return parseSourceProvenance(source, path, value);
    },
  };
}

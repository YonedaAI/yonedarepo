import type {
  SourceFileEntry,
  SourceReader,
  SourceRevision,
  SourceSelection,
} from '../../lib/sourceWorkspace';

export const FILE_PAGE_SIZE = 50;
export const SOURCE_CHUNK_BYTES = 64 * 1024;
export const SOURCE_PREVIEW_BYTES = 256 * 1024;
export class SourceTextUnavailable extends Error {
  constructor() {
    super('This file cannot be previewed as UTF-8 text. Its source metadata remains available.');
  }
}
const revisionIdentity = (revision: SourceRevision) => [
  revision.repository,
  revision.commit,
  revision.tree ?? null,
];
export function sourceIdentity(source: SourceSelection) {
  return JSON.stringify([
    source.repo_id,
    source.run_id ?? null,
    source.kind,
    source.kind === 'proposed'
      ? [source.workspace_id, source.epoch, source.workspace_version, revisionIdentity(source.base)]
      : [
          revisionIdentity(source.revision),
          source.kind === 'published'
            ? source.decision_id
            : [
                source.candidate_id,
                source.kind === 'checked' ? [source.evaluation_id, source.policy_version] : null,
              ],
        ],
  ]);
}
function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function safePath(path: string) {
  return (
    !!path &&
    !path.startsWith('/') &&
    !/[\\\0]/.test(path) &&
    path
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  );
}
function same(source: SourceSelection, actual: SourceSelection) {
  check(
    sourceIdentity(actual) === sourceIdentity(source),
    'This response belongs to a different source version. Refresh the selected source.',
  );
}
/** One read session pins an immutable selection; adapters own endpoint/transport compatibility. */
export function createSourceReadSession(selection: SourceSelection, reader: SourceReader) {
  const source = structuredClone(selection);
  return {
    async list(cursor: string | null) {
      const page = await reader.list(source, cursor, FILE_PAGE_SIZE);
      same(source, page.source);
      check(
        page.items.length <= FILE_PAGE_SIZE &&
          new Set(page.items.map((f) => f.path)).size === page.items.length &&
          page.items.every(
            (f) =>
              safePath(f.path) &&
              Number.isSafeInteger(f.size_bytes) &&
              f.size_bytes >= 0 &&
              (source.kind !== 'proposed' ||
                (Number.isSafeInteger(f.file_version) && (f.file_version ?? -1) >= 0)),
          ),
        'The file list could not be verified. No files were shown.',
      );
      check(
        page.has_more
          ? typeof page.next_cursor === 'string' &&
              !!page.next_cursor &&
              page.next_cursor !== cursor
          : page.next_cursor === null,
        'The source page cursor changed. Refresh this version.',
      );
      return page;
    },
    async read(file: SourceFileEntry, offset: number) {
      check(
        safePath(file.path) &&
          offset >= 0 &&
          Number.isSafeInteger(offset) &&
          offset < SOURCE_PREVIEW_BYTES,
        'This file range cannot be previewed.',
      );
      const available = Math.min(
        SOURCE_CHUNK_BYTES,
        SOURCE_PREVIEW_BYTES - offset,
        file.size_bytes - offset,
      );
      check(available >= 0, 'The file range changed. Refresh its source.');
      const limit = Math.max(1, available);
      const slice = await reader.read(source, file, offset, limit);
      same(source, slice.source);
      check(
        slice.path === file.path &&
          slice.blob_id === file.blob_id &&
          slice.offset === offset &&
          (source.kind !== 'proposed' || slice.file_version === file.file_version) &&
          slice.total_bytes === file.size_bytes &&
          slice.bytes instanceof Uint8Array &&
          slice.bytes.length <= limit &&
          slice.has_more === offset + slice.bytes.length < file.size_bytes &&
          (!slice.has_more || slice.bytes.length > 0),
        'The file response does not match the selected version and byte range. No new content was shown.',
      );
      return slice;
    },
    async provenance(path: string) {
      check(safePath(path), 'This file history path cannot be read.');
      const trail = await reader.provenance(source, path);
      same(source, trail.source);
      check(trail.path === path, 'The history response belongs to another file.');
      return trail;
    },
  };
}
export function decodePreview(chunks: Uint8Array[], more: boolean) {
  const size = chunks.reduce((sum, bytes) => sum + bytes.length, 0);
  check(size <= SOURCE_PREVIEW_BYTES, 'The text preview exceeds its display limit.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    if (bytes.includes(0)) throw new SourceTextUnavailable();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: more });
  } catch {
    throw new SourceTextUnavailable();
  }
}

import { expect, it, vi } from 'vitest';
import type { SourceReader, SourceSelection } from '../../lib/sourceWorkspace';
import { createSourceReadSession, decodePreview, sourceIdentity } from './sourceReader';

it('binary NUL bytes are not rendered as invisible source text', () => {
  expect(() => decodePreview([new Uint8Array([0, 1])], false)).toThrow(/UTF-8/);
});

const source: SourceSelection = {
  repo_id: 'repo',
  kind: 'proposed',
  workspace_id: 'attempt',
  epoch: 2,
  workspace_version: 4,
  base: { repository: 'git/source', commit: 'a'.repeat(40) },
};
const file = {
  path: 'src/search.ts',
  blob_id: 'blob-a',
  size_bytes: 6,
  file_version: 0,
  encoding: 'text' as const,
};
function reader(): SourceReader {
  return {
    list: vi.fn(async () => ({ source, items: [file], next_cursor: null, has_more: false })),
    read: vi.fn(async () => ({
      source,
      path: file.path,
      blob_id: file.blob_id,
      file_version: 0,
      offset: 0,
      bytes: new TextEncoder().encode('search'),
      total_bytes: 6,
      has_more: false,
    })),
    provenance: vi.fn(async () => ({
      source,
      path: file.path,
      coverage: 'unknown' as const,
      checks: [],
      risks: [],
      revisions: [],
      context: [],
    })),
  };
}
it('paginates exact source metadata without loading any file content or the graph', async () => {
  const r = reader(),
    session = createSourceReadSession(source, r);
  const page = await session.list(null);
  expect(page.items).toEqual([file]);
  expect(r.list).toHaveBeenCalledWith(source, null, 50);
  expect(r.read).not.toHaveBeenCalled();
  expect(r.provenance).not.toHaveBeenCalled();
});
it('refuses a later workspace version instead of mixing a proposed change set with other source', async () => {
  const r = reader();
  r.list = async () => ({
    source: { ...source, workspace_version: 5 },
    items: [file],
    next_cursor: null,
    has_more: false,
  });
  await expect(createSourceReadSession(source, r).list(null)).rejects.toThrow(
    /different source version/,
  );
  expect(sourceIdentity(source)).not.toBe(sourceIdentity({ ...source, epoch: 3 }));
});
it('rejects changed blobs, unexpected offsets and content beyond the requested bounded range', async () => {
  for (const patch of [{ blob_id: 'new-blob' }, { offset: 3 }, { bytes: new Uint8Array(65537) }]) {
    const r = reader(),
      read = r.read;
    r.read = async (...args) => ({ ...(await read(...args)), ...patch });
    await expect(createSourceReadSession(source, r).read(file, 0)).rejects.toThrow();
  }
});
it('keeps a selected old revision immutable even if the caller mutates its selection object', async () => {
  const mutable = structuredClone(source),
    r = reader(),
    session = createSourceReadSession(mutable, r);
  mutable.workspace_version = 99;
  await session.list(null);
  expect(r.list).toHaveBeenCalledWith(source, null, 50);
});
it('decodes split Unicode bytes without inventing replacement characters at a page boundary', () => {
  const bytes = new TextEncoder().encode('café');
  expect(decodePreview([bytes.slice(0, 4)], true)).toBe('caf');
  expect(decodePreview([bytes.slice(0, 4), bytes.slice(4)], false)).toBe('café');
});
it('rejects unsafe file paths and repeated or incomplete next-page cursors', async () => {
  const r = reader();
  r.list = async () => ({
    source,
    items: [{ ...file, path: '../private' }],
    next_cursor: null,
    has_more: false,
  });
  await expect(createSourceReadSession(source, r).list(null)).rejects.toThrow(/file list/);
  r.list = async () => ({ source, items: [file], next_cursor: 'same', has_more: true });
  await expect(createSourceReadSession(source, r).list('same')).rejects.toThrow(/page cursor/);
});
it('accepts the same exact Git base regardless of JSON key order', async () => {
  const r = reader();
  r.list = async () => ({
    source: { ...source, base: { commit: source.base.commit, repository: source.base.repository } },
    items: [file],
    next_cursor: null,
    has_more: false,
  });
  await expect(createSourceReadSession(source, r).list(null)).resolves.toMatchObject({
    items: [file],
  });
});
it('uses a valid positive native read limit for an empty file', async () => {
  const r = reader(),
    empty = { ...file, size_bytes: 0 };
  r.read = vi.fn(async () => ({
    source,
    path: empty.path,
    blob_id: empty.blob_id,
    file_version: 0,
    offset: 0,
    bytes: new Uint8Array(),
    total_bytes: 0,
    has_more: false,
  }));
  await createSourceReadSession(source, r).read(empty, 0);
  expect(r.read).toHaveBeenCalledWith(source, empty, 0, 1);
});

import { useEffect, useRef, useState } from 'react';
import type {
  SourceContextLink,
  SourceFileEntry,
  SourceSelection,
} from '../../lib/sourceWorkspace';
import { SourceFileTrail } from './SourceFileTrail';
import {
  type createSourceReadSession,
  decodePreview,
  SOURCE_PREVIEW_BYTES,
  SourceTextUnavailable,
} from './sourceReader';

export function SourceFilePreview({
  file,
  session,
  onInspectContext,
  onInspectRevision,
}: {
  file: SourceFileEntry;
  session: ReturnType<typeof createSourceReadSession>;
  onInspectContext?: (link: SourceContextLink) => void;
  onInspectRevision?: (source: SourceSelection) => void;
}) {
  const [chunks, setChunks] = useState<Uint8Array[]>([]),
    [more, setMore] = useState(file.size_bytes > 0);
  const [error, setError] = useState(false),
    [unavailable, setUnavailable] = useState(false),
    [busy, setBusy] = useState(false),
    [wrap, setWrap] = useState(true);
  const alive = useRef(true),
    pending = useRef(false);
  const offset = chunks.reduce((sum, bytes) => sum + bytes.length, 0);
  async function load() {
    if (pending.current || offset >= SOURCE_PREVIEW_BYTES) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await session.read(file, offset);
      const next = [...chunks, result.bytes];
      decodePreview(next, result.has_more);
      if (alive.current) {
        setChunks(next);
        setMore(result.has_more);
      }
    } catch (failure) {
      if (alive.current) {
        if (failure instanceof SourceTextUnavailable) setUnavailable(true);
        else setError(true);
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Parent keys this preview by exact source/file/blob identity.
  useEffect(() => {
    alive.current = true;
    if (file.encoding !== 'binary' && file.change !== 'delete' && file.size_bytes > 0) void load();
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <section className="source-file-preview" aria-label={`Read-only source: ${file.path}`}>
      <div className="source-file-heading">
        <h4>{file.path}</h4>
        <span>{file.size_bytes} bytes · read-only</span>
      </div>
      <p className="subtle">
        {file.change ? `${file.change} · ` : ''}Content identity <code>{file.blob_id}</code>
        {file.file_version != null && ` · file version ${file.file_version}`}
      </p>
      {file.change === 'delete' ? (
        <p>This change set deletes the file. Inspect an earlier recorded version in its history.</p>
      ) : file.encoding === 'binary' || unavailable ? (
        <p>
          Binary file. A text preview is unavailable; source metadata and recorded history remain
          accessible.
        </p>
      ) : (
        <>
          <label className="source-wrap">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(event) => setWrap(event.target.checked)}
            />
            Wrap long lines
          </label>
          {busy && <p role="status">Reading this source version…</p>}
          {error && (
            <p role="alert">
              Could not verify this file range. Retry this read or refresh the selected source
              version.{' '}
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void load()}
              >
                Retry file read
              </button>
            </p>
          )}
          <pre className={wrap ? 'source-text source-text-wrap' : 'source-text'}>
            {chunks.length
              ? decodePreview(chunks, more)
              : file.size_bytes === 0
                ? 'Empty file'
                : ''}
          </pre>
          {more && !error && (
            <p>
              {offset} of {file.size_bytes} bytes shown.{' '}
              {offset < SOURCE_PREVIEW_BYTES ? (
                <button type="button" className="quiet" disabled={busy} onClick={() => void load()}>
                  Read more of this file
                </button>
              ) : (
                'The text preview stops at 256 KiB; the full file remains in the recorded source.'
              )}
            </p>
          )}
        </>
      )}
      <SourceFileTrail
        session={session}
        path={file.path}
        onInspectContext={onInspectContext}
        onInspectRevision={onInspectRevision}
      />
    </section>
  );
}

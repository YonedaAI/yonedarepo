import { useEffect, useMemo, useState } from 'react';
import type {
  SourceContextLink,
  SourceFileEntry,
  SourceFilePage,
  SourceReader,
  SourceSelection,
} from '../../lib/sourceWorkspace';
import { SourceFilePreview } from './SourceFilePreview';
import { SourceVersionBadge } from './SourceVersionBadge';
import { SourceViewUnavailable } from './sourceApiReader';
import { createSourceReadSession, sourceIdentity } from './sourceReader';
import './source-workspace.css';

export function ReadOnlySourceViewer({
  selection,
  reader,
  initialOpen = false,
  onInspectContext,
  onInspectRevision,
  onRefreshSource,
}: {
  selection: SourceSelection;
  reader: SourceReader;
  initialOpen?: boolean;
  onInspectContext?: (link: SourceContextLink) => void;
  onInspectRevision?: (source: SourceSelection) => void;
  onRefreshSource?: () => void;
}) {
  const identity = sourceIdentity(selection);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Identity compares exact version fields, not parent object references.
  const session = useMemo(() => createSourceReadSession(selection, reader), [identity, reader]);
  const [open, setOpen] = useState(initialOpen),
    [retry, setRetry] = useState(0);
  const [paging, setPaging] = useState({ identity, cursors: [null] as (string | null)[] });
  const cursors = paging.identity === identity ? paging.cursors : [null];
  const cursor = cursors[cursors.length - 1];
  const [result, setResult] = useState<{
    identity: string;
    cursor: string | null;
    page?: SourceFilePage;
    error?: string;
    preparing?: boolean;
  }>();
  const [chosen, setChosen] = useState<{ identity: string; file: SourceFileEntry }>();
  const current = result?.identity === identity && result.cursor === cursor ? result : undefined;
  const file = chosen?.identity === identity ? chosen.file : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry restarts a bounded metadata GET for this exact cursor.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setResult(undefined);
    void session
      .list(cursor)
      .then((page) => {
        if (active) setResult({ identity, cursor, page });
      })
      .catch((failure: unknown) => {
        if (active)
          setResult({
            identity,
            cursor,
            preparing: failure instanceof SourceViewUnavailable && failure.reason === 'preparing',
            error:
              failure instanceof SourceViewUnavailable
                ? failure.message
                : 'Could not load this source version. No files were shown.',
          });
      });
    return () => {
      active = false;
    };
  }, [open, session, identity, cursor, retry]);
  const page = current?.page;
  return (
    <section className="source-workspace-viewer" aria-label="Read-only source workspace">
      <SourceVersionBadge source={selection} />
      <button
        type="button"
        className="quiet"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Close source files' : 'Read source files'}
      </button>
      {open && (
        <>
          <p className="subtle">
            Inspect exact source without editing it. File history and context are loaded only when
            opened.
          </p>
          <div className="source-browser-layout">
            <nav className="source-file-list" aria-label="Source files">
              {current?.error ? (
                <p role="alert">
                  {current.error}{' '}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      if (onRefreshSource) onRefreshSource();
                      setRetry((value) => value + 1);
                    }}
                  >
                    {current.preparing
                      ? 'Refresh files'
                      : onRefreshSource
                        ? 'Refresh source version'
                        : 'Retry files'}
                  </button>
                </p>
              ) : !page ? (
                <p role="status">Loading source file names…</p>
              ) : page.items.length ? (
                page.items.map((entry) => (
                  <button
                    type="button"
                    key={entry.path}
                    aria-current={file?.path === entry.path ? 'true' : undefined}
                    onClick={() => setChosen({ identity, file: entry })}
                  >
                    <span>{entry.path}</span>
                    <small>
                      {entry.change ?? 'source file'} · {entry.size_bytes} bytes
                    </small>
                  </button>
                ))
              ) : (
                <p>No files are recorded on this page.</p>
              )}
              <div className="source-file-pages">
                <button
                  type="button"
                  className="quiet"
                  disabled={!page || cursors.length === 1}
                  onClick={() => setPaging({ identity, cursors: cursors.slice(0, -1) })}
                >
                  Previous files
                </button>
                <span>Page {cursors.length} · up to 50 files</span>
                <button
                  type="button"
                  className="quiet"
                  disabled={!page?.has_more}
                  onClick={() => {
                    if (page?.next_cursor)
                      setPaging({ identity, cursors: [...cursors, page.next_cursor] });
                  }}
                >
                  Next files
                </button>
              </div>
            </nav>
            {file ? (
              <SourceFilePreview
                key={`${identity}:${file.path}:${file.blob_id}`}
                file={file}
                session={session}
                onInspectContext={onInspectContext}
                onInspectRevision={onInspectRevision}
              />
            ) : (
              <p className="source-file-empty">Choose a file to read its exact content.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

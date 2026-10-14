import { useEffect, useState } from 'react';
import type { SourcePathListRef } from '../../lib/sourceWorkspace';
import { type ChangedPathPage, createChangedPathReader } from './changedPathReader';

const read = createChangedPathReader();
/** Collapsed metadata only. The actual patch and source bytes stay in their separate existing viewers. */
export function ChangedPathList({
  repo,
  candidateId,
  pathRef,
}: {
  repo: string;
  candidateId: string;
  pathRef: SourcePathListRef;
}) {
  const [open, setOpen] = useState(false),
    [retry, setRetry] = useState(0),
    [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [result, setResult] = useState<{ page?: ChangedPathPage; error?: boolean }>();
  const cursor = cursors.at(-1) ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Immutable ref fields pin metadata; retry explicitly reloads the same page.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setResult(undefined);
    void read(repo, candidateId, pathRef, cursor)
      .then((page) => {
        if (current) setResult({ page });
      })
      .catch(() => {
        if (current) setResult({ error: true });
      });
    return () => {
      current = false;
    };
  }, [repo, candidateId, pathRef.id, pathRef.digest, pathRef.count, cursor, open, retry]);
  const page = result?.page;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="changed-path-list"
    >
      <summary>Changed paths ({pathRef.count})</summary>
      {open &&
        (result?.error ? (
          <p role="alert">
            Could not verify this changed-path page. Refresh the result or retry this read.{' '}
            <button type="button" className="text-button" onClick={() => setRetry((n) => n + 1)}>
              Retry changed paths
            </button>
          </p>
        ) : !page ? (
          <p role="status">Loading recorded changed paths…</p>
        ) : (
          <>
            <p>
              Recorded changes only; select a source file below to read its content, or open Review
              changes for the captured patch.
            </p>
            {page.items.length ? (
              <ul>
                {page.items.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No changed paths are recorded on this page.</p>
            )}
            <div className="source-file-pages">
              <button
                type="button"
                className="quiet"
                disabled={cursors.length === 1}
                onClick={() => setCursors((value) => value.slice(0, -1))}
              >
                Previous changed paths
              </button>
              <span>Page {cursors.length} · up to 50 paths</span>
              <button
                type="button"
                className="quiet"
                disabled={!page.has_more}
                onClick={() => {
                  if (page.next_cursor) setCursors((value) => [...value, page.next_cursor]);
                }}
              >
                Next changed paths
              </button>
            </div>
          </>
        ))}
    </details>
  );
}

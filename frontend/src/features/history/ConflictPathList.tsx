import { useEffect, useState } from 'react';
import {
  type ChangedPathPage,
  createChangedPathReader,
} from '../source-workspace/changedPathReader';
import { createConflictPathReader } from './conflictPathReader';
import type { ConflictPathSection, ConflictPathSet } from './conflictPaths';

export type ConflictPathTarget =
  | { kind: 'conflict'; id: string; section: ConflictPathSection }
  | { kind: 'candidate'; id: string };
const readConflict = createConflictPathReader(),
  readCandidate = createChangedPathReader();
export function ConflictPathList({
  repo,
  label,
  paths,
  target,
}: {
  repo: string;
  label: string;
  paths: ConflictPathSet;
  target?: ConflictPathTarget;
}) {
  const [open, setOpen] = useState(false),
    [retry, setRetry] = useState(0),
    [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [result, setResult] = useState<{ page?: ChangedPathPage; error?: boolean }>();
  const cursor = cursors.at(-1) ?? null,
    ref = paths.state === 'paged' ? paths.reference : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Identity fields pin read-only pages; retry re-reads this exact cursor.
  useEffect(() => {
    if (!open || !ref || !target) return;
    let current = true;
    setResult(undefined);
    const read =
      target.kind === 'conflict'
        ? readConflict(repo, target.id, target.section, ref, cursor)
        : readCandidate(repo, target.id, ref, cursor);
    void read
      .then((page) => {
        if (current) setResult({ page });
      })
      .catch(() => {
        if (current) setResult({ error: true });
      });
    return () => {
      current = false;
    };
  }, [
    repo,
    target?.kind,
    target?.id,
    target?.kind === 'conflict' ? target.section : null,
    ref?.id,
    ref?.digest,
    ref?.count,
    cursor,
    open,
    retry,
  ]);
  const page = result?.page;
  const items = paths.state === 'inline' ? paths.items : page?.items;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="conflict-path-list"
    >
      <summary>
        {label} ({paths.state === 'unknown' ? 'count unavailable' : paths.count})
      </summary>
      {paths.state === 'unknown' ? (
        <p>
          Path evidence is unavailable for this section; absence does not establish an empty scope
          or no overlap.
        </p>
      ) : paths.state === 'paged' && !target ? (
        <p>
          The recorded path count is retained, but a reader for this row is unavailable. Refresh
          conflict status.
        </p>
      ) : paths.state === 'paged' && open && !page ? (
        result?.error ? (
          <p role="alert">
            The recorded path list is unavailable or changed. Refresh conflict status or{' '}
            <button type="button" className="text-button" onClick={() => setRetry((n) => n + 1)}>
              Retry path read
            </button>
            .
          </p>
        ) : (
          <p role="status">Loading recorded paths…</p>
        )
      ) : items ? (
        <>
          <ul style={{ maxHeight: 360, overflow: 'auto' }}>
            {items.map((item) => (
              <li key={item}>
                <code style={{ overflowWrap: 'anywhere' }}>{item}</code>
              </li>
            ))}
          </ul>
          {!items.length && <p>No paths were recorded for this section.</p>}
        </>
      ) : null}
      {paths.state === 'paged' && page && (
        <div className="source-file-pages">
          <button
            type="button"
            className="quiet"
            disabled={cursors.length === 1}
            onClick={() => setCursors((value) => value.slice(0, -1))}
          >
            Previous paths
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
            Next paths
          </button>
        </div>
      )}
    </details>
  );
}

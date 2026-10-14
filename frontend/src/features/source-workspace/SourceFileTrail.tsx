import { useEffect, useState } from 'react';
import type {
  SourceContextLink,
  SourceSelection,
  SourceFileTrail as Trail,
} from '../../lib/sourceWorkspace';
import { SourceTrailDetails } from './SourceTrailDetails';
import type { createSourceReadSession } from './sourceReader';

export function SourceFileTrail({
  session,
  path,
  onInspectContext,
  onInspectRevision,
}: {
  session: ReturnType<typeof createSourceReadSession>;
  path: string;
  onInspectContext?: (link: SourceContextLink) => void;
  onInspectRevision?: (source: SourceSelection) => void;
}) {
  const [open, setOpen] = useState(false),
    [trail, setTrail] = useState<Trail>(),
    [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the same immutable selection.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(false);
    void session
      .provenance(path)
      .then((value) => {
        if (current) setTrail(value);
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
    };
  }, [open, session, path, retry]);
  return (
    <details
      className="source-file-trail"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Why this file changed · checks, risks and prior context</summary>
      {error ? (
        <p role="alert">
          Could not read this file’s recorded history.{' '}
          <button type="button" className="text-button" onClick={() => setRetry((n) => n + 1)}>
            Retry history
          </button>
        </p>
      ) : !trail ? (
        <p role="status">Loading file history…</p>
      ) : (
        <SourceTrailDetails
          trail={trail}
          onInspectContext={onInspectContext}
          onInspectRevision={onInspectRevision}
        />
      )}
    </details>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { GraphNode } from '../../lib/types';
import { ContextRecordBody } from './ContextRecordBody';
import { contextRecord } from './frozenContextView';

/** Lazy owner read; a linked record is current evidence, never substituted for frozen input. */
export function LinkedContextRecord({
  repo,
  id,
  label,
}: {
  repo: string;
  id: string;
  label: string;
}) {
  const [opened, setOpened] = useState(false);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; record?: GraphNode; error?: string } | null>(
    null,
  );
  const path = `repos/${encodeURIComponent(repo)}/context_get?id=${encodeURIComponent(id)}`;
  const requestKey = `${path}:${retry}`;
  useEffect(() => {
    if (!opened) return;
    let current = true;
    setResult(null);
    void api<unknown>(path)
      .then((value) => {
        const record = contextRecord(value);
        if (!record || record.id !== id)
          throw new Error('The linked context response did not match this record.');
        if (current) setResult({ key: requestKey, record });
      })
      .catch((error: Error) => {
        if (current) setResult({ key: requestKey, error: error.message });
      });
    return () => {
      current = false;
    };
  }, [opened, path, id, requestKey]);
  const value = result?.key === requestKey ? result : null;
  return (
    <details
      className="prior-context-linked"
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      <summary>Read linked record: {label || id}</summary>
      {opened && (
        <div>
          <p className="context-usage-note">
            Current linked record; its inclusion in the agent’s frozen input is unrecorded here.
          </p>
          {value?.error ? (
            <p role="alert">
              Could not load linked context: {value.error}{' '}
              <button
                type="button"
                className="text-button"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry
              </button>
            </p>
          ) : value?.record ? (
            <ContextRecordBody record={value.record} />
          ) : (
            <p role="status">Loading linked statement…</p>
          )}
        </div>
      )}
    </details>
  );
}

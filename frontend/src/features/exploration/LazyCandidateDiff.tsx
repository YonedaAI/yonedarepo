import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { SourceDiff } from './SourceDiff';

export function LazyCandidateDiff({
  repo,
  candidate,
}: {
  repo: string;
  candidate: Record<string, any>;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(
    typeof candidate.diff === 'string' ? candidate.diff : null,
  );
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry restarts a failed read without changing the captured identity.
  useEffect(() => {
    if (!open || diff !== null) return;
    let current = true;
    setError('');
    void api<Record<string, any>>(
      `repos/${repo}/candidate?${new URLSearchParams({ id: candidate.id })}`,
    )
      .then((result) => {
        if (!result || result.id !== candidate.id || typeof result.diff !== 'string')
          throw new Error('The captured diff could not be verified.');
        if (current) setDiff(result.diff);
      })
      .catch((reason: unknown) => {
        if (current) setError((reason as Error).message);
      });
    return () => {
      current = false;
    };
  }, [open, diff, retry, repo, candidate.id]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Review changes</summary>
      {diff !== null ? (
        <SourceDiff diff={diff} />
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry diff
          </button>
        </div>
      ) : (
        <p role="status">Loading captured diff…</p>
      )}
    </details>
  );
}

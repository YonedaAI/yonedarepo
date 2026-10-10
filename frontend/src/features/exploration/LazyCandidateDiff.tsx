import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { CandidateSourcePreview } from './CandidateSourcePreview';
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
  const patchRecorded =
    diff?.split(/\r?\n/).some((line) => line.startsWith('diff --git ')) ?? false;
  return (
    <>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{patchRecorded || diff === null ? 'Review changes' : 'Change summary'}</summary>
        {diff !== null && !patchRecorded ? (
          <>
            <p>
              This historical capture records change statistics only; the patch was not recorded.
            </p>
            <pre>{diff || 'No change summary was recorded.'}</pre>
          </>
        ) : diff !== null ? (
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
      <CandidateSourcePreview repo={repo} candidate={candidate} />
    </>
  );
}
